# Exchange & Bridge Widget User Flows & State Machine

This document outlines all the user flows, transaction states, and recovery behaviors for the Exchange & Bridge Widget.

---

## 1. High-Level Flow Selector

```mermaid
graph TD
    Start([User Opens Widget]) --> Tab{Select Tab}
    
    Tab -->|Deposit| DepType{Select Token Type}
    DepType -->|IBC Token<br>e.g., Cosmos Hub/Osmosis| IBCDep[IBC Deposit Flow]
    DepType -->|EVM Token/WGNK<br>from Ethereum| EVMDep[EVM Bridge Deposit Flow]
    
    Tab -->|Withdraw| WitType{Select Token Type}
    WitType -->|IBC Native Token<br>to Cosmos Hub/Osmosis| IBCWit[IBC Withdraw Flow]
    WitType -->|EVM Token/GNK<br>to Ethereum| EVMWit[EVM Bridge Withdraw Flow]
```

---

## 2. Detailed Transaction Flows

### A. Deposit Flows

#### IBC Deposit Flow (Cosmos Hub / Osmosis $\rightarrow$ Gonka)
```mermaid
sequenceDiagram
    autonumber
    actor User as User (Keplr Wallet)
    participant SrcChain as Source Cosmos Chain
    participant Relayer as IBC Relayer
    participant Gonka as Gonka Chain
    
    Note over User,Gonka: Step 1: Connect Wallet (Keplr)
    Note over User,Gonka: Step 2: Select source chain, token & enter amount
    
    User->>SrcChain: Step 3: Approve & Sign MsgTransfer
    SrcChain-->>Relayer: Emit SendPacket Event
    Note over Relayer: Detects Packet & Relays to Gonka
    Relayer->>Gonka: MsgRecvPacket
    Gonka-->>User: Tokens credited in Gonka account (Complete)
```

#### EVM Bridge Deposit Flow (Ethereum $\rightarrow$ Gonka)
```mermaid
sequenceDiagram
    autonumber
    actor User as User (MetaMask / Keplr EVM)
    participant EthBridge as Ethereum Bridge Contract
    participant Orch as BLS Validators / Orchestrator
    participant Gonka as Gonka Chain
    
    Note over User,Gonka: Step 1: Connect Wallet (Keplr & EVM)
    Note over User,Gonka: Step 2: Select token, amount & verify keys
    rect rgb(240, 240, 240)
        Note over User,Gonka: Mnemonic check: Verifies EVM public key maps to active Gonka address
    end
    
    User->>EthBridge: Step 3: Sign & Approve lock transaction
    Note over EthBridge: Tokens Locked in Bridge
    EthBridge-->>Orch: Emit Lock Event
    Note over Orch: Validators sign & generate BLS Signature
    Orch->>Gonka: Mint wrapped tokens to derived Gonka address
    Gonka-->>User: Tokens credited in Gonka account (Complete)
```

---

### B. Withdrawal Flows

#### IBC Withdrawal Flow (Gonka $\rightarrow$ Cosmos Hub / Osmosis)
```mermaid
sequenceDiagram
    autonumber
    actor User as User (Keplr Wallet)
    participant Gonka as Gonka Chain
    participant Relayer as IBC Relayer
    participant DestChain as Destination Cosmos Chain
    
    Note over User,DestChain: Step 1: Connect Wallet (Keplr)
    Note over User,DestChain: Step 2: Select destination chain, enter recipient address & amount
    
    User->>Gonka: Step 3: Approve & Sign MsgTransfer
    Gonka-->>Relayer: Emit SendPacket Event
    Note over Relayer: Detects Packet & Relays to Destination
    Relayer->>DestChain: MsgRecvPacket
    DestChain-->>User: Tokens credited on destination chain (Complete)
```

#### EVM Bridge Withdrawal Flow (Gonka $\rightarrow$ Ethereum)
This flow features a **two-step cross-chain transaction** with persistent state recovery.

```mermaid
sequenceDiagram
    autonumber
    actor User as User Wallet
    participant Gonka as Gonka Chain
    participant Orch as BLS Orchestrator (API)
    participant EthBridge as Ethereum Bridge Contract

    Note over User,EthBridge: Step 1 & 2: Set parameters & check Epoch Sync
    
    User->>Gonka: Step 3a: Sign unwrap / burn transaction
    Gonka-->>User: Return Tx Hash (Tokens Burned on Gonka)
    
    rect rgb(255, 245, 230)
        Note over User: Widget persists transaction details to localStorage<br>(State: Incomplete / Pending)
    end
    
    Gonka-->>Orch: Emit Burn Event (Request ID)
    
    loop Poll BLS Signatures
        User->>Orch: Query signature by Request ID hex
    end
    Orch-->>User: Return Validator BLS Signature
    
    Note over User: Switch network to Ethereum
    
    alt Finalization Successful
        User->>EthBridge: Step 3b: Sign mintWithSignature / withdraw
        EthBridge-->>User: Release tokens on Ethereum (Complete)
        Note over User: Clear localStorage cache
    else Finalization Fails / Rejected by User
        Note over User: MetaMask transaction rejected or failed
        rect rgb(255, 240, 240)
            Note over User: Widget stays in "Incomplete" (Warning) state<br>allowing User to retry signing (Resume)
        end
    end
```

---

## 3. Widget Step & State Machine

```mermaid
stateDiagram-v2
    [*] --> Step1_Connect : Open Widget
    
    state Step1_Connect {
        [*] --> Disconnected
        Disconnected --> Connected : Connect Wallet
    }
    
    Step1_Connect --> Step2_Details : Wallet Connected
    
    state Step2_Details {
        [*] --> EnteringDetails
        EnteringDetails --> CheckingDerivation : EVM Tab / Key Derivation
        CheckingDerivation --> AddressMismatchWarning : Mnemonic Mismatch
        CheckingDerivation --> ValidDetails : Matching Addresses
        EnteringDetails --> ValidDetails : IBC Tab
    }
    
    Step2_Details --> Step3_Approve : Click Continue
    
    state Step3_Approve {
        [*] --> InProgress : Broadcast Gonka transaction
        InProgress --> WaitingBLS : Waiting for validator signatures
        
        state WaitingBLS {
            [*] --> Polling
        }
        
        WaitingBLS --> FinalizingEth : BLS Signature received
        
        state FinalizingEth {
            [*] --> WalletPrompt
            WalletPrompt --> Finalized : User Signs on Ethereum
            WalletPrompt --> FinalizationFailed : User Rejects / RPC Error
        }
    }
    
    Step3_Approve --> Step3_Completed : Finalized
    Step3_Approve --> Step3_Incomplete : FinalizationFailed (Stored in localStorage)
    
    state Step3_Incomplete {
        [*] --> YellowWarningView : Display Incomplete + Error Message
        YellowWarningView --> Step3_Approve : Click "Resume Transaction"
        YellowWarningView --> Step2_Details : Click "Discard"
    }
    
    Step3_Completed --> [*]
```
