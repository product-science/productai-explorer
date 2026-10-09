import { defineStore } from 'pinia';
import { useBlockchain } from './useBlockchain';
import { useBaseStore } from './useBaseStore';
import { fromBech32, toBech32, toUtf8, toHex } from '@cosmjs/encoding';
import { sha256 } from '@cosmjs/crypto';
import type { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate';
import type { Account as StargateAccount, SigningStargateClient as SigningStargateClientType } from '@cosmjs/stargate';
import type { EncodeObject } from '@cosmjs/proto-signing';
import { Uint64 } from '@cosmjs/math';
import { BaseAccount } from 'cosmjs-types/cosmos/auth/v1beta1/auth';
import type { Any } from 'cosmjs-types/google/protobuf/any';
import type {
  Delegation,
  Coin,
  UnbondingResponses,
  DelegatorRewards,
  WalletConnected,
} from '@/types';
import { useStakingStore } from './useStakingStore';
import { ConfigSource, useDashboard } from './useDashboard';
import router from '@/router'

const ibcRpcCache: Record<string, { url: string; timestamp: number }> = {};
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

const TESTNET_CHAIN_JSON_BASE = 'https://raw.githubusercontent.com/cosmos/chain-registry/master/testnets';
const TESTNET_FOLDER_ALIASES: Record<string, string[]> = {
  osmo: ['osmosistestnet', 'osmosistestnet4'],
  osmosis: ['osmosistestnet', 'osmosistestnet4'],
  cosmos: ['cosmoshubtestnet'],
  cosmoshub: ['cosmoshubtestnet'],
  theta: ['cosmoshubtestnet'],
  pion: ['neutrontestnet'],
  neutron: ['neutrontestnet'],
  atlantic: ['seitestnet'],
  sei: ['seitestnet'],
};

let testnetListingCache: { timestamp: number; folders: string[] } | null = null;

function testnetRegistryFolderCandidates(chainId: string): string[] {
  const lower = chainId.toLowerCase();
  const first = lower.split(/[-_]/)[0];
  return [...new Set([
    ...(TESTNET_FOLDER_ALIASES[first] || []),
    `${first}testnet`,
    `${first}testnet1`,
    `${first}devnet`,
    lower,
  ])];
}

async function listTestnetRegistryFolders(): Promise<string[]> {
  if (testnetListingCache && Date.now() - testnetListingCache.timestamp < CACHE_TTL) {
    return testnetListingCache.folders;
  }

  const res = await fetch(ConfigSource.TestnetCosmosDirectory);
  if (!res.ok) return testnetListingCache?.folders || [];

  const listing = await res.json();
  const folders = (Array.isArray(listing) ? listing : [])
    .filter((entry: any) => entry?.type === 'dir' && typeof entry.name === 'string' && !entry.name.startsWith('_'))
    .map((entry: any) => entry.name as string);

  testnetListingCache = { timestamp: Date.now(), folders };
  return folders;
}

async function fetchTestnetRpcsFromChainRegistry(chainId: string): Promise<string[]> {
  const candidates = testnetRegistryFolderCandidates(chainId);
  let folders = candidates;

  try {
    const available = new Set(await listTestnetRegistryFolders());
    if (available.size > 0) {
      folders = candidates.filter((name) => available.has(name));
      if (folders.length === 0) {
        const first = chainId.toLowerCase().split(/[-_]/)[0];
        folders = [...available].filter((name) => name.toLowerCase().startsWith(first));
      }
    }
  } catch {
    // Fall back to candidate folder names against raw chain.json URLs.
  }

  for (const folder of folders) {
    try {
      const res = await fetch(`${TESTNET_CHAIN_JSON_BASE}/${folder}/chain.json`);
      if (!res.ok) continue;
      const chain = await res.json();
      if (chain?.chain_id !== chainId) continue;
      return (chain.apis?.rpc || [])
        .map((endpoint: any) => endpoint?.address || endpoint)
        .filter(Boolean);
    } catch {
      continue;
    }
  }
  return [];
}

function findLocalChainConfig(sourceChainId: string) {
  const dashboardStore = useDashboard();
  return Object.values(dashboardStore.chains).find(
    (c) =>
      c.chainId === sourceChainId ||
      c.chainName === sourceChainId ||
      (c.chainName && sourceChainId.toLowerCase().includes(c.chainName.toLowerCase())) ||
      (c.chainId && sourceChainId.toLowerCase().includes(c.chainId.toLowerCase()))
  );
}

const ETH_ACCOUNT_TYPE_URLS = new Set([
  '/injective.types.v1beta1.EthAccount',
  '/ethermint.types.v1.EthAccount',
]);

function readLengthDelimitedField(data: Uint8Array, targetField: number): Uint8Array | null {
  let offset = 0;

  const readVarint = () => {
    let value = 0;
    let shift = 0;

    while (offset < data.length) {
      const byte = data[offset++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 35) throw new Error('Invalid protobuf varint');
    }

    throw new Error('Unexpected EOF while reading protobuf varint');
  };

  while (offset < data.length) {
    const tag = readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      readVarint();
      continue;
    }

    if (wireType === 1) {
      offset += 8;
      continue;
    }

    if (wireType === 2) {
      const len = readVarint();
      const end = offset + len;
      if (end > data.length) throw new Error('Invalid protobuf length');
      const bytes = data.slice(offset, end);
      offset = end;
      if (fieldNumber === targetField) return bytes;
      continue;
    }

    if (wireType === 5) {
      offset += 4;
      continue;
    }

    throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }

  return null;
}

function parseEthAccount(anyAccount: Any): StargateAccount {
  const baseAccountBytes = readLengthDelimitedField(anyAccount.value, 1);
  if (!baseAccountBytes) {
    throw new Error(`Unsupported EthAccount payload for type '${anyAccount.typeUrl}'`);
  }

  const baseAccount = BaseAccount.decode(baseAccountBytes);

  return {
    address: baseAccount.address,
    pubkey: null,
    accountNumber: Uint64.fromString(baseAccount.accountNumber.toString()).toNumber(),
    sequence: Uint64.fromString(baseAccount.sequence.toString()).toNumber(),
  };
}

