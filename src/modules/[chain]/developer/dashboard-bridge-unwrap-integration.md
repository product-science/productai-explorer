# Dashboard Bridge Unwrap Integration

## Overview

This document describes how the web dashboard implements automatic unwrapping of wrapped tokens (Gonka → Ethereum) using **Keplr** as the single wallet for both Cosmos and EVM signing.

### Flow Summary

```
┌──────────────┐      ┌──────────────┐      ┌──────────────────┐
│  Dashboard   │      │  Gonka Chain │      │  Ethereum Chain  │
│   (Browser)  │      │   (Cosmos)   │      │   (Sepolia/L1)   │
└──────┬───────┘      └──────┬───────┘      └────────┬─────────┘
       │                     │                       │
       │ 1. CW20 withdraw   │                       │
       │────────────────────>│                       │
       │   (Keplr Cosmos)    │                       │
       │                     │                       │
       │ 2. Poll BLS sig     │                       │
       │<───────────────────>│                       │
       │                     │                       │
       │ 3. submitGroupKey() │                       │
       │───────────────────────────────────────────── (if epoch missing)
       │   (Keplr EVM)       │                       │
       │                     │                       │
       │ 4. withdraw() call  │                       │
       │─────────────────────────────────────────────>
       │   (Keplr EVM)       │                       │
       │                     │                       │
       │ 5. Tokens released  │                       │
       │<─────────────────────────────────────────────
       │                     │                       │
```

**User signs via Keplr** — once on Cosmos, and 1-2 times on EVM (epoch sync if needed + withdrawal).

---

## Prerequisites

### NPM Dependencies

```json
{
  "@cosmjs/cosmwasm-stargate": "^0.32.0",
  "@cosmjs/stargate": "^0.32.0",
  "ethers": "^6.0.0"
}
```

### Keplr Requirements

- Keplr browser extension installed
- Gonka chain added to Keplr (via `experimentalSuggestChain`)
- Ethereum/Sepolia added to Keplr for EVM signing

### API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/bridge/addresses?chain=ethereum` | GET | Retrieve registered bridge contract address |
| `/v1/bls/signatures/:request_id` | GET | Poll BLS threshold signature status |

---

## Step 1: Suggest Chains to Keplr

Before any operations, ensure both Gonka and Ethereum/Sepolia are registered in Keplr.

```typescript
// Gonka chain config for Keplr
const gonkaChainConfig = {
  chainId: "gonka-testnet",
  chainName: "Gonka Testnet",
  rpc: "https://your-gonka-rpc-endpoint/",
  rest: "https://your-gonka-api-endpoint/",
  bip44: { coinType: 118 },
  bech32Config: {
    bech32PrefixAccAddr: "gonka",
    bech32PrefixAccPub: "gonkapub",
    bech32PrefixValAddr: "gonkavaloper",
    bech32PrefixValPub: "gonkavaloperpub",
    bech32PrefixConsAddr: "gonkavalcons",
    bech32PrefixConsPub: "gonkavalconspub",
  },
  currencies: [
    { coinDenom: "GNK", coinMinimalDenom: "ngonka", coinDecimals: 9 },
  ],
  feeCurrencies: [
    {
      coinDenom: "GNK",
      coinMinimalDenom: "ngonka",
      coinDecimals: 9,
      gasPriceStep: { low: 0.01, average: 0.025, high: 0.04 },
    },
  ],
  stakeCurrency: {
    coinDenom: "GNK",
    coinMinimalDenom: "ngonka",
    coinDecimals: 9,
  },
};

async function setupKeplr() {
  if (!window.keplr) {
    throw new Error("Keplr extension not found. Please install Keplr.");
  }

  // Register Gonka chain
  await window.keplr.experimentalSuggestChain(gonkaChainConfig);

  // For Sepolia EVM support — Keplr auto-supports major EVM chains,
  // but you may need to add Sepolia explicitly if not already present.
}
```

---

## Step 2: Submit CW20 Withdraw on Gonka (Keplr Cosmos Signer)

This step locks/burns the wrapped tokens on Gonka and initiates the BLS threshold signing process.

