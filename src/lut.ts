import {
  Connection,
  Keypair,
  PublicKey,
  AddressLookupTableProgram,
  Transaction,
} from "@solana/web3.js";
import { log, confirmTx, retry, sleep } from "./utils";
import { CONFIG } from "./config";

export async function createLUT(
  connection: Connection,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<PublicKey> {
  if (CONFIG.dryRun) {
    log.warn("DRY_RUN: Skipping LUT creation");
    return PublicKey.default;
  }

  return retry(
    async () => {
      const slot = await connection.getSlot("finalized");

      const [createIx, lutAddr] = AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: slot,
      });

      // LUT can hold max 256 addresses, but extend instruction is limited
      const addrSlice = addresses.slice(0, 180);

      const extendIx = AddressLookupTableProgram.extendLookupTable({
        lookupTable: lutAddr,
        authority: payer.publicKey,
        payer: payer.publicKey,
        addresses: addrSlice,
      });

      const tx = new Transaction().add(createIx, extendIx);

      // M2 fix: Actually wait for confirmation
      const sig = await connection.sendTransaction(tx, [payer], {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      await confirmTx(connection, sig, "confirmed");

      // Wait for LUT to be available onchain
      await sleep(2000);

      log.success(`LUT created: ${lutAddr.toBase58()} (${addrSlice.length} addresses)`);
      return lutAddr;
    },
    { retries: 2, label: "LUT creation" }
  );
}
