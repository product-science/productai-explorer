import { defineStore } from 'pinia';
import { useBlockchain } from './useBlockchain';
import { useBaseStore } from './useBaseStore';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import type {
  Delegation,
  Coin,
  UnbondingResponses,
  DelegatorRewards,
  WalletConnected,
} from '@/types';
import { useStakingStore } from './useStakingStore';
import router from '@/router'

// TypeScript declarations for wallet objects
declare global {
  interface Window {
    keplr?: {
      getKey: (chainId: string) => Promise<{
        name: string;
        algo: string;
        pubKey: Uint8Array;
        address: Uint8Array;
        bech32Address: string;
      }>;
    };
    leap?: {
      getKey: (chainId: string) => Promise<{
        name: string;
        algo: string;
        pubKey: Uint8Array;
        address: Uint8Array;
        bech32Address: string;
      }>;
    };
  }
}

export const useWalletStore = defineStore('walletStore', {
  state: () => {
    return {
      balances: [] as Coin[],
      delegations: [] as Delegation[],
      unbonding: [] as UnbondingResponses[],
      rewards: {total: [], rewards: []} as DelegatorRewards,
      wallet: {} as WalletConnected
    };
  },
  getters: {
    blockchain() {
      return useBlockchain();
    },
    baseStore() {
      return useBaseStore();
    },
    connectedWallet() {
      // @ts-ignore
      if(this.wallet.cosmosAddress) return this.wallet
      const chainStore = useBlockchain();
      const key = chainStore.defaultHDPath;
      const connected = JSON.parse(localStorage.getItem(key) || '{}');
      return connected
    },
    balanceOfStakingToken(): Coin {
      const stakingStore = useStakingStore();
      return (
        this.balances.find(
          (x) => x.denom === stakingStore.params.bond_denom
        ) || { amount: '0', denom: stakingStore.params.bond_denom }
      );
    },
    stakingAmount() {
      const stakingStore = useStakingStore();
      let amt = 0;
      let denom = stakingStore.params.bond_denom;
      this.delegations.forEach((i) => {
        amt += Number(i.balance.amount);
        denom = i.balance.denom;
      });
      return { amount: String(amt), denom };
    },
    rewardAmount() {
      const stakingStore = useStakingStore();
      // @ts-ignore
      const reward = this.rewards.total?.find(
        (x: Coin) => x.denom === stakingStore.params.bond_denom
      );
      return reward || { amount: '0', denom: stakingStore.params.bond_denom };
    },
    unbondingAmount() {
      let amt = 0;
      this.unbonding.forEach((i) => {
        i.entries.forEach((e) => {
          amt += Number(e.balance);
        });
      });

      const stakingStore = useStakingStore();
      return { amount: String(amt), denom: stakingStore.params.bond_denom };
    },
    currentAddress() {
      if (!this.connectedWallet?.cosmosAddress) return '';
      const { prefix, data } = fromBech32(this.connectedWallet.cosmosAddress);
      const chainStore = useBlockchain();
      return toBech32(chainStore.current?.bech32Prefix || prefix, data);
    },
    shortAddress() {
      const address: string = this.currentAddress
      if(address.length > 4) {
        return `${address.substring(address.length -4)}`
      }
      return ""
    }
  },
  actions: {

    async loadMyAsset() {
      if (!this.currentAddress) return;
      this.blockchain.rpc.getBankBalances(this.currentAddress).then((x) => {
        this.balances = x.balances;
      });
      this.blockchain.rpc
        .getStakingDelegations(this.currentAddress)
        .then((x) => {
          this.delegations = x.delegation_responses;
        });
      this.blockchain.rpc
        .getStakingDelegatorUnbonding(this.currentAddress)
        .then((x) => {
          this.unbonding = x.unbonding_responses;
        });
      this.blockchain.rpc
        .getDistributionDelegatorRewards(this.currentAddress)
        .then((x) => {
          this.rewards = x;
        });
    },
    
    async getWalletPublicKey() {
      if (!this.currentAddress) return null;
      try {
        const accountInfo = await this.blockchain.rpc.getAuthAccount(this.currentAddress);
        return accountInfo.account?.pub_key || null;
      } catch (error) {
        console.error('Error fetching wallet public key:', error);
        return null;
      }
    },
    
    async getWalletPublicKeyFromWallet(): Promise<any> {
      if (!this.connectedWallet?.wallet) {
        return null;
      }
      
      try {
        const baseStore = useBaseStore();
        
        // Try multiple methods to get chain ID
        const chainIdFromBlockchain = this.blockchain.current?.chainId;
        const chainIdFromBaseStore = baseStore.currentChainId;
        const chainIdFromLatestBlock = baseStore.latest?.block?.header?.chain_id;
        
        // Use the first available chain ID
        const chainId = chainIdFromBaseStore || chainIdFromLatestBlock || chainIdFromBlockchain;
        
        if (!chainId) {
          // Try to initialize baseStore if it's empty
          if (!baseStore.latest?.block) {
            try {
              await baseStore.initial();
              const newChainId = baseStore.currentChainId || baseStore.latest?.block?.header?.chain_id;
              if (newChainId) {
                return await this.getKeyFromWalletWithChainId(newChainId);
              }
            } catch (initError) {
              console.error('Failed to initialize base store:', initError);
            }
          }
          
          return null;
        }

        return await this.getKeyFromWalletWithChainId(chainId);
      } catch (error) {
        console.error('Error getting public key from wallet:', error);
        return null;
      }
    },
    
    async getKeyFromWalletWithChainId(chainId: string): Promise<any> {
        switch (this.connectedWallet?.wallet) {
          case 'keplr':
            if (window.keplr) {
              const key = await window.keplr.getKey(chainId);
              const base64Key = Buffer.from(key.pubKey).toString('base64');
              
              return {
                '@type': '/cosmos.crypto.secp256k1.PubKey',
                key: base64Key,
              };
            } else {
              return null;
            }

          case 'leap':
            if (window.leap) {
              const key = await window.leap.getKey(chainId);
              const base64Key = Buffer.from(key.pubKey).toString('base64');
              
              return {
                '@type': '/cosmos.crypto.secp256k1.PubKey',
                key: base64Key,
              };
            } else {
              return null;
            }

          default:
            return null;
        }
      },
    
    async myBalance() {
      return this.blockchain.rpc.getBankBalances(this.currentAddress);
    },
    myDelegations() {
      return this.blockchain.rpc.getStakingDelegations(this.currentAddress);
    },
    myUnbonding() {
      return this.blockchain.rpc.getStakingDelegatorUnbonding(
        this.currentAddress
      );
    },
    disconnect() {
      const chainStore = useBlockchain();
      const key = chainStore.defaultHDPath;
      localStorage.removeItem(key);
      this.$reset()
    },
    async setConnectedWallet(value: WalletConnected) {
      if(value) {
        this.wallet = value;
        // Auto-submit participant after wallet connection
        await this.autoSubmitParticipant();
      }
    },

    async autoSubmitParticipant() {
      try {
        // Only proceed if we have a current address and inference API is available
        if (!this.currentAddress || !this.blockchain.inferenceApiEndpoint) {
          return;
        }

        console.log('🔄 Auto-submitting participant for:', this.currentAddress);

        // First, try to get public key from account (chain)
        let publicKey = await this.getWalletPublicKey();
        
        // If not found on chain, get from wallet
        if (!publicKey) {
          publicKey = await this.getWalletPublicKeyFromWallet();
        }

        if (!publicKey) {
          console.warn('❌ Could not retrieve public key for participant submission');
          return;
        }

        // Extract the string value of the public key (not the object)
        const pubKeyString = typeof publicKey === 'string' ? publicKey : 
                           (publicKey.key || JSON.stringify(publicKey));

        // Submit participant via inference API
        const participantData = {
          address: this.currentAddress,
          url: '',
          validator_key: '',
          pub_key: pubKeyString,
          worker_key: ''
        };

        const result = await this.blockchain.submitNewUnfundedParticipant(participantData);
        console.log('✅ Participant auto-submitted successfully:', result);

      } catch (error) {
        // Don't throw error to avoid breaking wallet connection flow
        console.warn('⚠️ Auto-participant submission failed:', error);
      }
    },
    suggestChain() {
      if (window.location.pathname === '/SIDE-Testnet') {
        router.push({path: '/wallet/unisat'})
      } else {
        router.push({path: '/wallet/keplr'})
      }
    },
    async sendAdminTransaction() {
      if (!this.currentAddress) {
        throw new Error('No wallet address available');
      }

      try {
        // Get the public key from wallet
        const publicKey = await this.getWalletPublicKeyFromWallet();
        if (!publicKey) {
          throw new Error('Could not retrieve public key from wallet');
        }

        // Get the API endpoint - use the first REST endpoint
        const apiEndpoint = this.blockchain.current?.endpoints?.rest?.[0]?.address;
        if (!apiEndpoint) {
          throw new Error('No API endpoint available');
        }

        console.log('🔍 Debug Info:');
        console.log('  - API Endpoint:', apiEndpoint);
        console.log('  - Wallet Address:', this.currentAddress);
        console.log('  - Public Key:', publicKey);

        // Prepare the admin transaction payload
        const payload = {
          body: {
            messages: [{
              "@type": "/inference.inference.MsgSubmitNewUnfundedParticipant",
              "address": this.currentAddress,
              "url": "",
              "pub_key": publicKey,
              "validator_key": "",
              "worker_key": ""
            }]
          }
        };

        console.log('📤 Sending payload:', JSON.stringify(payload, null, 2));

        // Try a simple health check first
        const healthUrl = `${apiEndpoint}/admin/v1/health`;
        console.log('🏥 Testing health endpoint:', healthUrl);
        
        try {
          const healthResponse = await fetch(healthUrl, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
            },
          });
          console.log('🏥 Health response status:', healthResponse.status);
        } catch (healthError) {
          console.log('🏥 Health check failed:', healthError);
        }

        // Send the admin transaction
        const fullUrl = `${apiEndpoint}/admin/v1/tx/send`;
        console.log('📡 Sending to URL:', fullUrl);
        
        const response = await fetch(fullUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        console.log('📥 Response status:', response.status);
        console.log('📥 Response headers:');
        response.headers.forEach((value, key) => {
          console.log(`  ${key}: ${value}`);
        });

        const responseText = await response.text();
        console.log('📥 Response text:', responseText);

        if (!response.ok) {
          throw new Error(`Admin transaction failed: ${response.status} - ${responseText}`);
        }

        let result;
        try {
          result = JSON.parse(responseText);
        } catch (parseError) {
          result = { raw: responseText };
        }
        
        return result;
      } catch (error) {
        console.error('Error sending admin transaction:', error);
        throw error;
      }
    },
    
    async sendAdminTransactionAltFormat() {
      if (!this.currentAddress) {
        throw new Error('No wallet address available');
      }

      try {
        // Get the public key from wallet
        const publicKey = await this.getWalletPublicKeyFromWallet();
        if (!publicKey) {
          throw new Error('Could not retrieve public key from wallet');
        }

        // Get the API endpoint
        const apiEndpoint = this.blockchain.current?.endpoints?.rest?.[0]?.address;
        if (!apiEndpoint) {
          throw new Error('No API endpoint available');
        }

        console.log('🔄 Trying alternative payload formats...');

        // Try different payload formats
        const payloadFormats = [
          // Format 1: Direct message
          {
            "@type": "/inference.inference.MsgSubmitNewUnfundedParticipant",
            "address": this.currentAddress,
            "url": "",
            "pub_key": publicKey,
            "validator_key": "",
            "worker_key": ""
          },
          // Format 2: Messages array without body wrapper
          {
            "messages": [{
              "@type": "/inference.inference.MsgSubmitNewUnfundedParticipant",
              "address": this.currentAddress,
              "url": "",
              "pub_key": publicKey,
              "validator_key": "",
              "worker_key": ""
            }]
          },
          // Format 3: With additional fields
          {
            "body": {
              "messages": [{
                "@type": "/inference.inference.MsgSubmitNewUnfundedParticipant",
                "address": this.currentAddress,
                "url": "",
                "pub_key": publicKey,
                "validator_key": "",
                "worker_key": ""
              }],
              "memo": "",
              "timeout_height": "0",
              "extension_options": [],
              "non_critical_extension_options": []
            },
            "auth_info": {
              "signer_infos": [],
              "fee": {
                "amount": [],
                "gas_limit": "200000",
                "payer": "",
                "granter": ""
              }
            },
            "signatures": []
          }
        ];

        const fullUrl = `${apiEndpoint}/admin/v1/tx/send`;

        for (let i = 0; i < payloadFormats.length; i++) {
          try {
            console.log(`🧪 Trying format ${i + 1}:`, JSON.stringify(payloadFormats[i], null, 2));
            
            const response = await fetch(fullUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(payloadFormats[i]),
            });

            const responseText = await response.text();
            console.log(`📥 Format ${i + 1} response (${response.status}):`, responseText);

            if (response.ok) {
              console.log(`✅ Format ${i + 1} succeeded!`);
              try {
                return JSON.parse(responseText);
              } catch (parseError) {
                return { raw: responseText };
              }
            }
          } catch (formatError) {
            console.log(`❌ Format ${i + 1} failed:`, formatError);
          }
        }

        throw new Error('All payload formats failed');
      } catch (error) {
        console.error('Error sending admin transaction (alt format):', error);
        throw error;
      }
    },
  },
});