### Message Format

The wrapped token contract expects this execute message:

```json
{
  "withdraw": {
    "amount": "1000000",
    "destination_bridge_address": "0xBridgeContractAddress",
    "destination_address": "0xUserEthereumAddress"
  }
}
```

### Implementation

```typescript
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { GasPrice } from "@cosmjs/stargate";

interface UnwrapParams {
  cw20Address: string;          // Wrapped token contract on Gonka (gonka1...)
  amount: string;               // Amount in base units (e.g., "1000000" for 1 USDC)
  destinationEthAddress: string; // User's Ethereum address (0x...)
  bridgeContractAddress: string; // Ethereum bridge contract (0x...)
}

interface UnwrapResult {
  transactionHash: string;
  requestId: string;            // BLS request ID (hex) for polling
  epochId: number;
}

async function submitUnwrapOnGonka(params: UnwrapParams): Promise<UnwrapResult> {
  const chainId = "gonka-testnet";
  const rpcEndpoint = "https://your-gonka-rpc-endpoint/";

  // 1. Connect Keplr for Cosmos signing
  await window.keplr.enable(chainId);
  const offlineSigner = window.keplr.getOfflineSigner(chainId);
  const accounts = await offlineSigner.getAccounts();
  const senderAddress = accounts[0].address;

  // 2. Create CosmWasm signing client
  const client = await SigningCosmWasmClient.connectWithSigner(
    rpcEndpoint,
    offlineSigner,
    { gasPrice: GasPrice.fromString("0.025ngonka") }
  );

  // 3. Build and execute the withdraw message
  const withdrawMsg = {
    withdraw: {
      amount: params.amount,
      destination_bridge_address: params.bridgeContractAddress,
      destination_address: params.destinationEthAddress,
    },
  };

  const result = await client.execute(
    senderAddress,
    params.cw20Address,
    withdrawMsg,
    "auto",  // auto gas estimation
    "",      // memo
    []       // no funds attached (CW20 tokens are handled by the contract)
  );

  // 4. Extract BLS request ID and epoch from tx events
  const { requestId, epochId } = parseUnwrapEvents(result);

  return {
    transactionHash: result.transactionHash,
    requestId,
    epochId,
  };
}

function parseUnwrapEvents(result: any): { requestId: string; epochId: number } {
  // Look for the BLS threshold signing request event
  const blsEvent = result.events?.find(
    (e: any) =>
      e.type === "inference.bls.EventThresholdSigningRequested" ||
      e.type?.includes("EventThresholdSigningRequested")
  );

  if (!blsEvent) {
    throw new Error(
      "BLS signing request event not found in transaction. " +
      "Events: " + (result.events?.map((e: any) => e.type).join(", ") || "none")
    );
  }

  const getAttr = (key: string): string => {
    const attr = blsEvent.attributes?.find((a: any) => a.key === key);
    if (!attr) throw new Error(`Missing event attribute: ${key}`);
    return attr.value.replace(/^"|"$/g, "");
  };

  return {
    requestId: getAttr("request_id"),
    epochId: parseInt(getAttr("current_epoch_id"), 10),
  };
}
```

---

## Step 3: Poll for BLS Signature Completion

After the Gonka transaction is confirmed, the validator set performs threshold BLS signing. This typically completes within 30-60 seconds.

### API Response Format

```json
{
  "signing_request": {
    "request_id": "...",
    "status": "THRESHOLD_SIGNING_STATUS_COMPLETED",
    "final_signature": "base64-encoded-48-bytes"
  },
  "uncompressed_signature_128": "base64-encoded-128-bytes"
}
```

### Implementation

