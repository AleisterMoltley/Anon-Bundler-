import {
  Connection,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { CONFIG } from "./config";
import { log, retry, confirmTx } from "./utils";

// Rent-exempt lamports for a 0-data SystemProgram account.
// Conservative: 0.002 SOL covers this + ATA creation headroom.
const WALLET_RENT_BUFFER_LAMPORTS = 2_000_000;

export async function fundWallets(
  connection: Connection,
  master: Keypair,
  wallets: Keypair[]
) {
  const lamportsPerWallet = Math.floor(CONFIG.solPerWallet * LAMPORTS_PER_SOL);
  const totalNeeded = lamportsPerWallet * wallets.length;

  log.step("Checking master wallet balance...");
  const balance = await connection.getBalance(master.publicKey);

  // Fees: signature + priority + safety buffer — empirical ~0.001 SOL per batch TX
  const batchSize = 8;
  const numBatches = Math.ceil(wallets.length / batchSize);
  const txFeeBudget = 1_500_000 * numBatches; // ~0.0015 SOL per batch

  const required =
    totalNeeded + txFeeBudget + CONFIG.jitoTipMaxLamports + WALLET_RENT_BUFFER_LAMPORTS;

  log.info(`Master balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  log.info(
    `Required: ~${(required / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
      `(${wallets.length} × ${CONFIG.solPerWallet} SOL + fees + tip reserve)`
  );

  if (balance < required) {
    throw new Error(
      `Insufficient master balance: have ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL, ` +
        `need ~${(required / LAMPORTS_PER_SOL).toFixed(4)} SOL`
    );
  }

  if (CONFIG.dryRun) {
    log.warn("DRY_RUN: Skipping actual funding transactions");
    return;
  }

  log.step(`Funding ${wallets.length} wallets in batches of ${batchSize}...`);

  for (let i = 0; i < wallets.length; i += batchSize) {
    const batch = wallets.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    await retry(
      async () => {
        // Fresh blockhash for every batch — avoids staleness across long funding runs
        const blockhashInfo = await connection.getLatestBlockhash("confirmed");

        const msg = new TransactionMessage({
          payerKey: master.publicKey,
          recentBlockhash: blockhashInfo.blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 * batch.length }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
            ...batch.map((w) =>
              SystemProgram.transfer({
                fromPubkey: master.publicKey,
                toPubkey: w.publicKey,
                lamports: lamportsPerWallet,
              })
            ),
          ],
        }).compileToV0Message();

        const tx = new VersionedTransaction(msg);
        tx.sign([master]);

        const sig = await connection.sendTransaction(tx, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 3,
        });

        await confirmTx(connection, sig, blockhashInfo, "confirmed");
        log.info(`Batch ${batchNum}/${numBatches} funded (sig: ${sig.slice(0, 16)}...)`);
      },
      { retries: 3, label: `funding batch ${batchNum}` }
    );
  }

  log.success(`All ${wallets.length} wallets funded!`);
}
