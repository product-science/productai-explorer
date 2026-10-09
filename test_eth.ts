import { BaseAccount } from "cosmjs-types/cosmos/auth/v1beta1/auth";
import { Any } from "cosmjs-types/google/protobuf/any";

function decodeEthAccount(value: Uint8Array): BaseAccount {
    // Field 1 (base_account) has tag 0x0A (10)
    if (value[0] !== 0x0A) {
        throw new Error("Expected EthAccount to start with base_account field (0x0A)");
    }

    // Read length (varint)
    let length = 0;
    let shift = 0;
    let offset = 1;
    while (true) {
        const byte = value[offset++];
        length |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }

    const baseAccountBytes = value.subarray(offset, offset + length);
    return BaseAccount.decode(baseAccountBytes);
}

// Simple test
const mockBase = BaseAccount.encode(BaseAccount.fromPartial({ address: "inj1...", accountNumber: 123n, sequence: 5n })).finish();
const ethAccountBytes = new Uint8Array(2 + mockBase.length);
ethAccountBytes[0] = 0x0A;
ethAccountBytes[1] = mockBase.length; // assuming short length for test
ethAccountBytes.set(mockBase, 2);

console.log(decodeEthAccount(ethAccountBytes));
