import { ref, computed } from 'vue';
import { SigningCosmWasmClient, wasmTypes } from '@cosmjs/cosmwasm-stargate';
import { calculateFee, GasPrice } from '@cosmjs/stargate';
import { Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { ethers } from 'ethers';
import { get } from '@/libs/http';
import { toHex } from '@cosmjs/encoding';
import { sha256 } from '@cosmjs/crypto';

export type UnwrapStatus =
  | 'idle'
  | 'connecting'
  | 'signing_gonka'
  | 'waiting_bls'
  | 'signing_ethereum'
  | 'completed'
  | 'failed';

export interface UnwrapProgress {
  status: UnwrapStatus;
  message: string;
  gonkaTxHash?: string;
  ethTxHash?: string;
  requestId?: string;
  epochId?: number;
  error?: string;
  elapsedSeconds?: number;
}

export interface UnwrapParams {
  cw20Address: string;
  amount: string;
  destinationEthAddress: string;
  bridgeContractAddress: string;
  tokenContractOnEth: string;
  isGnk?: boolean;
}

interface UnwrapConfig {
  rpcEndpoint: string;
  apiBase: string;
  chainId: string;
  ethereumChainIdHex: string;
  cosmosRestEndpoint?: string;
}

const BRIDGE_ABI = [
  'function withdraw((uint64 epochId, bytes32 requestId, address recipient, address tokenContract, uint256 amount, bytes signature) cmd) external',
  'function mintWithSignature((uint64 epochId, bytes32 requestId, address recipient, uint256 amount, bytes signature) cmd) external',
  'function getCurrentState() view returns (uint8)',
  'function isValidEpoch(uint64 epochId) view returns (bool)',
  'function isRequestProcessed(uint64 epochId, bytes32 requestId) view returns (bool)',
  'function getLatestEpochInfo() view returns (uint64 epochId, uint64 timestamp, bytes groupKey)',
  'function submitGroupKey(uint64 epochId, bytes groupPublicKey, bytes validationSig) external',
];

// Custom self-contained Protobuf encoder for MsgRequestBridgeMint
function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = value >>> 7;
  }
  bytes.push(value);
  return bytes;
}

function encodeStringField(tag: number, value: string): number[] {
  if (!value) return [];
  const encoder = new TextEncoder();
  const stringBytes = encoder.encode(value);
  const tagByte = (tag << 3) | 2;
  const lengthBytes = encodeVarint(stringBytes.length);
  return [tagByte, ...lengthBytes, ...stringBytes];
}

const MsgRequestBridgeMintType = {
  typeUrl: '/inference.inference.MsgRequestBridgeMint',
  create(message: any) {
    return message;
  },
  fromPartial(message: any) {
    return message;
  },
  encode(message: any) {
    const bytes = [
      ...encodeStringField(1, message.creator),
      ...encodeStringField(2, message.amount),
      ...encodeStringField(3, message.destinationAddress || message.destination_address),
      ...encodeStringField(4, message.chainId || message.chain_id),
      ...encodeStringField(5, message.destinationBridgeAddress || message.destination_bridge_address),
    ];
    return {
      finish() {
        return Uint8Array.from(bytes);
      }
    } as any;
  },
  decode() {
    return {};
  }
};

const customRegistry = new Registry([
  ...defaultRegistryTypes,
  ...wasmTypes,
  ['/inference.inference.MsgRequestBridgeMint', MsgRequestBridgeMintType as any]
]);

export interface BridgeEpochStatus {
  bridgeEpoch: number;
  chainEpoch: number;
  isSynced: boolean;
  epochsBehind: number;
  isAdminMode: boolean;
}

export interface EpochBLSData {
  groupPublicKeyHex: string;
  validationSignatureHex: string;
}

const STORAGE_KEY = 'gonka_unwrap_pending';

