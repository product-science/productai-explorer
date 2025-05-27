<script setup lang="ts">
import { ref } from 'vue';
import { useDashboard, type ChainConfig, useBlockchain } from '@/stores';
import { CosmosRestClient } from '@/libs/client';
import { onMounted } from 'vue';
import AdBanner from '@/components/ad/AdBanner.vue';

const error = ref("")
const conf = ref("")
const dashboard = useDashboard()
const selected = ref({} as ChainConfig)

onMounted(() => {
    const chainStore = useBlockchain()
    selected.value = chainStore.current || Object.values(dashboard.chains)[0]
    initParamsForLeap()
})

async function initParamsForLeap() {
    const chain = selected.value
    if(!chain.endpoints?.rest?.at(0)) throw new Error("Endpoint does not set");
    const client = CosmosRestClient.newDefault(chain.endpoints.rest?.at(0)?.address || "")
    const b = await client.getBaseBlockLatest()   
    const chainid = b.block.header.chain_id

    const gasPriceStep = chain.keplrPriceStep || {
        low: 0.01,
        average: 0.025,
        high: 0.03,
    }
    const coinDecimals = chain.assets[0].denom_units.find(x => x.denom === chain.assets[0].symbol.toLowerCase())?.exponent || 6
    
    // Leap wallet uses a slightly different format for chain configuration
    conf.value = JSON.stringify({
        chainId: chainid,
        chainName: chain.chainName,
        rpc: chain.endpoints?.rpc?.at(0)?.address,
        rest: chain.endpoints?.rest?.at(0)?.address,
        bip44: {
            coinType: Number(chain.coinType),
        },
        bech32Config: {
            bech32PrefixAccAddr: chain.bech32Prefix,
            bech32PrefixAccPub: `${chain.bech32Prefix}pub`,
            bech32PrefixValAddr: `${chain.bech32Prefix}valoper`,
            bech32PrefixValPub: `${chain.bech32Prefix}valoperpub`,
            bech32PrefixConsAddr: `${chain.bech32Prefix}valcons`,
            bech32PrefixConsPub: `${chain.bech32Prefix}valconspub`,
        },
        currencies: [
            {
                coinDenom: chain.assets[0].symbol,
                coinMinimalDenom: chain.assets[0].base,
                coinDecimals,
                coinGeckoId: chain.assets[0].coingecko_id || 'unknown',
            },
        ],
        feeCurrencies: [
            {
                coinDenom: chain.assets[0].symbol,
                coinMinimalDenom: chain.assets[0].base,
                coinDecimals,
                coinGeckoId: chain.assets[0].coingecko_id || 'unknown',
                gasPriceStep,
            },
        ],
        stakeCurrency: {
            coinDenom: chain.assets[0].symbol,
            coinMinimalDenom: chain.assets[0].base,
            coinDecimals,
            coinGeckoId: chain.assets[0].coingecko_id || 'unknown',
        },
        features: chain.keplrFeatures || [],
        // Leap specific fields
        image: chain.image || '',
        theme: {
            primaryColor: chain.theme?.primaryColor || '#1D1D1D',
            gradient: chain.theme?.gradient || 'linear-gradient(180deg, #1D1D1D 0%, #1D1D1D 100%)',
        },
    }, null, '\t')
}

function suggest() {
    console.log('Suggest button clicked');
    console.log('Leap available:', !!window.leap);
    console.log('Configuration:', conf.value);
    
    if (!window.leap) {
        error.value = "Leap wallet extension not found. Please install Leap wallet.";
        console.error("Leap wallet extension not found");
        return;
    }

    try {
        const chainConfig = JSON.parse(conf.value);
        console.log('Parsed chain config:', chainConfig);
        
        // @ts-ignore
        window.leap.experimentalSuggestChain(chainConfig)
            .then(() => {
                console.log('Chain suggestion successful');
                error.value = ""; // Clear any previous errors
            })
            .catch(e => {
                console.error('Leap suggestion error:', e);
                error.value = e.message || 'Failed to suggest chain to Leap';
            });
    } catch (e) {
        console.error('JSON parse error:', e);
        error.value = 'Invalid chain configuration: ' + (e.message || 'Unknown error');
    }
}
</script>

<template>
    <div class="bg-base-100 p-4 rounded text-center">
        <AdBanner id="leap-banner-ad" unit="banner" width="970px" height="90px" />
        <div class="flex">
            <select v-model="selected" class="select select-bordered mx-5" @change="initParamsForLeap">
                <option v-for="c in dashboard.chains" :value="c">
                    {{ c.chainName }}
                </option>
            </select>
            <button class="btn !bg-yes !border-yes text-white px-10" @click="suggest">Add {{ selected.chainName }} TO Leap Wallet</button>
        </div>
        <div v-if="error" class="text-red-500 mt-2">
            {{ error }}
        </div>
        <div class="text-main mt-5">
            <textarea v-model="conf" class="textarea textarea-bordered w-full" rows="15"></textarea>
        </div>
        <div class="mt-4 mb-4">
            If the chain is not officially supported on Leap, you can submit these parameters to enable Leap.
        </div>
    </div>
</template> 