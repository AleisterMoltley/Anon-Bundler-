import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import axios from "axios";
import { CONFIG } from "./config";
import { getDynamicTipAccounts, log, retry, sleep } from "./utils";

const JITO_BLOCK_ENGINES = [
  "https://mainnet.block-engine.jito.wtf",
  "https://ny.block-engine.jito.wtf",
];

/**
 * Build a tip transaction for Jito validators
 */
async function buildTipTransaction(
  connection: Connection,
  payer: Keypair,
  tipLamports: number
): Promise<VersionedTransaction> {
  const tipAccounts = await getDynamicTipAccounts(connection);
  const tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];

  const blockhash = await connection.getLatestBlockhash("confirmed");

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  log.info(`Tip TX built: ${tipLamports / LAMPORTS_PER_SOL} SOL → ${tipAccount.toBase58().slice(0, 12)}...`);
  return tx;
}

/**
 * Send a Jito bundle via block engine API
 * K2 + K3 fix: Actually sends transactions, dual submission
 */
export async function sendJitoBundle(
  connection: Connection,
  transactions: VersionedTransaction[],
  tipLamports: number,
  payer: Keypair
): Promise<string | null> {
  if (transactions.length === 0) {
    log.warn("No transactions to bundle — skipping Jito bundle");
    return null;
  }

  if (CONFIG.dryRun) {
    log.warn(`DRY_RUN: Would send Jito bundle with ${transactions.length} transactions`);
    return "dry-run-bundle-id";
  }

  // Append tip transaction as last TX in bundle
  const tipTx = await buildTipTransaction(connection, payer, tipLamports);
  const bundle = [...transactions, tipTx];

  if (bundle.length > 5) {
    log.warn(`Bundle has ${bundle.length} transactions (Jito max is 5). Trimming to 5.`);
    bundle.splice(5);
  }

  // Serialize to base58 for Jito API
  const encodedTxs = bundle.map((tx) =>
    Buffer.from(tx.serialize()).toString("base64")
  );

  log.step(`Sending Jito bundle (${bundle.length} txs, tip: ${tipLamports / LAMPORTS_PER_SOL} SOL)...`);

  // Dual submission to multiple block engines
  const results = await Promise.allSettled(
    JITO_BLOCK_ENGINES.map((engine) =>
      retry(
        async () => {
          const res = await axios.post(
            `${engine}/api/v1/bundles`,
            {
              jsonrpc: "2.0",
              id: 1,
              method: "sendBundle",
              params: [encodedTxs],
            },
            { timeout: 10_000 }
          );

          if (res.data.error) {
            throw new Error(`Jito error: ${JSON.stringify(res.data.error)}`);
          }

          return res.data.result as string;
        },
        { retries: 1, label: `Jito ${engine}` }
      )
    )
  );

  // Check results
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      log.success(`Jito bundle accepted! Bundle ID: ${result.value}`);
      return result.value;
    }
  }

  // All engines failed
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason?.message || "unknown");
  log.error(`All Jito block engines rejected bundle: ${errors.join(", ")}`);
  return null;
}

/**
 * Poll for bundle status
 */
export async function waitForBundleConfirmation(
  bundleId: string,
  timeoutMs: number = 60_000
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await axios.post(
        `${JITO_BLOCK_ENGINES[0]}/api/v1/bundles`,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getBundleStatuses",
          params: [[bundleId]],
        },
        { timeout: 5_000 }
      );

      const statuses = res.data?.result?.value;
      if (statuses && statuses.length > 0) {
        const status = statuses[0];
        if (status.confirmation_status === "confirmed" || status.confirmation_status === "finalized") {
          log.success(`Bundle ${bundleId} confirmed onchain!`);
          return true;
        }
        if (status.err) {
          log.error(`Bundle ${bundleId} failed: ${JSON.stringify(status.err)}`);
          return false;
        }
      }
    } catch {
      // ignore polling errors
    }

    await sleep(2000);
  }

  log.warn(`Bundle ${bundleId} confirmation timed out after ${timeoutMs / 1000}s`);
  return false;
}