```typescript
interface BLSSignatureResult {
  signature128Hex: string;  // 128-byte uncompressed G1 signature (hex)
  status: string;
}

async function waitForBLSSignature(
  apiBase: string,
  requestIdHex: string,
  options?: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: (status: string, elapsed: number) => void;
  }
): Promise<BLSSignatureResult> {
  const pollInterval = options?.pollIntervalMs ?? 5000;
  const timeout = options?.timeoutMs ?? 120000; // 2 minutes default
  const startTime = Date.now();

  // Strip 0x prefix if present
  const cleanId = requestIdHex.replace(/^0x/, "");

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeout) {
      throw new Error(
        `BLS signature timeout after ${timeout / 1000}s. ` +
        `Request ID: ${cleanId}. The signing may still complete — retry later.`
      );
    }

    const res = await fetch(`${apiBase}/bls/signatures/${cleanId}`);
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const status = data.signing_request?.status ?? "UNKNOWN";

    options?.onProgress?.(status, elapsed);

    if (status === "THRESHOLD_SIGNING_STATUS_COMPLETED") {
      const sigBase64 = data.uncompressed_signature_128;
      if (!sigBase64) {
        throw new Error("Signature completed but uncompressed_signature_128 is missing");
      }

      // Convert base64 to hex
      const sigBytes = Uint8Array.from(atob(sigBase64), c => c.charCodeAt(0));
      const sigHex = "0x" + Array.from(sigBytes).map(b => b.toString(16).padStart(2, "0")).join("");

      if (sigBytes.length !== 128) {
        throw new Error(`Expected 128-byte signature, got ${sigBytes.length} bytes`);
      }

      return { signature128Hex: sigHex, status };
    }

    if (status === "THRESHOLD_SIGNING_STATUS_FAILED") {
      throw new Error("BLS threshold signing failed. The operation may need to be retried.");
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }
}
```

---

## Step 3b: Ensure Epoch is Registered on Bridge Contract

The Ethereum bridge contract must have the BLS group public key for the epoch that signed the withdrawal. If the epoch is not registered, `withdraw()` will revert with `InvalidEpoch()`.

### Background: How Epochs Reach the Bridge Contract

Each Gonka epoch produces a BLS group public key. The bridge contract stores these keys and uses them to verify BLS signatures. Keys are submitted via:

1. **`setGroupKey(epochId, groupPublicKey)`** — Admin-only, used for initial setup (ADMIN_CONTROL state)
2. **`submitGroupKey(epochId, groupPublicKey, validationSig)`** — Public, used during NORMAL_OPERATION; requires a validation signature from the *previous* epoch's key

Currently, epoch syncing is performed by an operator script (`bridge-enable-normal-op.js`). For the dashboard, this should be automated.

### API Endpoints for Epoch Data

| Endpoint | Returns |
|----------|---------|
| `GET /v1/bls/epochs/:id` | Group public key (uncompressed 256 bytes) + validation signature (uncompressed 128 bytes) |
| `GET /v1/epochs/latest` | Current epoch index on Gonka |

The `/v1/bls/epochs/:id` endpoint returns:

```json
{
  "epoch_data": {
    "epoch_id": 42,
    "group_public_key": "base64...",
    "validation_signature": "base64..."
  },
  "group_public_key_uncompressed_256": "base64-256-bytes",
  "validation_signature_uncompressed_128": "base64-128-bytes"
}
```

### Implementation: Check & Submit Epoch

Before calling `withdraw()`, the dashboard should verify the epoch exists on the contract and submit it if missing.

