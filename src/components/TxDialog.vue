<script lang="ts" setup>
import { computed } from 'vue';
import { useTxDialog, useBlockchain, useWalletStore } from '@/stores';
const store = useTxDialog();
const chainStore = useBlockchain();
const walletStore = useWalletStore();

// Always read live from wallet store so the dialog never gets a stale empty string
// even if hydrateWallet() runs slightly after the dialog is opened.
const sender = computed(() => walletStore.currentAddress || store.sender);
</script>
<template>
  <ping-tx-dialog
    :type="store.type"
    :sender="sender"
    :endpoint="store.endpoint"
    :params='store.params'
    :hd-path="store.hdPaths"
    :registry-name="chainStore.current?.prettyName || chainStore.chainName"
    @view="store.view"
    @confirmed="store.confirmed"
  ></ping-tx-dialog>
</template>
