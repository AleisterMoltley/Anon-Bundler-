/**
 * Recovery script: Reclaim SOL from funded buyer wallets back to master
 *
 * Usage: npx ts-node src/recover.ts
 *
 * This is useful when:
 * - Process crashed after wallet funding but before launch
 * - Launch failed and you want SOL back
 * - You're done and want to consolidate funds
 */

import { Connection, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { CONFIG, validateConfig } from "./config";
import { loadWalletVault } from "./wallets";
import { log, confirmTx, retry, sleep } from "./utils";

async function recover() {
  console.log("\n🔧 WALLET RECOVERY — Reclaiming SOL from buyer wallets\n");

  // Don't require vault password in dry-run mode for recovery
  if (!CONFIG.walletVaultPassword) {
    throw new Error("WALLET_VAULT_PASSWORD is required to load wallet vault for recovery");
  }

  const connection = new Connection(CONFIG.rpcUrl, "confirmed");
  const master = Keypair.fromSecretKey(bs58.decode(CONFIG.masterPrivateKey));

  log.info(`Master: ${master.publicKey.toBase58()}`);

  // Load wallets from vault
  const wallets = loadWalletVault();
  if (!wallets || wallets.length === 0) {
    log.error("No wallets found in vault. Nothing to recover.");
    process.exit(1);
  }

  log.info(`Found ${wallets.length} wallets in vault`);

  let totalRecovered = 0;
  let walletsWithBalance = 0;
  const minRent = 890_880; // minimum rent-exempt balance for system account

  // Check all wallets
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i]!;
    const balance = await connection.getBalance(wallet.publicKey);

    if (balance <= minRent) {
      continue; // skip empty wallets
    }

    walletsWithBalance++;

    // Leave enough for the transfer fee
    const transferAmount = balance - 5000; // 5000 lamports for fee
    if (transferAmount <= 0) continue;

    log.info(
      `Wallet ${i + 1}/${wallets.length}: ${wallet.publicKey.toBase58().slice(0, 12)}... — ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`
    );

    if (CONFIG.dryRun) {
      totalRecovered += transferAmount;
      continue;
    }

    try {
      await retry(
        async () => {
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: master.publicKey,
              lamports: transferAmount,
            })
          );

          const sig = await connection.sendTransaction(tx, [wallet], {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });

          await confirmTx(connection, sig, "confirmed");
          log.success(`Recovered ${(transferAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL (sig: ${sig.slice(0, 16)}...)`);
        },
        { retries: 2, label: `recovery wallet ${i + 1}` }
      );

      totalRecovered += transferAmount;

      // Don't hammer RPC
      await sleep(500);
    } catch (err: any) {
      log.error(`Failed to recover from wallet ${i + 1}: ${err.message}`);
    }
  }

  console.log("");
  if (CONFIG.dryRun) {
    log.warn(`DRY_RUN: Would recover ~${(totalRecovered / LAMPORTS_PER_SOL).toFixed(4)} SOL from ${walletsWithBalance} wallets`);
  } else {
    log.success(
      `Recovery complete: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(4)} SOL from ${walletsWithBalance} wallets → master`
    );
  }

  // Also check for token balances
  log.info("\nNote: This only recovers SOL. If wallets hold tokens, sell them first via the volume bot or manually.");
}

recover().catch((err) => {
  log.error(`Recovery failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
