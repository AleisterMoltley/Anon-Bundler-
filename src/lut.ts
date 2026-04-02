import {
  Connection,
  Keypair,
  PublicKey,
  AddressLookupTableProgram,
  Transaction,
} from "@solana/web3.js";
import { log, confirmTx, retry, sleep } from "./utils";
import { CONFIG } from "./config";

/**
 * Create an Address Lookup Table for compact transactions.
 * NOTE: Currently the LUT is created for future use (e.g. post-launch swaps).
 * The initial Jito bundle uses standard V0 transactions without LUT references
 * because the LUT needs ~1 slot to become active onchain.
 */
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

      const addrSlice = addresses.slice(0, 180);

      const extendIx = AddressLookupTableProgram.extendLookupTable({
        lookupTable: lutAddr,
        authority: payer.publicKey,
        payer: payer.publicKey,
        addresses: addrSlice,
      });

      const tx = new Transaction().add(createIx, extendIx);

      const sig = await connection.sendTransaction(tx, [payer], {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      await confirmTx(connection, sig, "confirmed");
      await sleep(2000);

      log.success(`LUT created: ${lutAddr.toBase58()} (${addrSlice.length} addresses)`);
      return lutAddr;
    },
    { retries: 2, label: "LUT creation" }
  );
}