```typescript
import { ethers } from "ethers";

interface EpochSyncResult {
  alreadyRegistered: boolean;
  txHash?: string;
}

async function ensureEpochOnBridge(
  provider: ethers.BrowserProvider,
  signer: ethers.Signer,
  bridgeAddress: string,
  epochId: number,
  apiBase: string
): Promise<EpochSyncResult> {
  const abi = [
    "function isValidEpoch(uint64 epochId) view returns (bool)",
    "function getLatestEpochInfo() view returns (uint64 epochId, uint64 timestamp, bytes groupKey)",
    "function submitGroupKey(uint64 epochId, bytes groupPublicKey, bytes validationSig) external",
  ];
  const contract = new ethers.Contract(bridgeAddress, abi, signer);

  // Check if epoch already registered
  const isValid = await contract.isValidEpoch(epochId);
  if (isValid) {
    return { alreadyRegistered: true };
  }

  // Get latest epoch on the contract
  const latestInfo = await contract.getLatestEpochInfo();
  const latestContractEpoch = Number(latestInfo.epochId);

  // Submit all missing epochs sequentially (must be sequential for validation chain)
  for (let epoch = latestContractEpoch + 1; epoch <= epochId; epoch++) {
    const epochData = await fetchEpochBLSData(apiBase, epoch);

    const tx = await contract.submitGroupKey(
      epoch,
      epochData.groupPublicKeyHex,    // 0x-prefixed 256 bytes
      epochData.validationSignatureHex // 0x-prefixed 128 bytes
    );
    await tx.wait();
  }

  return { alreadyRegistered: false, txHash: "submitted" };
}

interface EpochBLSData {
  groupPublicKeyHex: string;       // 0x-prefixed, 256 bytes (uncompressed G2)
  validationSignatureHex: string;  // 0x-prefixed, 128 bytes (uncompressed G1)
}

async function fetchEpochBLSData(apiBase: string, epochId: number): Promise<EpochBLSData> {
  const res = await fetch(`${apiBase}/bls/epochs/${epochId}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch epoch ${epochId} BLS data: ${res.status}`);
  }

  const data = await res.json();

  // The API returns base64-encoded uncompressed keys
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

function base64ToHex(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
```

### Who Pays Gas for Epoch Submission?

`submitGroupKey()` is a public function — anyone can call it. Options:

| Approach | Pros | Cons |
|----------|------|------|
| **Dashboard user submits** | Decentralized, no backend needed | User pays extra ETH gas for epoch sync |
| **Backend cron job** | User never sees epoch gaps | Requires funded operator wallet |
| **Hybrid** | Backend keeps epochs synced; dashboard submits only if backend missed one | Best UX with fallback |

**Recommended**: Run a backend cron (or validator-side script) that submits epochs to the bridge contract every epoch (~24h). The dashboard should still check `isValidEpoch()` and handle the gap as a fallback, but under normal operation the epoch will already be there.

### Cost Consideration

Each `submitGroupKey()` call costs approximately 100-150k gas on Ethereum (writing 256 bytes of group key data + validation). At typical gas prices:
- Sepolia: negligible (testnet)
- Mainnet: ~$5-15 per epoch submission depending on gas prices

Since epochs are ~24h, this is a manageable operational cost.

---

## Step 4: Finalize Withdrawal on Ethereum (Keplr EVM Signer)

Call the `withdraw()` function on the Ethereum `BridgeContract` using the BLS signature obtained in Step 3. Keplr's EVM provider (`window.keplr.ethereum`) handles the signing.

### Bridge Contract ABI (relevant subset)

```json
[
  "function withdraw((uint64 epochId, bytes32 requestId, address recipient, address tokenContract, uint256 amount, bytes signature) cmd) external",
  "function getCurrentState() view returns (uint8)",
  "function isValidEpoch(uint64 epochId) view returns (bool)",
  "function isRequestProcessed(uint64 epochId, bytes32 requestId) view returns (bool)"
]
```

### Implementation