function feeAmountFromGasPrice(gasLimit: string, gasPrice: string | number): string {
  const gas = BigInt(gasLimit);
  const price = String(gasPrice).trim();

  if (!price.includes('.')) {
    return (gas * BigInt(price)).toString();
  }

  const [wholeRaw, fracRaw] = price.split('.');
  const whole = wholeRaw.length ? BigInt(wholeRaw) : 0n;
  const frac = fracRaw.replace(/0+$/, '');
  if (!frac.length) return (gas * whole).toString();

  const scale = BigInt(`1${'0'.repeat(frac.length)}`);
  const atomics = whole * scale + BigInt(frac);
  // ceil(gas * atomics / scale)
  return ((gas * atomics + scale - 1n) / scale).toString();
}

function cleanRpcConnectError(error: any): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message.includes('Value must not be undefined')) {
    return 'source-chain RPC returned an invalid Tendermint response';
  }
  return message || 'unknown RPC connection error';
}

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
      enable: (chainId: string) => Promise<void>;
      getOfflineSigner: (chainId: string) => any;
      experimentalSuggestChain?: (chainInfo: any) => Promise<void>;
    };
    leap?: {
      getKey: (chainId: string) => Promise<{
        name: string;
        algo: string;
        pubKey: Uint8Array;
        address: Uint8Array;
        bech32Address: string;
      }>;
      enable: (chainId: string) => Promise<void>;
      getOfflineSigner: (chainId: string) => any;
    };
  }
}

let activeLoadAssetsPromise: Promise<void> | null = null;
let activeLoadAssetsAddress = '';

