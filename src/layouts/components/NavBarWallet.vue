<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useBaseStore, useBlockchain, useWalletStore } from '@/stores';
import { Icon } from '@iconify/vue';
import { ref, computed } from 'vue';
import ConnectWallet from '@/components/ConnectWallet.vue';

const route = useRoute();
const walletStore = useWalletStore();
const chainStore = useBlockchain();
const baseStore = useBaseStore();
const connectWalletRef = ref<InstanceType<typeof ConnectWallet> | null>(null);
// walletStore.$subscribe((m, s) => {
//   console.log(m, s);
// });
async function walletStateChange(res: any) {
  await walletStore.setConnectedWallet(res.detail?.value);
}
let showCopyToast = ref(0);
async function copyAdress(address: string) {
  // Add validation for the address
  if (!address || address.trim() === '') {
    showCopyToast.value = 2;
    setTimeout(() => {
      showCopyToast.value = 0;
    }, 1000);
    console.error('Cannot copy empty address');
    return;
  }

  try {
    // Check if clipboard API is available
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(address);
    } else {
      // Fallback for non-secure contexts or unsupported browsers
      const textArea = document.createElement('textarea');
      textArea.value = address;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      
      if (!successful) {
        throw new Error('Fallback copy method failed');
      }
    }
    
    showCopyToast.value = 1;
    setTimeout(() => {
      showCopyToast.value = 0;
    }, 1000);
  } catch (err) {
    console.error('Copy failed:', err);
    showCopyToast.value = 2;
    setTimeout(() => {
      showCopyToast.value = 0;
    }, 1000);
  }
}
const tipMsg = computed(() => {
  return showCopyToast.value === 2
    ? { class: 'error', msg: 'Copy Error!' }
    : { class: 'success', msg: 'Copy Success!' };
});

function openConnectWallet() {
  connectWalletRef.value?.openModal();
}

</script>

<template>
  <div class="dropdown dropdown-hover dropdown-end">
    <label tabindex="0" class="btn btn-sm btn-primary m-1 lowercase truncate !inline-flex text-xs md:!text-sm">
      <Icon icon="mdi:wallet" />
      <template v-if="walletStore?.currentAddress">
        <span class="ml-1 hidden md:block">
          {{ walletStore.shortAddress }}
        </span>
      </template>
    </label>
    <div tabindex="0" class="dropdown-content menu shadow p-2 bg-base-100 rounded w-52 md:!w-64 overflow-auto">
      <button v-if="!walletStore?.currentAddress" @click="openConnectWallet" class="btn btn-sm btn-primary">
        <Icon icon="mdi:wallet" /><span class="ml-1 block">Connect Wallet</span>
      </button>
      <div class="px-2 mb-1 text-gray-500 dark:text-gray-400 font-semibold">
        {{ walletStore.connectedWallet?.wallet }}
      </div>
      <div>
        <a v-if="walletStore.currentAddress && walletStore.currentAddress.trim() !== ''"
          class="block py-2 px-2 hover:bg-gray-100 dark:hover:bg-[#353f5a] rounded cursor-pointer"
          style="overflow-wrap: anywhere" @click="copyAdress(walletStore.currentAddress)">
          {{ walletStore.currentAddress }}
        </a>
        <div v-else-if="walletStore?.currentAddress === ''" class="block py-2 px-2 text-gray-400 text-sm">
          Address not available
        </div>
        <div class="divider mt-1 mb-1"></div>
        <RouterLink to="/wallet/accounts">
          <div class="block py-2 px-2 hover:!bg-gray-100 rounded cursor-pointer">Accounts</div>
        </RouterLink>
        <RouterLink to="/wallet/portfolio">
          <div class="block py-2 px-2 hover:!bg-gray-100 rounded cursor-pointer">Portfolio</div>
        </RouterLink>
        <div v-if="walletStore.currentAddress" class="divider mt-1 mb-1"></div>
        <a v-if="walletStore.currentAddress"
          class="block py-2 px-2 hover:bg-gray-100 dark:hover:bg-[#353f5a] rounded cursor-pointer"
          @click="walletStore.disconnect()">Disconnect</a>
      </div>
    </div>
    <div class="toast" v-show="showCopyToast === 1">
      <div class="alert alert-success">
        <div class="text-xs md:!text-sm">
          <span>{{ tipMsg.msg }}</span>
        </div>
      </div>
    </div>
    <div class="toast" v-show="showCopyToast === 2">
      <div class="alert alert-error">
        <div class="text-xs md:!text-sm">
          <span>{{ tipMsg.msg }}</span>
        </div>
      </div>
    </div>
  </div>
  <Teleport to="body">
    <ConnectWallet 
      ref="connectWalletRef"
      :chain-id="chainStore.current?.chainId || baseStore.currentChainId || chainStore.chainName || 'gonka'" 
      :hd-path="chainStore.defaultHDPath"
      :addr-prefix="chainStore.current?.bech32Prefix || 'cosmos'" 
      @connect="walletStateChange"
      @keplr-config="walletStore.suggestChain()"
    />
  </Teleport>
</template>