export async function checkBridgeEpochStatus(
  bridgeAddress: string,
  chainEpoch: number,
  ethereumChainIdHex: string
): Promise<BridgeEpochStatus> {
  const keplr = (window as any).keplr;
  if (!keplr?.ethereum) {
    throw new Error('Keplr EVM provider not available.');
  }

  try {
    await keplr.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: ethereumChainIdHex }],
    });
  } catch (switchError: any) {
    throw new Error(`Failed to switch to Ethereum network: ${switchError.message}`);
  }

  const provider = new ethers.BrowserProvider(keplr.ethereum);
  const contract = new ethers.Contract(bridgeAddress, BRIDGE_ABI, provider);

  const [latestInfo, state] = await Promise.all([
    contract.getLatestEpochInfo(),
    contract.getCurrentState()
  ]);

  const bridgeEpoch = Number(latestInfo.epochId);
  const isAdminMode = Number(state) !== 1;

  return {
    bridgeEpoch,
    chainEpoch,
    isSynced: bridgeEpoch >= chainEpoch,
    epochsBehind: Math.max(0, chainEpoch - bridgeEpoch),
    isAdminMode,
  };
}

export async function fetchEpochBLSData(apiBase: string, epochId: number): Promise<EpochBLSData> {
  const data = await get(`${apiBase}/bls/epochs/${epochId}`);

  const groupKeyBase64 = data.group_public_key_uncompressed_256;
  const valSigBase64 = data.validation_signature_uncompressed_128;

  if (!groupKeyBase64) {
    throw new Error(`Epoch ${epochId} has no group public key`);
  }
  if (!valSigBase64) {
    throw new Error(`Epoch ${epochId} has no validation signature (required for submitGroupKey)`);
  }

  return {
    groupPublicKeyHex: base64ToHex(groupKeyBase64),
    validationSignatureHex: base64ToHex(valSigBase64),
  };
}

export async function ensureEpochOnBridge(
  bridgeAddress: string,
  targetEpochId: number,
  apiBase: string,
  ethereumChainIdHex: string,
  onProgress?: (message: string) => void
): Promise<{ alreadyRegistered: boolean; epochsSubmitted: number }> {
  const keplr = (window as any).keplr;
  if (!keplr?.ethereum) {
    throw new Error('Keplr EVM provider not available.');
  }

  try {
    await keplr.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: ethereumChainIdHex }],
    });
  } catch (switchError: any) {
    throw new Error(`Failed to switch to Ethereum network: ${switchError.message}`);
  }

  const provider = new ethers.BrowserProvider(keplr.ethereum);
  const signer = await provider.getSigner();
  const contract = new ethers.Contract(bridgeAddress, BRIDGE_ABI, signer);

  const isValid = await contract.isValidEpoch(targetEpochId);
  if (isValid) {
    return { alreadyRegistered: true, epochsSubmitted: 0 };
  }

  const latestInfo = await contract.getLatestEpochInfo();
  const latestContractEpoch = Number(latestInfo.epochId);

  let submitted = 0;
  for (let epoch = latestContractEpoch + 1; epoch <= targetEpochId; epoch++) {
    onProgress?.(`Submitting epoch ${epoch}/${targetEpochId}...`);

    const epochData = await fetchEpochBLSData(apiBase, epoch);

    const tx = await contract.submitGroupKey(
      epoch,
      epochData.groupPublicKeyHex,
      epochData.validationSignatureHex
    );
    await tx.wait();
    submitted++;
  }

  return { alreadyRegistered: false, epochsSubmitted: submitted };
}