```typescript
import { ethers } from "ethers";

interface FinalizeParams {
  bridgeAddress: string;     // Ethereum bridge contract address
  epochId: number;
  requestId: string;         // 0x-prefixed bytes32 (keccak256 of request ID string)
  recipient: string;         // Ethereum address to receive tokens
  tokenContract: string;     // Original ERC20 token address on Ethereum
  amount: string;            // Amount in base units
  signature: string;         // 0x-prefixed 128-byte BLS signature
}

async function finalizeWithdrawalOnEthereum(params: FinalizeParams): Promise<ethers.TransactionReceipt> {
  // 1. Get Keplr's EVM provider
  if (!window.keplr?.ethereum) {
    throw new Error("Keplr EVM provider not available. Update Keplr to latest version.");
  }

  // 2. Switch to the correct Ethereum network
  const sepoliaChainId = "0xaa36a7";   // 11155111 in hex
  // const mainnetChainId = "0x1";     // For production

  try {
    await window.keplr.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: sepoliaChainId }],
    });
  } catch (switchError: any) {
    // If chain not added, you could add it here with wallet_addEthereumChain
    throw new Error(`Failed to switch to Sepolia: ${switchError.message}`);
  }

  // 3. Create ethers provider and signer from Keplr
  const provider = new ethers.BrowserProvider(window.keplr.ethereum);
  const signer = await provider.getSigner();
  const signerAddress = await signer.getAddress();

  console.log(`Finalizing withdrawal from: ${signerAddress}`);

  // 4. Connect to bridge contract
  const abi = [
    "function withdraw((uint64 epochId, bytes32 requestId, address recipient, address tokenContract, uint256 amount, bytes signature) cmd) external",
    "function getCurrentState() view returns (uint8)",
    "function isValidEpoch(uint64 epochId) view returns (bool)",
    "function isRequestProcessed(uint64 epochId, bytes32 requestId) view returns (bool)",
  ];
  const contract = new ethers.Contract(params.bridgeAddress, abi, signer);

  // 5. Pre-flight checks
  const state = await contract.getCurrentState();
  if (state !== 1n) {
    throw new Error(`Bridge not in NORMAL_OPERATION (state=${state}). Cannot finalize.`);
  }

  // 5b. Ensure epoch is registered (submit if missing — see Step 3b)
  const epochValid = await contract.isValidEpoch(params.epochId);
  if (!epochValid) {
    // Attempt to sync missing epochs automatically
    await ensureEpochOnBridge(provider, signer, params.bridgeAddress, params.epochId, apiBase);
    
    // Re-check after sync attempt
    const epochValidAfterSync = await contract.isValidEpoch(params.epochId);
    if (!epochValidAfterSync) {
      throw new Error(`Epoch ${params.epochId} could not be registered on bridge contract.`);
    }
  }

  const alreadyProcessed = await contract.isRequestProcessed(params.epochId, params.requestId);
  if (alreadyProcessed) {
    throw new Error(`Request already processed. Tokens may have already been withdrawn.`);
  }

  // 6. Submit withdrawal transaction
  const cmd = {
    epochId: params.epochId,
    requestId: params.requestId,
    recipient: params.recipient,
    tokenContract: params.tokenContract,
    amount: params.amount,
    signature: params.signature,
  };

  const tx = await contract.withdraw(cmd);
  console.log(`Withdrawal tx submitted: ${tx.hash}`);

  const receipt = await tx.wait();
  if (!receipt || receipt.status === 0) {
    throw new Error("Transaction reverted on-chain");
  }

  return receipt;
}
```

---

## Step 5: Complete End-to-End Flow

Combine all steps into a single orchestrator function for the dashboard.