export const useWalletStore = defineStore('walletStore', {
  state: () => {
    return {
      balances: [] as Coin[],
      delegations: [] as Delegation[],
      unbonding: [] as UnbondingResponses[],
      rewards: { total: [], rewards: [] } as DelegatorRewards,
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
    connectedWallet(state) {
      // Return the hydrated state directly
      return state.wallet;
    },
    balanceOfStakingToken(): Coin {
      const stakingStore = useStakingStore();
      const blockchainStore = useBlockchain();
      const denom = stakingStore.params.bond_denom || blockchainStore.current?.assets?.[0]?.base || 'ngonka';
      return (
        this.balances.find(
          (x) => x.denom === denom
        ) || { amount: '0', denom }
      );
    },
    stakingAmount() {
      const stakingStore = useStakingStore();
      const blockchainStore = useBlockchain();
      let amt = 0;
      let denom = stakingStore.params.bond_denom || blockchainStore.current?.assets?.[0]?.base || 'ngonka';
      this.delegations.forEach((i) => {
        amt += Number(i.balance.amount);
        denom = i.balance.denom;
      });
      return { amount: String(amt), denom };
    },
    rewardAmount() {
      const stakingStore = useStakingStore();
      const blockchainStore = useBlockchain();
      const denom = stakingStore.params.bond_denom || blockchainStore.current?.assets?.[0]?.base || 'ngonka';
      // @ts-ignore
      const reward = this.rewards.total?.find(
        (x: Coin) => x.denom === denom
      );
      return reward || { amount: '0', denom };
    },
    unbondingAmount() {
      let amt = 0;
      this.unbonding.forEach((i) => {
        i.entries.forEach((e) => {
          amt += Number(e.balance);
        });
      });

      const stakingStore = useStakingStore();
      const blockchainStore = useBlockchain();
      const denom = stakingStore.params.bond_denom || blockchainStore.current?.assets?.[0]?.base || 'ngonka';
      return { amount: String(amt), denom };
    },
    currentAddress() {
      if (!this.connectedWallet?.cosmosAddress) return '';

      try {
        const { prefix, data } = fromBech32(this.connectedWallet.cosmosAddress);
        const chainStore = useBlockchain();
        const targetPrefix = chainStore.current?.bech32Prefix || prefix;
        return toBech32(targetPrefix, data);
      } catch (error) {
        console.error('Error converting address:', error, 'Original address:', this.connectedWallet.cosmosAddress);
        return '';
      }
    },
    shortAddress() {
      const address: string = this.currentAddress
      if (address.length > 4) {
        return `${address.substring(address.length - 4)} `
      }
      return ""
    }
  },
  actions: {

    hydrateWallet() {
      const chainStore = useBlockchain();
      const key = chainStore.defaultHDPath;
      if (!key) return;

      try {
        const stored = localStorage.getItem(key);
        if (stored) {
          const connected = JSON.parse(stored);
          // Validate that the stored data has required fields
          if (connected && connected.cosmosAddress && connected.wallet) {
            // Keep the internal Vue store state lowercase for internal compatibility
            this.wallet = {
              ...connected,
              wallet: connected.wallet.toLowerCase()
            };
          } else {
            console.warn('Invalid stored wallet data, clearing localStorage');
            localStorage.removeItem(key);
            this.wallet = {} as WalletConnected;
          }
        } else {
          this.wallet = {} as WalletConnected;
        }
      } catch (error) {
        console.error('Error parsing stored wallet data:', error);
        localStorage.removeItem(key);
        this.wallet = {} as WalletConnected;
      }
    },

    async loadMyAsset() {
      const address = this.currentAddress;
      if (!address) return;
      if (!this.blockchain.rpc) return;

      if (activeLoadAssetsPromise && activeLoadAssetsAddress === address) {
        return activeLoadAssetsPromise;
      }

      activeLoadAssetsAddress = address;
      activeLoadAssetsPromise = (async () => {
        try {
          const stakingStore = useStakingStore();
          const [bankRes, delRes, rewRes] = await Promise.allSettled([
            this.blockchain.rpc.getBankBalances(address),
            this.blockchain.rpc.getStakingDelegations(address),
            this.blockchain.rpc.getDistributionDelegatorRewards(address),
            stakingStore.params?.bond_denom ? Promise.resolve() : stakingStore.fetchParams()
          ]);

          // Guard against stale overwrites if the wallet changes mid-flight
          if (address !== this.currentAddress) return;

          if (bankRes.status === 'fulfilled') this.balances = bankRes.value.balances || [];
          if (delRes.status === 'fulfilled') this.delegations = delRes.value.delegation_responses || [];
          this.unbonding = [];
          if (rewRes.status === 'fulfilled') this.rewards = rewRes.value || { total: [], rewards: [] };
        } catch (error) {
          console.error('Error loading assets:', error);
        } finally {
          if (activeLoadAssetsAddress === address) {
            activeLoadAssetsPromise = null;
            activeLoadAssetsAddress = '';
          }
        }
      })();

      return activeLoadAssetsPromise;
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

    async resolveChainId(): Promise<string | null> {
      const baseStore = useBaseStore();
      // Try multiple methods to get chain ID
      const chainIdFromBlockchain = this.blockchain.current?.chainId;
      const chainIdFromBaseStore = baseStore.currentChainId;
      const chainIdFromLatestBlock = baseStore.latest?.block?.header?.chain_id;

      let chainId = chainIdFromBaseStore || chainIdFromLatestBlock || chainIdFromBlockchain;

      if (!chainId) {
        // Try to initialize baseStore if it's empty
        if (!baseStore.latest?.block) {
          try {
            await baseStore.initial();
            chainId = baseStore.currentChainId || baseStore.latest?.block?.header?.chain_id;
          } catch (initError) {
            console.error('Failed to initialize base store:', initError);
          }
        }
      }

      return chainId || null;
    },

    async getCosmWasmSigningClient(rpcEndpoint: string, offlineSigner: any) {
      if (!rpcEndpoint) throw new Error('No RPC endpoint available');

      const [{ Tendermint37Client }, { SigningCosmWasmClient }] = await Promise.all([
        import('@cosmjs/tendermint-rpc'),
        import('@cosmjs/cosmwasm-stargate')
      ]);

      try {
        const rpcClient = await Promise.race([
          Tendermint37Client.connect(rpcEndpoint),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('RPC connection timeout')), 10000)
          )
        ]);

        return await SigningCosmWasmClient.createWithSigner(
          rpcClient as any,
          offlineSigner,
          { gasPrice: undefined }
        );
      } catch (error) {
        console.error('RPC connection failed for CosmWasmClient:', error);
        throw error;
      }
    },

    async getStargateSigningClient(rpcEndpoint: string, offlineSigner: any): Promise<SigningStargateClientType> {
      if (!rpcEndpoint) throw new Error('No RPC endpoint available');

      const [
        { SigningStargateClient, accountFromAny, defaultRegistryTypes },
        { Registry },
        { wasmTypes }
      ] = await Promise.all([
        import('@cosmjs/stargate'),
        import('@cosmjs/proto-signing'),
        import('@cosmjs/cosmwasm-stargate')
      ]);

      const registry = new Registry([...defaultRegistryTypes, ...wasmTypes] as any);

      const accountParser = (anyAccount: Any): StargateAccount => {
        if (ETH_ACCOUNT_TYPE_URLS.has(anyAccount.typeUrl)) {
          return parseEthAccount(anyAccount);
        }
        return accountFromAny(anyAccount);
      };

      try {
        return await Promise.race<SigningStargateClientType>([
          SigningStargateClient.connectWithSigner(rpcEndpoint, offlineSigner, {
            accountParser,
            registry: registry as any,
          }),
          new Promise<SigningStargateClientType>((_, reject) =>
            setTimeout(() => reject(new Error('RPC connection timeout')), 10000)
          )
        ]);
      } catch (error) {
        console.error('RPC connection failed for StargateClient:', error);
        throw error;
      }
    },

    async signAndBroadcastInjectiveDirectTx(
      sourceChainId: string,
      senderAddress: string,
      senderPubkey: Uint8Array,
      offlineSigner: any,
      rpcEndpoint: string,
      msg: EncodeObject,
      fee: { amount: { denom: string; amount: string }[]; gas: string },
      memo = ''
    ): Promise<any> {
      if (typeof offlineSigner?.signDirect !== 'function') {
        throw new Error('Connected wallet does not support signDirect for Injective transactions');
      }

      const self = this;
      offlineSigner = new Proxy(offlineSigner, {
        get(target, prop, receiver) {
          if (prop === 'signDirect') {
            return async (signerAddress: string, signDoc: any) => {
              console.log('Intercepted signDirect via Proxy for Injective:', {
                signerAddress,
                signDoc: {
                  ...signDoc,
                  accountNumber: signDoc.accountNumber?.toString(),
                }
              });

              let accountNumber = signDoc.accountNumber;
              if (accountNumber === undefined || accountNumber === null) {
                console.warn('signDirect wrapper: signDoc.accountNumber is undefined/null, querying sequence...');
                try {
                  const client = await self.getStargateSigningClient(rpcEndpoint, receiver);
                  try {
                    const seq = await client.getSequence(signerAddress);
                    accountNumber = seq?.accountNumber;
                  } finally {
                    client.disconnect();
                  }
                } catch (e) {
                  console.error('Failed to query sequence in signDirect wrapper for Injective:', e);
                }
              }

              if (accountNumber === undefined || accountNumber === null) {
                throw new Error('Account number is undefined/null. Cannot sign Injective transaction.');
              }

              const cleanSignDoc = {
                bodyBytes: signDoc.bodyBytes,
                authInfoBytes: signDoc.authInfoBytes,
                chainId: signDoc.chainId,
                accountNumber: accountNumber.toString() as any,
              };

              return target.signDirect(signerAddress, cleanSignDoc);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });

      const [
        { makeAuthInfoBytes, makeSignDoc },
        { fromBase64 },
        { TxBody, TxRaw },
        { MsgTransfer },
        { PubKey },
        { Any },
      ] = await Promise.all([
        import('@cosmjs/proto-signing'),
        import('@cosmjs/encoding'),
        import('cosmjs-types/cosmos/tx/v1beta1/tx'),
        import('cosmjs-types/ibc/applications/transfer/v1/tx'),
        import('cosmjs-types/cosmos/crypto/secp256k1/keys'),
        import('cosmjs-types/google/protobuf/any'),
      ]);

      const signingClient = await this.getStargateSigningClient(rpcEndpoint, offlineSigner);

      try {
        const { accountNumber, sequence } = await signingClient.getSequence(senderAddress);

        const msgTransfer = MsgTransfer.fromPartial(msg.value as any);
        const msgAny = Any.fromPartial({
          typeUrl: msg.typeUrl,
          value: MsgTransfer.encode(msgTransfer).finish(),
        });

        const txBodyBytes = TxBody.encode(
          TxBody.fromPartial({
            messages: [msgAny],
            memo,
          })
        ).finish();

        const pubkeyAny = Any.fromPartial({
          // Injective requires this pubkey Any type URL
          typeUrl: '/injective.crypto.v1beta1.ethsecp256k1.PubKey',
          value: PubKey.encode(PubKey.fromPartial({ key: senderPubkey })).finish(),
        });

        const authInfoBytes = makeAuthInfoBytes(
          [{ pubkey: pubkeyAny, sequence }],
          fee.amount,
          Number(fee.gas),
          undefined,
          undefined
        );

        const signDoc = makeSignDoc(txBodyBytes, authInfoBytes, sourceChainId, accountNumber);
        const { signed, signature } = await offlineSigner.signDirect(senderAddress, signDoc);

        const txRaw = TxRaw.fromPartial({
          bodyBytes: signed.bodyBytes,
          authInfoBytes: signed.authInfoBytes,
          signatures: [fromBase64(signature.signature)],
        });

        const txBytes = TxRaw.encode(txRaw).finish();
        const txHash = toHex(sha256(txBytes)).toUpperCase();

        try {
          return await Promise.race([
            signingClient.broadcastTx(txBytes),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('IBC transfer broadcast timeout')), 30000)
            ),
          ]);
        } catch (broadcastError: any) {
          const errMsg = String(broadcastError?.message || broadcastError);
          if (errMsg.includes('transaction indexing is disabled') && txHash) {
            console.warn('Transaction indexing is disabled on this RPC node. Returning synthetic success response for Injective:', txHash);
            return {
              code: 0,
              transactionHash: txHash,
              height: 0,
              gasUsed: 0,
              gasWanted: 0,
              rawLog: 'Broadcasted successfully (indexer disabled)'
            };
          }
          throw broadcastError;
        }
      } finally {
        signingClient.disconnect();
      }
    },

    async getWalletPublicKeyFromWallet(): Promise<any> {
      if (!this.connectedWallet?.wallet) {
        return null;
      }

      try {
        const chainId = await this.resolveChainId();

        if (!chainId) {
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
      if (value && value.cosmosAddress && value.wallet) {
        // Keep the internal Vue store state lowercase for internal compatibility
        const internalWalletValue = {
          ...value,
          wallet: value.wallet.toLowerCase()
        };
        this.wallet = internalWalletValue;

        // Persist to localStorage with capitalized wallet names for ping-widget compatibility
        const chainStore = useBlockchain();
        const key = chainStore.defaultHDPath;
        if (key) {
          let capitalizedWallet = value.wallet;
          const lowerWallet = value.wallet.toLowerCase();
          if (lowerWallet === 'keplr') {
            capitalizedWallet = 'Keplr';
          } else if (lowerWallet === 'leap') {
            capitalizedWallet = 'Leap';
          } else if (lowerWallet === 'metamask') {
            capitalizedWallet = 'Metamask';
          } else {
            // Capitalize first letter as fallback
            capitalizedWallet = value.wallet.charAt(0).toUpperCase() + value.wallet.slice(1);
          }

          const storageValue = {
            ...value,
            wallet: capitalizedWallet
          };
          localStorage.setItem(key, JSON.stringify(storageValue));
        }

        // Fetch balances and assets immediately on connection
        try {
          await this.loadMyAsset();
        } catch (error) {
          console.error('Error loading assets on wallet connection:', error);
        }

        // Auto-submit participant after wallet connection
        await this.autoSubmitParticipant();
      } else {
        console.warn('Invalid wallet connection data:', value);
      }
    },

    async autoSubmitParticipant() {
      try {
        // Check if auto-submission is enabled (can be disabled via localStorage or env)
        const autoSubmitEnabled = localStorage.getItem('inference-auto-submit') !== 'false' &&
          !process?.env?.DISABLE_AUTO_PARTICIPANT_SUBMIT;

        if (!autoSubmitEnabled) {
          console.log('⏭️ Auto-participant submission is disabled');
          return;
        }

        // Only proceed if we have a current address and inference API is available
        if (!this.currentAddress || !this.blockchain.inferenceApiEndpoint) {
          console.log('⏭️ Skipping auto-participant submission: missing address or inference API endpoint');
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

        // If it's a network error, suggest the user check if the inference API is running
        if (error instanceof Error && (error.message.includes('fetch') || error.message.includes('Failed to fetch'))) {
          console.warn('💡 Hint: Make sure the inference API is running at:', this.blockchain.inferenceApiEndpoint);
        }
      }
    },
    suggestChain() {
      if (window.location.pathname === '/SIDE-Testnet') {
        router.push({ path: '/wallet/unisat' })
      } else {
        router.push({ path: '/wallet/keplr' })
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

        const isDev = import.meta.env?.DEV || false;
        if (isDev) {
          console.log('🔍 Debug Info:');
          console.log('  - API Endpoint:', apiEndpoint);
          console.log('  - Wallet Address:', this.currentAddress);
          console.log('  - Public Key:', publicKey);
        }

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
        const healthUrl = `${apiEndpoint} /admin/v1 / health`;
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
        const fullUrl = `${apiEndpoint.endsWith('/') ? apiEndpoint.slice(0, -1) : apiEndpoint}/admin/v1/tx/send`;
        if (isDev) console.log('📡 Sending to URL:', fullUrl);

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
          console.log(`  ${key}: ${value} `);
        });

        const responseText = await response.text();
        console.log('📥 Response text:', responseText);

        if (!response.ok) {
          throw new Error(`Admin transaction failed: ${response.status} - ${responseText} `);
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

        const isDev = import.meta.env?.DEV || false;
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

        const fullUrl = `${apiEndpoint.endsWith('/') ? apiEndpoint.slice(0, -1) : apiEndpoint}/admin/v1/tx/send`;

        for (let i = 0; i < payloadFormats.length; i++) {
          try {
            if (isDev) console.log(`🧪 Trying format ${i + 1}: `, JSON.stringify(payloadFormats[i], null, 2));

            const response = await fetch(fullUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(payloadFormats[i]),
            });

            const responseText = await response.text();
            console.log(`📥 Format ${i + 1} response(${response.status}): `, responseText);

            if (response.ok) {
              console.log(`✅ Format ${i + 1} succeeded!`);
              try {
                return JSON.parse(responseText);
              } catch (parseError) {
                return { raw: responseText };
              }
            }
          } catch (formatError) {
            console.log(`❌ Format ${i + 1} failed: `, formatError);
          }
        }

        throw new Error('All payload formats failed');
      } catch (error) {
        console.error('Error sending admin transaction (alt format):', error);
        throw error;
      }
    },

    // Token swap execution
    async executeTokenSwap(cw20TokenAddress: string, poolContractAddress: string, amount: string) {
      if (!this.currentAddress) {
        throw new Error('No wallet address available');
      }

      // The msg should be base64 encoded empty object for basic swap
      const msgBase64 = btoa('{}'); // "e30=" - base64 encoded "{}"

      const execution = {
        send: {
          contract: poolContractAddress,
          amount: amount,
          msg: msgBase64
        }
      };

      // Return the execution object for use with the transaction dialog
      return {
        contract: cw20TokenAddress,
        execution: execution
      };
    },

    // Direct token swap execution (bypasses dialog completely)
    async executeTokenSwapDirect(cw20TokenAddress: string, poolContractAddress: string, amount: string) {
      if (!this.currentAddress) {
        throw new Error('No wallet address available');
      }

      try {
        const chainId = await this.resolveChainId();
        if (!chainId) {
          throw new Error('Chain ID not available - please ensure the blockchain is connected');
        }

        console.log('✅ Using chain ID:', chainId);

        // Get the current connected wallet type
        const walletType = this.connectedWallet?.wallet;
        if (!walletType) {
          throw new Error('No wallet connected');
        }

        console.log('🔌 Using connected wallet:', walletType);

        // Get wallet interface and offline signer based on connected wallet type
        let offlineSigner;
        switch (walletType) {
          case 'keplr':
            if (!window.keplr) {
              throw new Error('Keplr wallet not found. Please install Keplr extension.');
            }
            // Hint Keplr not to override provided fee/memo
            try {
              if (window.keplr && typeof window.keplr === 'object') {
                (window.keplr as any).defaultOptions = {
                  sign: { preferNoSetFee: true, preferNoSetMemo: true },
                };
              }
            } catch { }
            await window.keplr.enable(chainId);
            offlineSigner = window.keplr.getOfflineSigner(chainId);
            break;

          case 'leap':
            if (!window.leap) {
              throw new Error('Leap wallet not found. Please install Leap extension.');
            }
            // Hint Leap not to override provided fee/memo (Leap follows Keplr API)
            try {
              if ((window.leap && typeof window.leap === 'object')) {
                (window.leap as any).defaultOptions = {
                  sign: { preferNoSetFee: true, preferNoSetMemo: true },
                };
              }
            } catch { }
            await (window.leap as any).enable(chainId);
            offlineSigner = (window.leap as any).getOfflineSigner(chainId);
            break;

          default:
            throw new Error(`Wallet type "${walletType}" is not supported for direct transactions.Please use a supported wallet(Keplr, Leap).`);
        }

        // Get the accounts
        const accounts = await offlineSigner.getAccounts();
        if (accounts.length === 0) {
          throw new Error('No accounts found in wallet');
        }

        // Import signing client


        // Get RPC endpoint safely
        const rpcAddress = this.blockchain.current?.endpoints?.rpc?.[0]?.address;
        if (!rpcAddress) {
          throw new Error('No RPC endpoint available');
        }
        const rpcEndpoint = rpcAddress.endsWith('/') ? rpcAddress : rpcAddress + '/';

        // Create signing client with better error handling
        let signingClient;
        try {
          signingClient = await this.getCosmWasmSigningClient(rpcEndpoint, offlineSigner);
          console.log('✅ Successfully connected to RPC endpoint');
        } catch (rpcError) {
          console.error('RPC connection failed:', rpcError);
          console.error('RPC error details:', {
            message: rpcError instanceof Error ? rpcError.message : 'Unknown error',
            stack: rpcError instanceof Error ? rpcError.stack : undefined,
            endpoint: rpcEndpoint
          });
        }

        // The msg should be base64 encoded empty object for basic swap
        const msgBase64 = btoa('{}'); // "e30=" - base64 encoded "{}"

        const executeMsg = {
          send: {
            contract: poolContractAddress,
            amount: amount,
            msg: msgBase64
          }
        };

        const isDev = import.meta.env?.DEV || false;
        if (isDev) {
          console.log('Executing direct swap transaction:', {
            contract: cw20TokenAddress,
            executeMsg: executeMsg,
            chainId: chainId,
            sender: this.currentAddress
          });
        }

        // Use zero-fee to rely on ante handler exemption
        const gasLimit = '500000'; // Standard gas limit for contract execution
        const fee = {
          amount: [],
          gas: gasLimit,
        } as any;

        console.log('💰 Using zero-fee for swap (ante handler expected to exempt):', {
          gasLimit,
          fee
        });

        // Ensure signing client was created successfully
        if (!signingClient) {
          throw new Error('Failed to initialize signing client');
        }

        // Build MsgExecuteContract and broadcast without log parsing
        const msg: MsgExecuteContractEncodeObject = {
          typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
          value: {
            sender: this.currentAddress,
            contract: cw20TokenAddress,
            msg: toUtf8(JSON.stringify(executeMsg)),
            funds: [],
          },
        };

        let result: any;
        try {
          result = await Promise.race([
            signingClient.signAndBroadcast(this.currentAddress, [msg], fee),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Transaction execution timeout')), 30000)
            ),
          ]);

          return {
            transactionHash: result.transactionHash,
            height: result.height,
            gasUsed: result.gasUsed,
            gasWanted: result.gasWanted,
            success: result.code === 0,
            rawLog: result.rawLog,
          };
        } catch (executeError) {
          console.error('Error executing direct swap (signAndBroadcast):', executeError);
          console.error('Execute error details:', {
            message: executeError instanceof Error ? executeError.message : 'Unknown error',
            stack: executeError instanceof Error ? executeError.stack : undefined,
            contract: cw20TokenAddress,
            sender: this.currentAddress,
            fee: fee,
          });
          throw executeError;
        }
      } catch (error) {
        console.error('Error executing direct swap:', error);
        throw error;
      }
    },

    async executeNativeSwapDirect(ibcTokenDenom: string, poolContractAddress: string, amount: string) {
      if (!this.currentAddress) {
        throw new Error('No wallet address available');
      }

      try {
        const chainId = await this.resolveChainId();
        if (!chainId) {
          throw new Error('Chain ID not available - please ensure the blockchain is connected');
        }

        console.log('✅ Using chain ID:', chainId);

        // Get the current connected wallet type
        const walletType = this.connectedWallet?.wallet;
        if (!walletType) {
          throw new Error('No wallet connected');
        }

        console.log('🔌 Using connected wallet:', walletType);

        // Get wallet interface and offline signer based on connected wallet type
        let offlineSigner;
        switch (walletType) {
          case 'keplr':
            if (!window.keplr) {
              throw new Error('Keplr wallet not found. Please install Keplr extension.');
            }
            try {
              if (window.keplr && typeof window.keplr === 'object') {
                (window.keplr as any).defaultOptions = {
                  sign: { preferNoSetFee: true, preferNoSetMemo: true },
                };
              }
            } catch { }
            await window.keplr.enable(chainId);
            offlineSigner = window.keplr.getOfflineSigner(chainId);
            break;

          case 'leap':
            if (!window.leap) {
              throw new Error('Leap wallet not found. Please install Leap extension.');
            }
            try {
              if ((window.leap && typeof window.leap === 'object')) {
                (window.leap as any).defaultOptions = {
                  sign: { preferNoSetFee: true, preferNoSetMemo: true },
                };
              }
            } catch { }
            await (window.leap as any).enable(chainId);
            offlineSigner = (window.leap as any).getOfflineSigner(chainId);
            break;

          default:
            throw new Error(`Wallet type "${walletType}" is not supported for direct transactions.Please use a supported wallet(Keplr, Leap).`);
        }

        // Get the accounts
        const accounts = await offlineSigner.getAccounts();
        if (accounts.length === 0) {
          throw new Error('No accounts found in wallet');
        }

        // Get RPC endpoint safely
        const rpcAddress = this.blockchain.current?.endpoints?.rpc?.[0]?.address;
        if (!rpcAddress) {
          throw new Error('No RPC endpoint available');
        }
        const rpcEndpoint = rpcAddress.endsWith('/') ? rpcAddress : rpcAddress + '/';

        // Create signing client
        let signingClient;
        try {
          signingClient = await this.getCosmWasmSigningClient(rpcEndpoint, offlineSigner);
        } catch (rpcError) {
          console.error('RPC connection failed:', rpcError);
          throw rpcError;
        }

        // Prepare the message for native purchase
        const executeMsg = {
          purchase_with_native: {}
        };

        // Prepare funds attached to the transaction
        const funds = [{
          denom: ibcTokenDenom,
          amount: amount
        }];

        const isDev = import.meta.env?.DEV || false;
        if (isDev) {
          console.log('Executing native purchase transaction:', {
            contract: poolContractAddress,
            executeMsg: executeMsg,
            funds: funds,
            chainId: chainId,
            sender: this.currentAddress
          });
        }

        const gasLimit = '500000';
        const fee = {
          amount: [],
          gas: gasLimit,
        } as any;


        if (!signingClient) {
          throw new Error('Failed to initialize signing client');
        }

        const msg: MsgExecuteContractEncodeObject = {
          typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
          value: {
            sender: this.currentAddress,
            contract: poolContractAddress,
            msg: toUtf8(JSON.stringify(executeMsg)),
            funds: funds,
          },
        };

        let result: any;
        try {
          result = await Promise.race([
            signingClient.signAndBroadcast(this.currentAddress, [msg], fee),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Transaction execution timeout')), 30000)
            ),
          ]);

          return {
            transactionHash: result.transactionHash,
            height: result.height,
            gasUsed: result.gasUsed,
            gasWanted: result.gasWanted,
            success: result.code === 0,
            rawLog: result.rawLog,
          };
        } catch (executeError) {
          console.error('Error executing native purchase:', executeError);
          throw executeError;
        }
      } catch (error) {
        console.error('Error executing native purchase:', error);
        throw error;
      }
    },

    async executeIbcTransfer(sourceChainId: string, sourcePort: string, sourceChannel: string, tokenDenom: string, amount: string, receiver: string) {
      if (!this.currentAddress) {
        throw new Error('No wallet address available');
      }

      const requiredFields = {
        sourceChainId,
        sourcePort,
        sourceChannel,
        tokenDenom,
        amount,
        receiver,
      };
      const missingField = Object.entries(requiredFields).find(([, value]) => !value);
      if (missingField) {
        throw new Error(`Missing IBC transfer field: ${missingField[0]}`);
      }

      try {
        const walletType = this.connectedWallet?.wallet;
        if (!walletType) {
          throw new Error('No wallet connected');
        }

        let offlineSigner: any;
        let senderAddress = this.currentAddress;

        // 1. We must enable Keplr/Leap for the SOURCE chain (e.g., injective-888)
        switch (walletType) {
          case 'keplr':
            if (!window.keplr) throw new Error('Keplr wallet not found');
            try {
              (window.keplr as any).defaultOptions = {
                sign: { preferNoSetFee: true, preferNoSetMemo: true },
              };
            } catch { }
            await window.keplr.enable(sourceChainId);
            offlineSigner = window.keplr.getOfflineSigner(sourceChainId);
            break;
          case 'leap':
            if (!window.leap) throw new Error('Leap wallet not found');
            try {
              (window.leap as any).defaultOptions = {
                sign: { preferNoSetFee: true, preferNoSetMemo: true },
              };
            } catch { }
            await (window.leap as any).enable(sourceChainId);
            offlineSigner = (window.leap as any).getOfflineSigner(sourceChainId);
            break;
          default:
            throw new Error(`Wallet type "${walletType}" not supported for IBC transfer`);
        }

        // Wrap the signer to ensure standard Long accountNumber is used for signDirect compatibility
        const self = this;
        if (offlineSigner && typeof offlineSigner.signDirect === 'function') {
          offlineSigner = new Proxy(offlineSigner, {
            get(target, prop, receiver) {
              if (prop === 'signDirect') {
                return async (signerAddress: string, signDoc: any) => {
                  console.log('Intercepted signDirect via Proxy:', {
                    signerAddress,
                    signDoc: {
                      ...signDoc,
                      accountNumber: signDoc.accountNumber?.toString(),
                    }
                  });

                  let accountNumber = signDoc.accountNumber;
                  if (accountNumber === undefined || accountNumber === null) {
                    console.warn('signDirect wrapper: signDoc.accountNumber is undefined/null, querying sequence...');
                    try {
                      const client = await self.getStargateSigningClient(rpcEndpoint || rpcEndpoints[0], receiver);
                      try {
                        const seq = await client.getSequence(signerAddress);
                        accountNumber = seq?.accountNumber;
                      } finally {
                        client.disconnect();
                      }
                    } catch (e) {
                      console.error('Failed to query sequence in signDirect wrapper:', e);
                    }
                  }

                  if (accountNumber === undefined || accountNumber === null) {
                    throw new Error('Account number is undefined/null. Cannot sign transaction.');
                  }

                  const cleanSignDoc = {
                    bodyBytes: signDoc.bodyBytes,
                    authInfoBytes: signDoc.authInfoBytes,
                    chainId: signDoc.chainId,
                    accountNumber: accountNumber.toString() as any,
                  };

                  return target.signDirect(signerAddress, cleanSignDoc);
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            }
          });
        }

        const signerAccounts = await offlineSigner.getAccounts();
        if (!signerAccounts.length) {
          throw new Error(`No accounts available in ${walletType} for ${sourceChainId}`);
        }
        if (!signerAccounts[0].pubkey || signerAccounts[0].pubkey.length === 0) {
          throw new Error(`Missing pubkey in wallet account for ${sourceChainId}`);
        }
        senderAddress = signerAccounts[0].address;

        // 2. We need a working RPC endpoint for the SOURCE chain.
        let rpcEndpoint = '';
        const rpcEndpoints: string[] = [];
        const addRpcEndpoint = (url: unknown) => {
          const endpoint = typeof url === 'string' ? url.trim() : '';
          if (endpoint && !rpcEndpoints.includes(endpoint)) {
            rpcEndpoints.push(endpoint);
          }
        };
        const addRpcEndpoints = (endpoints: any[]) => {
          endpoints.forEach((endpoint) => addRpcEndpoint(endpoint?.address || endpoint));
        };

        // Check memory cache first, but verify it before reusing it for signing.
        const cachedRpc = ibcRpcCache[sourceChainId];
        if (cachedRpc && Date.now() - cachedRpc.timestamp < CACHE_TTL) {
          addRpcEndpoint(cachedRpc.url);
        }

        const sourceChainConfig = findLocalChainConfig(sourceChainId);
        if (sourceChainConfig?.endpoints?.rpc) {
          addRpcEndpoints(sourceChainConfig.endpoints.rpc);
        }

        // Hardcode reliable fallbacks for known testnets. The old testcosmos.directory
        // API is dead (502 without CORS), so it must not be fetched.
        if (sourceChainId === 'injective-888') {
          addRpcEndpoint('https://testnet.sentry.tm.injective.network:443');
        }

        let directoryRpcLoaded = false;
        const loadDirectoryRpcEndpoints = async () => {
          if (directoryRpcLoaded) return;
          directoryRpcLoaded = true;

          const looksLikeTestnet = sourceChainId.includes('testnet') || sourceChainId.includes('-888');

          const findAndFetchMainnetRpc = async () => {
            try {
              const directoryData = await fetch(ConfigSource.MainnetCosmosDirectory).then(res => res.ok ? res.json() : null);
              const chains = directoryData?.chains || [];
              const specificChain = chains.find((c: any) => c.chain_id === sourceChainId);
              if (!specificChain) return [];

              const detailRes = await fetch(`${ConfigSource.MainnetCosmosDirectory}/${specificChain.name}`);
              if (!detailRes.ok) return [];
              const detailData = await detailRes.json();
              const endpoints = detailData?.chain?.best_apis?.rpc || detailData?.chain?.apis?.rpc || [];
              return endpoints.map((endpoint: any) => endpoint?.address || endpoint).filter(Boolean);
            } catch (e) {
              console.warn(`Could not resolve RPC from cosmos.directory for chain ID: ${sourceChainId}`, e);
              return [];
            }
          };

          try {
            if (looksLikeTestnet) {
              addRpcEndpoints(await fetchTestnetRpcsFromChainRegistry(sourceChainId));
              if (rpcEndpoints.length === 0) {
                addRpcEndpoints(await findAndFetchMainnetRpc());
              }
            } else {
              addRpcEndpoints(await findAndFetchMainnetRpc());
              if (rpcEndpoints.length === 0) {
                addRpcEndpoints(await fetchTestnetRpcsFromChainRegistry(sourceChainId));
              }
            }
          } catch (e) {
            console.warn(`Could not resolve RPC from chain registries for chain ID: ${sourceChainId}`, e);
          }
        };

        // If we still don't have an RPC endpoint, query the directories
        if (rpcEndpoints.length === 0) {
          await loadDirectoryRpcEndpoints();
        }

        // Fallback or explicit override if necessary
        if (rpcEndpoints.length === 0) {
          throw new Error(`Could not find a working RPC endpoint for source chain: ${sourceChainId}`);
        }
        rpcEndpoint = rpcEndpoints[0];


        const msg: EncodeObject = {
          typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
          value: {
            sourcePort: sourcePort,
            sourceChannel: sourceChannel,
            token: {
              denom: tokenDenom,
              amount: amount,
            },
            sender: senderAddress,
            receiver: receiver,
            timeoutHeight: {
              revisionNumber: '0',
              revisionHeight: '0',
            },
            timeoutTimestamp: ((Date.now() + 600000) * 1000000).toString(), // 10 minutes from now in nanoseconds
            memo: '',
          },
        };

        const gasLimit = '500000';

        // Dynamically resolve the gas denom to use the native token instead of the transferred token
        let gasDenom = tokenDenom;
        if (sourceChainConfig && sourceChainConfig.assets?.[0]?.base) {
          gasDenom = sourceChainConfig.assets[0].base;
        } else if (sourceChainId.toLowerCase().includes('gonka')) {
          gasDenom = 'ngonka';
        } else if (sourceChainId.toLowerCase().includes('side')) {
          gasDenom = 'uside';
        } else if (sourceChainId.includes('injective')) {
          gasDenom = 'inj';
        } else if (sourceChainId.includes('evmos')) {
          gasDenom = 'aevmos';
        } else if (sourceChainId.includes('osmosis')) {
          gasDenom = 'uosmo';
        } else if (sourceChainId.includes('cosmoshub')) {
          gasDenom = 'uatom';
        } else if (sourceChainId.includes('kava')) {
          gasDenom = 'ukava';
        }

        // Prefer wallet-provided gas price steps when available.
        let walletSuggestedGasPrice: string | number | undefined;
        try {
          if (walletType === 'keplr' && typeof (window.keplr as any)?.getChainInfoWithoutEndpoints === 'function') {
            const chainInfo = await (window.keplr as any).getChainInfoWithoutEndpoints(sourceChainId);
            const feeCurrency =
              chainInfo?.feeCurrencies?.find((c: any) => c?.coinMinimalDenom === gasDenom) ||
              chainInfo?.feeCurrencies?.[0];
            walletSuggestedGasPrice =
              feeCurrency?.gasPriceStep?.average ??
              feeCurrency?.gasPriceStep?.high ??
              feeCurrency?.gasPriceStep?.low;
          }
        } catch (e) {
          console.warn('Could not fetch wallet gas price suggestion, using fallback fee logic:', e);
        }

        // Some chains (Injective/Ethermint family) require very large min gas price values.
        let feeAmount = '5000';
        if (walletSuggestedGasPrice !== undefined) {
          feeAmount = feeAmountFromGasPrice(gasLimit, walletSuggestedGasPrice);
        } else if (sourceChainId.includes('injective')) {
          const minGasPrice = 160000000n; // from Injective chain-registry fixed_min_gas_price
          feeAmount = (BigInt(gasLimit) * minGasPrice).toString();
        }

        const fee = {
          amount: [{ denom: gasDenom, amount: feeAmount }],
          gas: gasLimit,
        };

        console.log(`Sending IBC transfer via protobuf signAndBroadcast (${walletType})...`, {
          chainId: sourceChainId,
          rpcEndpoints,
          msg,
          fee,
        });

        let broadcastResult: any;
        if (sourceChainId.includes('injective')) {
          broadcastResult = await this.signAndBroadcastInjectiveDirectTx(
            sourceChainId,
            senderAddress,
            signerAccounts[0].pubkey,
            offlineSigner,
            rpcEndpoint,
            msg,
            fee,
            ''
          );
        } else {
          let signingClient: SigningStargateClientType | null = null;
          let lastRpcError: any = null;
          for (let i = 0; i < rpcEndpoints.length; i++) {
            const candidate = rpcEndpoints[i];
            try {
              signingClient = await this.getStargateSigningClient(candidate, offlineSigner);
              rpcEndpoint = candidate;
              break;
            } catch (error) {
              lastRpcError = error;
              if (ibcRpcCache[sourceChainId]?.url === candidate) {
                delete ibcRpcCache[sourceChainId];
              }
              console.warn(`IBC RPC endpoint failed for ${sourceChainId}: ${candidate}`, error);
              if (i === rpcEndpoints.length - 1 && !directoryRpcLoaded) {
                await loadDirectoryRpcEndpoints();
              }
            }
          }

          if (!signingClient) {
            const cause = lastRpcError ? ` Last error: ${cleanRpcConnectError(lastRpcError)}` : '';
            throw new Error(`Could not connect to a working RPC endpoint for source chain: ${sourceChainId}.${cause}`);
          }

          if (rpcEndpoint && sourceChainId !== 'injective-888') {
            ibcRpcCache[sourceChainId] = { url: rpcEndpoint, timestamp: Date.now() };
          }

          let txHash = '';
          try {
            const txRaw = await signingClient.sign(senderAddress, [msg], fee, '');
            const { TxRaw } = await import('cosmjs-types/cosmos/tx/v1beta1/tx');
            const txBytes = TxRaw.encode(txRaw).finish();
            txHash = toHex(sha256(txBytes)).toUpperCase();

            broadcastResult = await Promise.race([
              signingClient.broadcastTx(txBytes),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('IBC transfer broadcast timeout')), 30000)
              ),
            ]);
          } catch (broadcastError: any) {
            const errMsg = String(broadcastError?.message || broadcastError);
            if (errMsg.includes('transaction indexing is disabled') && txHash) {
              console.warn('Transaction indexing is disabled on this RPC node. Returning synthetic success response:', txHash);
              broadcastResult = {
                code: 0,
                transactionHash: txHash,
                height: 0,
                gasUsed: 0,
                gasWanted: 0,
                rawLog: 'Broadcasted successfully (indexer disabled)'
              };
            } else {
              throw broadcastError;
            }
          } finally {
            signingClient.disconnect();
          }
        }

        if (!broadcastResult || broadcastResult.code !== 0) {
          const log = broadcastResult?.rawLog || 'Unknown broadcast error';
          throw new Error(`IBC transfer failed on-chain: ${log}`);
        }

        return {
          transactionHash: broadcastResult.transactionHash,
          height: broadcastResult.height,
          gasUsed: broadcastResult.gasUsed,
          gasWanted: broadcastResult.gasWanted,
          success: true,
          rawLog: broadcastResult.rawLog || 'Broadcasted successfully',
        };

      } catch (error) {
        console.error('Error executing IBC transfer:', error);
        throw error;
      }
    },
  },
});
