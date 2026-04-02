import {
  Connection,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { CONFIG } from "./config";
import { log, retry, confirmTx } from "./utils";

export async function fundWallets(connection: Connection, master: Keypair, wallets: Keypair[]) {
  const lamportsPerWallet = Math.floor(CONFIG.solPerWallet * LAMPORTS_PER_SOL);
  // 1.05 buffer for rent + fees (was 1.08, tightened)
  const totalNeeded = Math.ceil(lamportsPerWallet * 1.05 * wallets.length);
  const txFeeBudget = 50_000 * Math.ceil(wallets.length / 8); // ~5000 lamports per tx, 8 per batch

  // H4 fix: Balance check before funding
  log.step("Checking master wallet balance...");
  const balance = await connection.getBalance(master.publicKey);
  const required = totalNeeded + txFeeBudget + CONFIG.jitoTipLamports;

  log.info(`Master balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  log.info(`Required: ~${(required / LAMPORTS_PER_SOL).toFixed(4)} SOL (${wallets.length} wallets × ${CONFIG.solPerWallet} SOL + fees)`);

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

  // Batch funding with sane compute budget (M5 fix)
  const batchSize = 8;
  log.step(`Funding ${wallets.length} wallets in batches of ${batchSize}...`);

  for (let i = 0; i < wallets.length; i += batchSize) {
    const batch = wallets.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(wallets.length / batchSize);

    await retry(
      async () => {
        const tx = new Transaction();

        // M5 fix: Sane compute budget for simple transfers
        tx.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 * batch.length }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })
        );

        for (const w of batch) {
          tx.add(
            SystemProgram.transfer({
              fromPubkey: master.publicKey,
              toPubkey: w.publicKey,
              lamports: lamportsPerWallet,
            })
          );
        }

        // M3 fix: Don't skip preflight
        const sig = await connection.sendTransaction(tx, [master], {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });

        await confirmTx(connection, sig, "confirmed");
        log.info(`Batch ${batchNum}/${totalBatches} funded (sig: ${sig.slice(0, 16)}...)`);
      },
      { retries: 3, label: `funding batch ${batchNum}` }
    );
  }

  log.success(`All ${wallets.length} wallets funded!`);
}