```typescript
interface UnwrapFlowConfig {
  gonkaRpcEndpoint: string;
  gonkaApiBase: string;          // e.g., "https://your-api/v1"
  gonkaChainId: string;          // e.g., "gonka-testnet"
  ethereumChainIdHex: string;    // e.g., "0xaa36a7" (Sepolia)
}

interface UnwrapRequest {
  cw20Address: string;           // Wrapped token contract on Gonka
  amount: string;                // Amount in base units
  destinationEthAddress: string; // User's Ethereum address
  bridgeContractAddress: string; // Ethereum bridge contract
  tokenContractOnEth: string;    // Original ERC20 address on Ethereum
}

type UnwrapStatus =
  | "connecting"
  | "signing_gonka"
  | "waiting_bls"
  | "signing_ethereum"
  | "completed"
  | "failed";

interface UnwrapProgress {
  status: UnwrapStatus;
  message: string;
  gonkaTxHash?: string;
  ethTxHash?: string;
  error?: string;
}

async function executeUnwrap(
  config: UnwrapFlowConfig,
  request: UnwrapRequest,
  onProgress: (progress: UnwrapProgress) => void
): Promise<void> {
  try {
    // ── Step 1: Submit on Gonka ──────────────────────────────────────────
    onProgress({ status: "connecting", message: "Connecting to Keplr..." });

    await window.keplr.enable(config.gonkaChainId);

    onProgress({ status: "signing_gonka", message: "Please approve the unwrap transaction in Keplr..." });

    const unwrapResult = await submitUnwrapOnGonka({
      cw20Address: request.cw20Address,
      amount: request.amount,
      destinationEthAddress: request.destinationEthAddress,
      bridgeContractAddress: request.bridgeContractAddress,
    });

    onProgress({
      status: "waiting_bls",
      message: "Waiting for validator signatures...",
      gonkaTxHash: unwrapResult.transactionHash,
    });

    // ── Step 2: Wait for BLS Signature ───────────────────────────────────
    const requestIdHex = toBytes32Hex(unwrapResult.requestId);

    const blsResult = await waitForBLSSignature(
      config.gonkaApiBase,
      requestIdHex,
      {
        pollIntervalMs: 5000,
        timeoutMs: 180000,  // 3 minutes
        onProgress: (status, elapsed) => {
          const seconds = Math.round(elapsed / 1000);
          onProgress({
            status: "waiting_bls",
            message: `Waiting for validator signatures... (${seconds}s)`,
            gonkaTxHash: unwrapResult.transactionHash,
          });
        },
      }
    );

    // ── Step 3: Ensure epoch is on bridge contract ─────────────────────
    onProgress({
      status: "signing_ethereum",
      message: "Checking epoch registration on Ethereum bridge...",
      gonkaTxHash: unwrapResult.transactionHash,
    });

    // Connect Keplr EVM and ensure the epoch key is on the contract.
    // If missing, this will submit the epoch (user signs additional tx(s)).
    await window.keplr.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: config.ethereumChainIdHex }],
    });
    const ethProvider = new ethers.BrowserProvider(window.keplr.ethereum);
    const ethSigner = await ethProvider.getSigner();

    await ensureEpochOnBridge(
      ethProvider,
      ethSigner,
      request.bridgeContractAddress,
      unwrapResult.epochId,
      config.gonkaApiBase
    );

    // ── Step 4: Finalize withdrawal on Ethereum ──────────────────────────
    onProgress({
      status: "signing_ethereum",
      message: "Please approve the withdrawal transaction in Keplr...",
      gonkaTxHash: unwrapResult.transactionHash,
    });

    const receipt = await finalizeWithdrawalOnEthereum({
      bridgeAddress: request.bridgeContractAddress,
      epochId: unwrapResult.epochId,
      requestId: requestIdHex,
      recipient: request.destinationEthAddress,
      tokenContract: request.tokenContractOnEth,
      amount: request.amount,
      signature: blsResult.signature128Hex,
    });

    onProgress({
      status: "completed",
      message: "Unwrap complete! Tokens are now on Ethereum.",
      gonkaTxHash: unwrapResult.transactionHash,
      ethTxHash: receipt.hash,
    });

  } catch (error: any) {
    onProgress({
      status: "failed",
      message: error.message || "Unknown error",
      error: error.message,
    });
    throw error;
  }
}

// Helper: Convert request ID to 0x-prefixed bytes32 hex
function toBytes32Hex(requestId: string): string {
  if (requestId.startsWith("0x") && requestId.length === 66) {
    return requestId;
  }
  // If it's a raw hex string
  if (/^[0-9a-fA-F]{64}$/.test(requestId)) {
    return "0x" + requestId;
  }
  // If it's a string like "req_12345_abcdef...", hash it
  const encoder = new TextEncoder();
  const data = encoder.encode(requestId);
  // Use keccak256 from ethers
  return ethers.keccak256(data);
}
```

---

## Error Handling

### Common Errors and Recovery

| Error | Cause | Recovery |
|-------|-------|----------|
| "Keplr extension not found" | Keplr not installed | Prompt user to install |
| "Request rejected" | User declined Keplr signing | Allow retry |
| "Insufficient balance" | Not enough wrapped tokens | Show balance, prompt lower amount |
| "BLS signature timeout" | Network congestion or validator issue | Store tx hash, allow retry of step 3 later |
| "Bridge not in NORMAL_OPERATION" | Bridge in admin/timeout state | Inform user, try again later |
| "Epoch not recognized" | Bridge contract behind on epochs | Dashboard auto-submits via `ensureEpochOnBridge()` |
| "Epoch has no validation signature" | Epoch too new, signature not yet finalized | Wait ~1 minute, retry |
| "submitGroupKey reverted" | Invalid validation sig or wrong epoch sequence | Check epoch gap, sync sequentially |
| "Request already processed" | Double-submission | Tokens already released, show success |
| "Insufficient ETH for gas" | User's Keplr ETH account underfunded | Prompt user to fund ETH for gas |