function base64ToHex(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function useBridgeUnwrap() {
  const progress = ref<UnwrapProgress>({ status: 'idle', message: '' });
  const isRunning = computed(() =>
    progress.value.status !== 'idle' &&
    progress.value.status !== 'completed' &&
    progress.value.status !== 'failed'
  );

  function persistPending(data: { gonkaTxHash: string; requestId: string; epochId: number; params: UnwrapParams }) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch { /* noop */ }
  }

  function clearPending() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* noop */ }
  }

  function loadPending(): { gonkaTxHash: string; requestId: string; epochId: number; params: UnwrapParams } | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  async function executeUnwrap(config: UnwrapConfig, params: UnwrapParams): Promise<void> {
    try {
      progress.value = { status: 'connecting', message: 'Connecting to Keplr...' };

      const keplr = (window as any).keplr;
      if (!keplr) throw new Error('Keplr extension not found. Please install Keplr.');

      await keplr.enable(config.chainId);
      let offlineSigner = keplr.getOfflineSigner(config.chainId);

      // Wrap the signer to ensure standard string accountNumber is used for signDirect compatibility
      if (offlineSigner && typeof offlineSigner.signDirect === 'function') {
        offlineSigner = new Proxy(offlineSigner, {
          get(target, prop, receiver) {
            if (prop === 'signDirect') {
              return async (signerAddress: string, signDoc: any) => {
                const cleanSignDoc = {
                  ...signDoc,
                };
                if (signDoc.accountNumber !== undefined && signDoc.accountNumber !== null) {
                  cleanSignDoc.accountNumber = signDoc.accountNumber.toString();
                }
                return target.signDirect(signerAddress, cleanSignDoc);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }

      const accounts = await offlineSigner.getAccounts();
      const senderAddress = accounts[0].address;

      // Step 1: Wrap GNK or CW20 withdraw on Gonka
      progress.value = { status: 'signing_gonka', message: 'Please approve the unwrap transaction in Keplr...' };

      const client = await SigningCosmWasmClient.connectWithSigner(
        config.rpcEndpoint,
        offlineSigner,
        {
          gasPrice: GasPrice.fromString('0.025ngonka'),
          registry: customRegistry as any
        }
      );

      let result;
      if (params.isGnk) {
        const mintMsg = {
          typeUrl: '/inference.inference.MsgRequestBridgeMint',
          value: {
            creator: senderAddress,
            amount: params.amount,
            destinationAddress: params.destinationEthAddress,
            chainId: 'ethereum',
            destinationBridgeAddress: params.bridgeContractAddress,
          },
        };
        result = await signAndBroadcastWithIndexerFallback(client, senderAddress, [mintMsg], 'auto', '');
      } else {
        const withdrawMsg = {
          withdraw: {
            amount: params.amount,
            destination_bridge_address: params.bridgeContractAddress,
            destination_address: params.destinationEthAddress,
          },
        };
        const executeMsg = {
          typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
          value: {
            sender: senderAddress,
            contract: params.cw20Address,
            msg: new TextEncoder().encode(JSON.stringify(withdrawMsg)),
            funds: [],
          },
        };
        result = await signAndBroadcastWithIndexerFallback(client, senderAddress, [executeMsg], 'auto', '');
      }

      const gonkaTxHash = result.transactionHash;
      let requestId = '';
      let epochId = 0;

      if (result.events) {
        const events = parseUnwrapEvents(result);
        requestId = events.requestId;
        epochId = events.epochId;
      } else {
        // Fallback: lookup from state queries (indexer disabled)
        console.warn('Events not available in result. Attempting fallback lookup from state...');
        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for block commitment
        const resolved = await resolveRequestFromHistory(config.cosmosRestEndpoint || config.apiBase, params.destinationEthAddress, params.amount);
        requestId = resolved.requestId;
        epochId = resolved.epochId;
      }

      persistPending({ gonkaTxHash, requestId, epochId, params });

      progress.value = {
        status: 'waiting_bls',
        message: 'Waiting for validator signatures...',
        gonkaTxHash,
        requestId,
        epochId,
      };

      // Step 2: Poll for BLS signature
      const requestIdHex = toBytes32Hex(requestId);
      const blsResult = await waitForBLSSignature(config.apiBase, requestIdHex, (elapsed) => {
        progress.value = {
          status: 'waiting_bls',
          message: `Waiting for validator signatures... (${elapsed}s)`,
          gonkaTxHash,
          requestId,
          epochId,
          elapsedSeconds: elapsed,
        };
      });

      // Step 3: Ensure epoch is on bridge, then finalize on Ethereum
      progress.value = {
        status: 'signing_ethereum',
        message: 'Checking epoch registration on bridge...',
        gonkaTxHash,
        requestId,
        epochId,
      };

      await ensureEpochOnBridge(
        params.bridgeContractAddress,
        epochId,
        config.apiBase,
        config.ethereumChainIdHex,
        (msg) => {
          progress.value = {
            status: 'signing_ethereum',
            message: msg,
            gonkaTxHash,
            requestId,
            epochId,
          };
        }
      );

      progress.value = {
        status: 'signing_ethereum',
        message: 'Please approve the withdrawal transaction in Keplr...',
        gonkaTxHash,
        requestId,
        epochId,
      };

      const receipt = await finalizeWithdrawalOnEthereum(config.ethereumChainIdHex, {
        bridgeAddress: params.bridgeContractAddress,
        epochId,
        requestId: requestIdHex,
        recipient: params.destinationEthAddress,
        tokenContract: params.tokenContractOnEth,
        amount: params.amount,
        signature: blsResult.signature128Hex,
        isGnk: params.isGnk,
      });

      clearPending();

      progress.value = {
        status: 'completed',
        message: 'Unwrap complete! Tokens are now on Ethereum.',
        gonkaTxHash,
        ethTxHash: receipt.hash,
        requestId,
        epochId,
      };
    } catch (error: any) {
      progress.value = {
        status: 'failed',
        message: error.message || 'Unknown error during unwrap',
        error: error.message,
        gonkaTxHash: progress.value.gonkaTxHash,
        requestId: progress.value.requestId,
        epochId: progress.value.epochId,
      };
      throw error;
    }
  }

  async function resumeUnwrap(config: UnwrapConfig): Promise<void> {
    const pending = loadPending();
    if (!pending) return;

    try {
      const requestIdHex = toBytes32Hex(pending.requestId);

      progress.value = {
        status: 'waiting_bls',
        message: 'Resuming... waiting for validator signatures...',
        gonkaTxHash: pending.gonkaTxHash,
        requestId: pending.requestId,
        epochId: pending.epochId,
      };

      const blsResult = await waitForBLSSignature(config.apiBase, requestIdHex, (elapsed) => {
        progress.value = {
          ...progress.value,
          message: `Waiting for validator signatures... (${elapsed}s)`,
          elapsedSeconds: elapsed,
        };
      });

      progress.value = {
        status: 'signing_ethereum',
        message: 'Checking epoch registration on bridge...',
        gonkaTxHash: pending.gonkaTxHash,
        requestId: pending.requestId,
        epochId: pending.epochId,
      };

      await ensureEpochOnBridge(
        pending.params.bridgeContractAddress,
        pending.epochId,
        config.apiBase,
        config.ethereumChainIdHex,
        (msg) => {
          progress.value = {
            ...progress.value,
            message: msg,
          };
        }
      );

      progress.value = {
        status: 'signing_ethereum',
        message: 'Please approve the withdrawal transaction in Keplr...',
        gonkaTxHash: pending.gonkaTxHash,
        requestId: pending.requestId,
        epochId: pending.epochId,
      };

      const receipt = await finalizeWithdrawalOnEthereum(config.ethereumChainIdHex, {
        bridgeAddress: pending.params.bridgeContractAddress,
        epochId: pending.epochId,
        requestId: requestIdHex,
        recipient: pending.params.destinationEthAddress,
        tokenContract: pending.params.tokenContractOnEth,
        amount: pending.params.amount,
        signature: blsResult.signature128Hex,
        isGnk: pending.params.isGnk,
      });

      clearPending();

      progress.value = {
        status: 'completed',
        message: 'Unwrap complete! Tokens are now on Ethereum.',
        gonkaTxHash: pending.gonkaTxHash,
        ethTxHash: receipt.hash,
        requestId: pending.requestId,
        epochId: pending.epochId,
      };
    } catch (error: any) {
      progress.value = {
        status: 'failed',
        message: error.message || 'Unknown error during resume',
        error: error.message,
        gonkaTxHash: pending.gonkaTxHash,
        requestId: pending.requestId,
        epochId: pending.epochId,
      };
      throw error;
    }
  }

  function reset() {
    progress.value = { status: 'idle', message: '' };
  }

  return {
    progress,
    isRunning,
    executeUnwrap,
    resumeUnwrap,
    loadPending,
    clearPending,
    reset,
  };
}

// --- Internal helpers ---

function parseUnwrapEvents(result: any): { requestId: string; epochId: number } {
  const blsEvent = result.events?.find(
    (e: any) =>
      e.type === 'inference.bls.EventThresholdSigningRequested' ||
      e.type?.includes('EventThresholdSigningRequested')
  );

  if (!blsEvent) {
    throw new Error(
      'BLS signing request event not found in transaction. ' +
      'Events: ' + (result.events?.map((e: any) => e.type).join(', ') || 'none')
    );
  }

  const getAttr = (key: string): string => {
    const attr = blsEvent.attributes?.find((a: any) => a.key === key);
    if (!attr) throw new Error(`Missing event attribute: ${key}`);
    return attr.value.replace(/^"|"$/g, '');
  };

  return {
    requestId: getAttr('request_id'),
    epochId: parseInt(getAttr('current_epoch_id'), 10),
  };
}

async function waitForBLSSignature(
  apiBase: string,
  requestIdHex: string,
  onProgress: (elapsedSeconds: number) => void
): Promise<{ signature128Hex: string }> {
  const pollInterval = 5000;
  const timeout = 180000;
  const startTime = Date.now();
  const cleanId = requestIdHex.replace(/^0x/, '');

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeout) {
      throw new Error(
        `BLS signature timeout after ${timeout / 1000}s. Request ID: ${cleanId}. The signing may still complete — retry later.`
      );
    }

    const data = await get(`${apiBase}/bls/signatures/${cleanId}`);
    const status = data.signing_request?.status ?? 'UNKNOWN';

    onProgress(Math.round(elapsed / 1000));

    if (status === 3 || status === '3' || status === 'THRESHOLD_SIGNING_STATUS_COMPLETED') {
      const sigBase64 = data.uncompressed_signature_128;
      if (!sigBase64) {
        throw new Error('Signature completed but uncompressed_signature_128 is missing');
      }

      const sigBytes = Uint8Array.from(atob(sigBase64), c => c.charCodeAt(0));
      const sigHex = '0x' + Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('');

      if (sigBytes.length !== 128) {
        throw new Error(`Expected 128-byte signature, got ${sigBytes.length} bytes`);
      }

      return { signature128Hex: sigHex };
    }

    if (status === 4 || status === '4' || status === 'THRESHOLD_SIGNING_STATUS_FAILED') {
      throw new Error('BLS threshold signing failed. The operation may need to be retried.');
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }
}

interface FinalizeParams {
  bridgeAddress: string;
  epochId: number;
  requestId: string;
  recipient: string;
  tokenContract: string;
  amount: string;
  signature: string;
  isGnk?: boolean;
}

async function finalizeWithdrawalOnEthereum(
  ethereumChainIdHex: string,
  params: FinalizeParams
): Promise<ethers.TransactionReceipt> {
  const keplr = (window as any).keplr;
  if (!keplr?.ethereum) {
    throw new Error('Keplr EVM provider not available. Update Keplr to latest version.');
  }

  try {
    await keplr.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: ethereumChainIdHex }],
    });
  } catch (switchError: any) {
    throw new Error(`Failed to switch to Ethereum network: ${switchError.message}`);
  }

  const provider = new ethers.BrowserProvider(keplr.ethereum);
  const signer = await provider.getSigner();

  const contract = new ethers.Contract(params.bridgeAddress, BRIDGE_ABI, signer);

  const state = await contract.getCurrentState();
  if (state !== 1n) {
    throw new Error(`Bridge not in NORMAL_OPERATION (state=${state}). Cannot finalize.`);
  }

  const epochValid = await contract.isValidEpoch(params.epochId);
  if (!epochValid) {
    throw new Error(`Epoch ${params.epochId} not recognized by bridge contract. Please update the bridge first.`);
  }

  const alreadyProcessed = await contract.isRequestProcessed(params.epochId, params.requestId);
  if (alreadyProcessed) {
    throw new Error('Request already processed. Tokens may have already been withdrawn.');
  }

  let tx;
  if (params.isGnk) {
    const cmd = {
      epochId: params.epochId,
      requestId: params.requestId,
      recipient: params.recipient,
      amount: params.amount,
      signature: params.signature,
    };
    tx = await contract.mintWithSignature(cmd);
  } else {
    const cmd = {
      epochId: params.epochId,
      requestId: params.requestId,
      recipient: params.recipient,
      tokenContract: params.tokenContract,
      amount: params.amount,
      signature: params.signature,
    };
    tx = await contract.withdraw(cmd);
  }

  const receipt = await tx.wait();

  if (!receipt || receipt.status === 0) {
    throw new Error('Transaction reverted on-chain');
  }

  return receipt;
}

