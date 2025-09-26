import { defineStore } from 'pinia';
import {
  useDashboard,
  type ChainConfig,
  type Endpoint,
  EndpointType,
  LoadingStatus,
} from './useDashboard';
import type {
  NavGroup,
  NavLink,
  NavSectionTitle,
  VerticalNavItems,
} from '@/layouts/types';
import { useRouter } from 'vue-router';
import { CosmosRestClient } from '@/libs/client';
import { post, get } from '@/libs/http';
import {
  useBankStore,
  useBaseStore,
  useDistributionStore,
  useGovStore,
  useMintStore,
  useStakingStore,
  useWalletStore
} from '.';
import { useBlockModule } from '@/modules/[chain]/block/block';
import { DEFAULT } from '@/libs';
import { hexToRgb, rgbToHsl } from '@/libs/utils';

export const useBlockchain = defineStore('blockchain', {
  state: () => {
    return {
      status: {} as Record<string, string>,
      rest: '',
      chainName: '',
      endpoint: {} as {
        type?: EndpointType;
        address: string;
        provider: string;
      },
      // Initialization guards
      isInitializing: false as boolean,
      lastInitializedChain: '' as string,
      lastInitializedEndpoint: '' as string,
      inferenceApiEndpoint: '' as string,
      connErr: '',
      // Next PoC state
      currentEpochIndex: null as number | null,
      currentPocStart: null as number | null,
      nextPocStart: null as number | null,
      epochLength: null as number | null,
    };
  },
  getters: {
    current(): ChainConfig | undefined {
      const chain = this.dashboard.chains[this.chainName]
      // update chain config with dynamic updated sdk version
      const sdkversion = localStorage.getItem(`sdk_version_${this.chainName}`)
      if(sdkversion && chain?.versions) {
        chain.versions.cosmosSdk = sdkversion;
      }
      return chain;
    },
    logo(): string {
      return this.current?.logo || '';
    },
    defaultHDPath(): string {
      const cointype = this.current?.coinType || '118';
      return `m/44'/${cointype}/0'/0/0`;
    },
    dashboard() {
      return useDashboard();
    },
    isConsumerChain() {
      // @ts-ignore
      return this.current && this.current.providerChain;
    },
    computedChainMenu() {
      let currNavItem: VerticalNavItems = [];
      const router = useRouter();
      const routes = router?.getRoutes() || [];

      console.log(this.current, routes);

      if (this.current && routes) {
        if (this.current?.themeColor) {
          const { color } = hexToRgb(this.current?.themeColor);
          const { h, s, l } = rgbToHsl(color);
          const themeColor = h + ' ' + s + '% ' + l +'%';
          document.body.style.setProperty('--p', `${themeColor}`);
          // document.body.style.setProperty('--p', `${this.current?.themeColor}`);
        } else {
          document.body.style.setProperty('--p', '237.65 100% 70%');
        }
        currNavItem = [
          {
            title: this.current?.prettyName || this.chainName || '',
            icon: { image: this.current.logo, size: '22' },
            i18n: false,
            badgeContent: this.isConsumerChain ? 'Consumer' : undefined,
            badgeClass: 'bg-error',
            children: routes
              .filter((x) => x.meta.i18n) // defined menu name
              .filter(
                (x) =>
                  !this.current?.features ||
                  this.current.features.includes(String(x.meta.i18n))
              ) // filter none-custom module
              .map((x) => ({
                title: `module.${x.meta.i18n}`,
                to: { path: x.path.replace(':chain', this.chainName) },
                icon: { icon: 'mdi-chevron-right', size: '22' },
                i18n: true,
                order: Number(x.meta.order || 100),
              }))
              .sort((a, b) => a.order - b.order),
          },
        ];
      }
      // compute favorite menu
      const favNavItems: VerticalNavItems = [];
      Object.keys(this.dashboard.favoriteMap).forEach((name) => {
        const ch = this.dashboard.chains[name];
        if (ch && this.dashboard.favoriteMap?.[name]) {
          favNavItems.push({
            title: ch.prettyName || ch.chainName || name,
            to: { path: `/${ch.chainName || name}` },
            icon: { image: ch.logo, size: '22' },
          });
        }
      });

      // combine all together
      const menuItems: VerticalNavItems = [...currNavItem];
      
      // Only add ecosystem section if there is more than one chain
      if (this.dashboard.length > 1) {
        menuItems.push(
          { heading: 'Ecosystem' } as NavSectionTitle,
          {
            title: 'Favorite',
            children: favNavItems,
            badgeContent: favNavItems.length,
            badgeClass: 'bg-primary',
            i18n: true,
            icon: { icon: 'mdi-star', size: '22' },
          } as NavGroup,
          {
            title: 'All Blockchains',
            to: { path: '/' },
            badgeContent: this.dashboard.length,
            badgeClass: 'bg-primary',
            i18n: true,
            icon: { icon: 'mdi-grid', size: '22' },
          } as NavLink
        );
      }

      return menuItems;
    },
  },
  actions: {
    async initial(force = false) {
      if (this.isInitializing) return;
      const currentEndpoint = this.endpoint?.address || '';
      if (!force && this.lastInitializedChain === this.chainName && this.lastInitializedEndpoint === currentEndpoint) {
        return;
      }
      this.isInitializing = true;
      // this.current?.themeColor {
      //     const { global } = useTheme();
      //     global.current
      // }
      useWalletStore().$reset();
      if (!this.isConsumerChain) {
        await useStakingStore().init();
      }
      useBankStore().initial();
      useBaseStore().initial();
      // Avoid resetting gov data if already loading/loaded for this chain
      const gov = useGovStore();
      const govLoading = gov.loading?.['2'];
      if (govLoading === LoadingStatus.Loaded || govLoading === LoadingStatus.Loading) {
        // Optional: refresh params only
        try { await gov.fetchParams(); } catch {}
      } else {
        useGovStore().initial();
      }
      useMintStore().initial();
      useBlockModule().initial();
      useDistributionStore().initial();
      this.lastInitializedChain = this.chainName;
      this.lastInitializedEndpoint = currentEndpoint;
      this.isInitializing = false;
    },

    randomEndpoint(chainName: string) : Endpoint | undefined {
      const end = localStorage.getItem(`endpoint-${chainName}`);
      if (end) {
        return JSON.parse(end);
      } else {
        const all = this.current?.endpoints?.rest;
        if (all) {
          const rn = Math.random();
          const endpoint = all[Math.floor(rn * all.length)];
          return endpoint
        }
      }
    },

    async randomSetupEndpoint() {
      const endpoint = this.randomEndpoint(this.chainName)
      if(endpoint) await this.setRestEndpoint(endpoint);
    },

    async setRestEndpoint(endpoint: Endpoint) {
      this.connErr = '';
      this.endpoint = endpoint;
      this.rpc = CosmosRestClient.newStrategy(endpoint.address, this.current);
      localStorage.setItem(
        `endpoint-${this.chainName}`,
        JSON.stringify(endpoint)
      );
      
      // Setup inference API endpoint if available
      this.setupInferenceApi();
    },

    setupInferenceApi() {
      const inferenceEndpoints = this.current?.inference_api;
      if (inferenceEndpoints && inferenceEndpoints.length > 0) {
        // Use the first available inference API endpoint
        this.inferenceApiEndpoint = inferenceEndpoints[0].address;
        localStorage.setItem(
          `inference-endpoint-${this.chainName}`,
          this.inferenceApiEndpoint
        );
      } else {
        // Fallback to stored endpoint if available
        const stored = localStorage.getItem(`inference-endpoint-${this.chainName}`);
        if (stored) {
          this.inferenceApiEndpoint = stored;
        }
      }
    },

    async submitNewUnfundedParticipant(data: {
      address: string;
      url?: string;
      validator_key?: string;
      pub_key: string;
      worker_key?: string;
    }) {
      if (!this.inferenceApiEndpoint) {
        throw new Error('Inference API endpoint not configured');
      }
      
      const url = `${this.inferenceApiEndpoint}/v1/participants`;
      return await post(url, data);
    },

    async getParticipants() {
      if (!this.inferenceApiEndpoint) {
        throw new Error('Inference API endpoint not configured');
      }
      
      const url = `${this.inferenceApiEndpoint}/v1/participants`;
      return await get(url);
    },

    async getCurrentEpochParticipants() {
      if (!this.inferenceApiEndpoint) {
        throw new Error('Inference API endpoint not configured');
      }
      return await this.inferenceApiRequest('/v1/epochs/current/participants');
    },

    async getParticipant(address: string) {
      if (!this.inferenceApiEndpoint) {
        throw new Error('Inference API endpoint not configured');
      }
      
      const url = `${this.inferenceApiEndpoint}/v1/participants/${address}`;
      return await get(url);
    },

    async inferenceApiRequest(endpoint: string, method: 'GET' | 'POST' = 'GET', data?: any) {
      if (!this.inferenceApiEndpoint) {
        throw new Error('Inference API endpoint not configured');
      }
      
      const url = `${this.inferenceApiEndpoint}${endpoint}`;
      
      if (method === 'POST') {
        return await post(url, data);
      } else {
        return await get(url);
      }
    },

    // Liquidity Pool API methods
    async getLiquidityPoolInfo() {
      if (!this.endpoint.address) {
        throw new Error('Chain API endpoint not configured');
      }
      
      const url = `${this.endpoint.address}/productscience/inference/inference/liquidity_pool`;
      return await get(url);
    },

    async getApprovedTokensForTrade() {
      if (!this.endpoint.address) {
        throw new Error('Chain API endpoint not configured');
      }

      const url = `${this.endpoint.address}/productscience/inference/inference/approved_tokens_for_trade`;
      return await get(url);
    },

    async getWrappedTokenBalances(address: string) {
      if (!this.endpoint.address) {
        throw new Error('Chain API endpoint not configured');
      }
      
      const url = `${this.endpoint.address}/productscience/inference/inference/wrapped_token_balances/${address}`;
      return await get(url);
    },

    // Stream Vesting API
    async getTotalVesting(address: string) {
      if (!this.endpoint.address) {
        throw new Error('Chain API endpoint not configured');
      }

      const url = `${this.endpoint.address}/productscience/inference/streamvesting/total_vesting/${address}`;
      return await get(url);
    },

    async calculateTokensFromWrappedToken(poolAddress: string, usdAmount: string) {
      if (!this.endpoint.address) {
        throw new Error('Chain API endpoint not configured');
      }
      
      const query = JSON.stringify({ calculate_tokens: { usd_amount: usdAmount } });
      const encodedQuery = btoa(query);
      const url = `${this.endpoint.address}/cosmwasm/wasm/v1/contract/${poolAddress}/smart/${encodedQuery}`;
      
      return await get(url);
    },

    async getCw20TokenInfo(contractAddress: string) {
      if (!this.endpoint.address) {
        throw new Error('Chain API endpoint not configured');
      }

      const query = JSON.stringify({ token_info: {} });
      const encodedQuery = btoa(query);
      const url = `${this.endpoint.address}/cosmwasm/wasm/v1/contract/${contractAddress}/smart/${encodedQuery}`;
      return await get(url);
    },

    // Fetch latest epoch info for Next PoC widget
    async fetchLatestEpochInfo() {
      try {
        // Use inference API if configured
        if (this.inferenceApiEndpoint) {
          const data = await this.inferenceApiRequest('/v1/epochs/latest');
          const currIdx = Number(data?.latest_epoch?.index || data?.epoch_stages?.epoch_index || 0);
          this.currentEpochIndex = isFinite(currIdx) && currIdx > 0 ? currIdx : null;
          const currPocStart = Number(data?.latest_epoch?.poc_start_block_height || data?.epoch_stages?.poc_start || 0);
          this.currentPocStart = isFinite(currPocStart) && currPocStart > 0 ? currPocStart : null;
          const start = Number(data?.next_epoch_stages?.poc_start || 0);
          this.nextPocStart = isFinite(start) && start > 0 ? start : null;
          const len = Number(data?.epoch_params?.epoch_length || 0);
          this.epochLength = isFinite(len) && len > 0 ? len : null;
        } else {
          this.currentEpochIndex = null;
          this.currentPocStart = null;
          this.nextPocStart = null;
          this.epochLength = null;
        }
      } catch (e) {
        this.currentEpochIndex = null;
        this.currentPocStart = null;
        this.nextPocStart = null;
        this.epochLength = null;
      }
    },
    async setCurrent(name: string) {
      // Ensure chains are loaded due to asynchronous calls.
      if(this.dashboard.length === 0) {
        await this.dashboard.initial();
      }

      // Find the case-sensitive name for the chainName, else simply use the parameter-value.
      const caseSensitiveName = 
        Object.keys(this.dashboard.chains).find((x) => x.toLowerCase() === name.toLowerCase()) 
        || name;

      // Update chainName if needed
      if (caseSensitiveName !== this.chainName) {
        this.chainName = caseSensitiveName;
        // Setup inference API when chain changes
        this.setupInferenceApi();
      }
    },
    supportModule(mod: string) {
      return !this.current?.features || this.current.features.includes(mod);
    },
  },
});
