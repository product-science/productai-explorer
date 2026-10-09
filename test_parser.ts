import { accountFromAny, AccountParser } from "@cosmjs/stargate";
import { BaseAccount } from "cosmjs-types/cosmos/auth/v1beta1/auth";
import { Any } from "cosmjs-types/google/protobuf/any";

function customAccountParser(input: Any) {
  if (
    input.typeUrl === "/injective.types.v1beta1.EthAccount" ||
    input.typeUrl === "/ethermint.types.v1.EthAccount"
  ) {
    // Both EthAccount types wrap a BaseAccount as their first field.
    // The protobuf structure is: 
    // message EthAccount {
    //   cosmos.auth.v1beta1.BaseAccount base_account = 1;
    //   string code_hash = 2;
    // }
    // Let's decode just the base_account by taking the Any value.
    // Actually, in protobuf, field 1 is base_account.
    // If we want to be safe without depending on generated types, we can use a basic decoder or just use cosmjs-types base account.
    
    // We can't trivially decode it without protobufjs, but we can write a simple custom parser:
    const baseAccountBytes = input.value.subarray(2, input.value[1] + 2); 
    // Wait, the tag for field 1 is 1 << 3 | 2 = 10 (0x0A). 
    // Let's print out what an EthAccount buffer looks like.
    console.log("Found EthAccount");
  }
  return accountFromAny(input);
}
console.log(customAccountParser);