function toBytes32Hex(requestId: string): string {
  if (requestId.startsWith('0x') && requestId.length === 66) {
    return requestId;
  }
  if (/^[0-9a-fA-F]{64}$/.test(requestId)) {
    return '0x' + requestId;
  }
  // Try to decode if it is base64 encoded 32 bytes (which is 44 characters)
  try {
    const decoded = atob(requestId);
    if (decoded.length === 32) {
      const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
      return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) {
    // Fallback if not valid base64
  }
  const encoder = new TextEncoder();
  const data = encoder.encode(requestId);
  return ethers.keccak256(data);
}

async function resolveRequestFromHistory(
  cosmosRestEndpoint: string,
  recipientEthAddress: string,
  amount: string
): Promise<{ requestId: string; epochId: number }> {
  const recipientHex = recipientEthAddress.toLowerCase().replace(/^0x/, '');
  const bytes = new Uint8Array(recipientHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(recipientHex.substr(i * 2, 2), 16);
  }
  const recipientB64 = btoa(String.fromCharCode(...Array.from(bytes)));

  // Fetch the signing history from the REST API
  const res = await get(`${cosmosRestEndpoint}/productscience/inference/bls/signing_history?pagination.limit=100&pagination.reverse=true`);
  const requests = res.signing_requests || [];

  // Filter requests that contain the recipient base64 in data
  const matches = requests.filter((r: any) => {
    return r.data && r.data.some((d: string) => d === recipientB64);
  });

  if (matches.length === 0) {
    throw new Error('Could not find the bridge request in signing history. Please try again.');
  }

  // Sort by created_block_height descending
  matches.sort((a: any, b: any) => {
    const heightA = parseInt(a.created_block_height || '0', 10);
    const heightB = parseInt(b.created_block_height || '0', 10);
    return heightB - heightA;
  });

  const matched = matches[0];
  
  // Convert request_id base64 to hex
  const reqIdBytes = Uint8Array.from(atob(matched.request_id), c => c.charCodeAt(0));
  const reqIdHex = Array.from(reqIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    requestId: reqIdHex,
    epochId: parseInt(matched.current_epoch_id, 10),
  };
}

async function signAndBroadcastWithIndexerFallback(
  client: SigningCosmWasmClient,
  senderAddress: string,
  messages: readonly any[],
  fee: any,
  memo = ""
): Promise<{ transactionHash: string; events?: readonly any[]; rawLog?: string }> {
  const resolvedFee = await resolveFeeForManualBroadcast(client, senderAddress, messages, fee, memo);
  const txRaw = await client.sign(senderAddress, messages, resolvedFee, memo);
  const { TxRaw } = await import('cosmjs-types/cosmos/tx/v1beta1/tx');
  const txBytes = TxRaw.encode(txRaw).finish();
  const txHash = toHex(sha256(txBytes)).toUpperCase();

  try {
    const result = await client.broadcastTx(txBytes);
    return result;
  } catch (broadcastError: any) {
    const errMsg = String(broadcastError?.message || broadcastError);
    if (errMsg.includes('transaction indexing is disabled')) {
      console.warn('Transaction indexing is disabled on this RPC node. Returning fallback broadcast result:', txHash);
      return {
        transactionHash: txHash,
        rawLog: 'Broadcasted successfully (indexer disabled)'
      };
    }
    throw broadcastError;
  }
}

async function resolveFeeForManualBroadcast(
  client: SigningCosmWasmClient,
  senderAddress: string,
  messages: readonly any[],
  fee: any,
  memo: string
) {
  if (fee !== 'auto' && typeof fee !== 'number') {
    return fee;
  }

  const internalFeeResolver = (client as any).calculateFeeForTransaction;
  if (typeof internalFeeResolver === 'function') {
    return internalFeeResolver.call(client, senderAddress, messages, memo, fee);
  }

  const gasEstimation = await client.simulate(senderAddress, messages, memo);
  const multiplier = typeof fee === 'number' ? fee : 1.4;
  const gasLimit = Math.ceil(gasEstimation * multiplier);
  const gasPrice = (client as any).gasPrice;

  if (!gasPrice) {
    throw new Error('Gas price must be set in the client options when auto gas is used.');
  }

  return calculateFee(gasLimit, gasPrice);
}

export async function scanForUncompletedTransaction(
  cosmosRestEndpoint: string,
  recipientEthAddress: string,
  bridgeContractAddress: string,
  withdrawableTokens: any[]
): Promise<{ gonkaTxHash: string; requestId: string; epochId: number; params: UnwrapParams } | null> {
  try {
    const recipientHex = recipientEthAddress.toLowerCase().replace(/^0x/, '');
    const bytes = new Uint8Array(recipientHex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(recipientHex.substr(i * 2, 2), 16);
    }
    const recipientB64 = btoa(String.fromCharCode(...Array.from(bytes)));

    // Fetch history
    const res = await get(`${cosmosRestEndpoint}/productscience/inference/bls/signing_history?pagination.limit=100&pagination.reverse=true`);
    const requests = res.signing_requests || [];

    // Filter requests matching recipient base64
    const matches = requests.filter((r: any) => {
      return r.data && r.data.some((d: string) => d === recipientB64);
    });

    if (matches.length === 0) return null;

    // Check if any match is NOT completed on Ethereum yet
    const keplr = (window as any).keplr;
    if (!keplr?.ethereum) return null;

    const provider = new ethers.BrowserProvider(keplr.ethereum);
    // We only connect as a read-only provider (no switch chain needed to query)
    const abi = [
      'function isRequestProcessed(uint64 epochId, bytes32 requestId) view returns (bool)'
    ];

    for (const matched of matches) {
      const epochId = parseInt(matched.current_epoch_id, 10);
      
      // Convert request_id base64 to hex
      const reqIdBytes = Uint8Array.from(atob(matched.request_id), c => c.charCodeAt(0));
      const reqIdHex = '0x' + Array.from(reqIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');

      try {
        const contract = new ethers.Contract(bridgeContractAddress, abi, provider);
        const processed = await contract.isRequestProcessed(epochId, reqIdHex);
        
        if (!processed) {
          // Found an unprocessed transaction! Reconstruct metadata.
          const isGnk = matched.data.length === 5; // mint has 5 fields, withdraw has 6 fields

          // Decode amount
          const amtBytes = Uint8Array.from(atob(matched.data[matched.data.length - 1]), c => c.charCodeAt(0));
          const amtHex = Array.from(amtBytes).map(b => b.toString(16).padStart(2, '0')).join('');
          const amount = BigInt('0x' + amtHex).toString();

          let tokenContractOnEth = '';
          let cw20Address = '';

          if (!isGnk && matched.data[4]) {
            const tokenBytes = Uint8Array.from(atob(matched.data[4]), c => c.charCodeAt(0));
            tokenContractOnEth = '0x' + Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
            
            // Match to withdrawable tokens
            const matchToken = withdrawableTokens.find(t => 
              t.token_info?.contractAddress?.toLowerCase() === tokenContractOnEth.toLowerCase()
            );
            if (matchToken) {
              cw20Address = matchToken.contractAddress || '';
            }
          }

          return {
            gonkaTxHash: reqIdHex, // Use request ID as placeholder for tx hash
            requestId: reqIdHex.replace(/^0x/, ''),
            epochId,
            params: {
              cw20Address,
              amount,
              destinationEthAddress: recipientEthAddress,
              bridgeContractAddress,
              tokenContractOnEth,
              isGnk
            }
          };
        }
      } catch (err) {
        console.error('Error checking isRequestProcessed on bridge contract:', err);
      }
    }
    return null;
  } catch (e) {
    console.error('Error during auto-scan:', e);
    return null;
  }
}
