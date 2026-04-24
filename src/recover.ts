/**
 * Recovery: reclaim SOL from funded buyer wallets back to master.
 *
 * Usage: npm run recover
 */

import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { CONFIG } from "./config";
import { loadWalletVault } from "./wallets";
import { log, confirmTx, retry, sleep } from "./utils";

async function recover() {
  console.log("\n🔧 WALLET RECOVERY — Reclaiming SOL from buyer wallets\n");

  if (!CONFIG.walletVaultPassword) {
    throw new Error("WALLET_VAULT_PASSWORD is required to load the wallet vault");
  }

  const connection = new Connection(CONFIG.rpcUrl, "confirmed");
  const master = Keypair.fromSecretKey(bs58.decode(CONFIG.masterPrivateKey));
  log.info(`Master: ${master.publicKey.toBase58()}`);

  const wallets = loadWalletVault();
  if (!wallets || wallets.length === 0) {
    log.error("No wallets found in vault. Nothing to recover.");
    process.exit(1);
  }
  log.info(`Found ${wallets.length} wallets in vault`);

  const MIN_RENT = 890_880; // system-account rent-exempt
  const TX_FEE_RESERVE = 5_000;

  let totalRecovered = 0;
  let walletsWithBalance = 0;

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i]!;
    const balance = await connection.getBalance(wallet.publicKey);
    if (balance <= MIN_RENT) continue;

    walletsWithBalance++;
    const transferAmount = balance - TX_FEE_RESERVE;
    if (transferAmount <= 0) continue;

    log.info(
      `Wallet ${i + 1}/${wallets.length}: ${wallet.publicKey.toBase58().slice(0, 12)}... — ` +
        `${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`
    );

    if (CONFIG.dryRun) {
      totalRecovered += transferAmount;
      continue;
    }

    try {
      await retry(
        async () => {
          const blockhashInfo = await connection.getLatestBlockhash("confirmed");
          const msg = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhashInfo.blockhash,
            instructions: [
              SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: master.publicKey,
                lamports: transferAmount,
              }),
            ],
          }).compileToV0Message();
          const tx = new VersionedTransaction(msg);
          tx.sign([wallet]);

          const sig = await connection.sendTransaction(tx, {
            skipPreflight: false,
            preflightCommitment: "confirmed",
            maxRetries: 3,
          });
          await confirmTx(connection, sig, blockhashInfo, "confirmed");
          log.success(
            `Recovered ${(transferAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL (sig: ${sig.slice(0, 16)}...)`
          );
        },
        { retries: 2, label: `recovery wallet ${i + 1}` }
      );

      totalRecovered += transferAmount;
      await sleep(500);
    } catch (err: any) {
      log.error(`Failed to recover from wallet ${i + 1}: ${err.message}`);
    }
  }

  console.log("");
  if (CONFIG.dryRun) {
    log.warn(
      `DRY_RUN: Would recover ~${(totalRecovered / LAMPORTS_PER_SOL).toFixed(4)} SOL from ${walletsWithBalance} wallets`
    );
  } else {
    log.success(
      `Recovery complete: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(4)} SOL from ${walletsWithBalance} wallets → master`
    );
  }

  log.info("\nNote: This only recovers SOL. Token holdings must be sold first.");
}

recover().catch((err) => {
  log.error(`Recovery failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