### Resumable Flow

If the user closes the browser after Step 1 but before Step 3, the flow can be resumed:

```typescript
async function resumeUnwrap(
  gonkaTxHash: string,
  config: UnwrapFlowConfig,
  request: UnwrapRequest,
  onProgress: (progress: UnwrapProgress) => void
): Promise<void> {
  // Re-query the Gonka tx to get request ID and epoch
  const txInfo = await queryGonkaTx(config.gonkaApiBase, gonkaTxHash);
  const { requestId, epochId } = parseTxForBridgeData(txInfo);

  // Continue from Step 2
  const requestIdHex = toBytes32Hex(requestId);

  const blsResult = await waitForBLSSignature(config.gonkaApiBase, requestIdHex);

  await finalizeWithdrawalOnEthereum({
    bridgeAddress: request.bridgeContractAddress,
    epochId,
    requestId: requestIdHex,
    recipient: request.destinationEthAddress,
    tokenContract: request.tokenContractOnEth,
    amount: request.amount,
    signature: blsResult.signature128Hex,
  });
}
```

---

## Security Considerations

1. **No private keys in the browser** — All signing is delegated to Keplr
2. **BLS signature validation** — The Ethereum bridge contract verifies the BLS threshold signature on-chain; the dashboard cannot forge withdrawals
3. **Replay protection** — Each `requestId` can only be processed once per epoch on the bridge contract
4. **Chain ID binding** — Signatures are bound to both `GONKA_CHAIN_ID` and `ETHEREUM_CHAIN_ID`, preventing cross-chain replays
5. **Gas estimation** — Always use `auto` gas on Gonka and let ethers estimate on Ethereum; never hardcode gas limits

---

## Configuration Reference

### Testnet

```typescript
const TESTNET_CONFIG: UnwrapFlowConfig = {
  gonkaRpcEndpoint: "https://your-gonka-testnet-rpc/",
  gonkaApiBase: "https://your-gonka-testnet-api/v1",
  gonkaChainId: "gonka-testnet",
  ethereumChainIdHex: "0xaa36a7",  // Sepolia (11155111)
};
```

### Mainnet

```typescript
const MAINNET_CONFIG: UnwrapFlowConfig = {
  gonkaRpcEndpoint: "https://your-gonka-mainnet-rpc/",
  gonkaApiBase: "https://your-gonka-mainnet-api/v1",
  gonkaChainId: "gonka-mainnet-v1",
  ethereumChainIdHex: "0x1",  // Ethereum Mainnet
};
```

---

## Fetching Bridge Configuration from API

The dashboard should dynamically fetch the bridge contract address rather than hardcoding:

```typescript
async function getBridgeAddress(apiBase: string, chain: string): Promise<string> {
  const res = await fetch(`${apiBase}/bridge/addresses?chain=${chain}`);
  const data = await res.json();

  if (!data.addresses || data.addresses.length === 0) {
    throw new Error(`No bridge address registered for chain: ${chain}`);
  }

  return data.addresses[0];
}
```

---

## UI Flow Recommendation

```
┌─────────────────────────────────────────────────────┐
│                    Unwrap Tokens                      │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Token:     [USDC (Wrapped) ▼]                       │
│  Amount:    [____________] USDC                      │
│  Receive to: 0x742d35Cc... (your Keplr ETH address) │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │ ● Step 1: Burn on Gonka         ✓ Complete  │    │
│  │ ● Step 2: Validator Signing     ◔ 45s...    │    │
│  │ ○ Step 3: Release on Ethereum   Pending     │    │
│  └─────────────────────────────────────────────┘    │
│                                                      │
│  [      Unwrap Tokens      ]                        │
│                                                      │
└─────────────────────────────────────────────────────┘
```

The dashboard should persist the `gonkaTxHash` to localStorage after Step 1 so the user can resume if they navigate away.
