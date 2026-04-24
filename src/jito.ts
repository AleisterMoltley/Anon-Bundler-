import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import bs58 from "bs58";
import axios from "axios";
import crypto from "crypto";
import { CONFIG } from "./config";
import { getDynamicTipAccounts, getDynamicTipLamports, log, retry, sleep } from "./utils";

// Frankfurt + NY + mainnet global — user is in Frankfurt, so FRA is lowest latency
const JITO_BLOCK_ENGINES = [
  "https://frankfurt.mainnet.block-engine.jito.wtf",
  "https://ny.mainnet.block-engine.jito.wtf",
  "https://mainnet.block-engine.jito.wtf",
];

const JITO_MAX_BUNDLE_SIZE = 5;

/**
 * Build a tip transaction that transfers SOL to a random Jito tip account.
 * Must share the bundle's blockhash so all TXs land in the same slot.
 */
async function buildTipTransaction(
  payer: Keypair,
  tipLamports: number,
  blockhashInfo: BlockhashWithExpiryBlockHeight
): Promise<VersionedTransaction> {
  const tipAccounts = await getDynamicTipAccounts();
  const tipAccount = tipAccounts[crypto.randomInt(tipAccounts.length)]!;

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhashInfo.blockhash,
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

  log.info(
    `Tip TX: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL → ${tipAccount.toBase58().slice(0, 12)}...`
  );
  return tx;
}

/**
 * Submit a Jito bundle. Bundle layout: [...payload, tipTx] (max 5 total).
 * Base58-encoded per Jito API requirement.
 */
export async function sendJitoBundle(
  transactions: VersionedTransaction[],
  payer: Keypair,
  blockhashInfo: BlockhashWithExpiryBlockHeight
): Promise<string | null> {
  if (transactions.length === 0) {
    log.warn("No transactions to bundle — skipping Jito bundle");
    return null;
  }

  if (CONFIG.dryRun) {
    log.warn(`DRY_RUN: Would send Jito bundle with ${transactions.length} transactions`);
    return "dry-run-bundle-id";
  }

  // Reserve one slot for tip
  const maxPayloadTxs = JITO_MAX_BUNDLE_SIZE - 1;
  if (transactions.length > maxPayloadTxs) {
    log.warn(
      `Payload has ${transactions.length} TXs (max ${maxPayloadTxs} + 1 tip). Trimming to ${maxPayloadTxs}.`
    );
    transactions = transactions.slice(0, maxPayloadTxs);
  }

  const tipLamports = await getDynamicTipLamports();
  const tipTx = await buildTipTransaction(payer, tipLamports, blockhashInfo);

  const bundle = [...transactions, tipTx];
  const encodedTxs = bundle.map((tx) => bs58.encode(Buffer.from(tx.serialize())));

  log.step(
    `Sending Jito bundle (${bundle.length} txs: ${transactions.length} payload + 1 tip) to ${JITO_BLOCK_ENGINES.length} engines...`
  );

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

  // Return the first accepted bundle ID (all engines should return the same ID
  // for the same bundle content, but use the first success).
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      log.success(`Jito bundle accepted! Bundle ID: ${result.value}`);
      return result.value;
    }
  }

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason?.message || "unknown");
  log.error(`All Jito block engines rejected bundle: ${errors.join(", ")}`);
  return null;
}

/**
 * Poll bundle status across all engines. Returns true when confirmed/finalized,
 * false on explicit failure or timeout.
 */
export async function waitForBundleConfirmation(
  bundleId: string,
  timeoutMs: number = 60_000
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    for (const engine of JITO_BLOCK_ENGINES) {
      try {
        const res = await axios.post(
          `${engine}/api/v1/bundles`,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "getBundleStatuses",
            params: [[bundleId]],
          },
          { timeout: 5_000 }
        );

        const statuses = res.data?.result?.value;
        if (statuses && statuses.length > 0 && statuses[0]) {
          const status = statuses[0];
          if (
            status.confirmation_status === "confirmed" ||
            status.confirmation_status === "finalized"
          ) {
            log.success(`Bundle ${bundleId} confirmed onchain (via ${engine})`);
            return true;
          }
          if (status.err && status.err !== null && typeof status.err === "object") {
            log.error(`Bundle ${bundleId} failed: ${JSON.stringify(status.err)}`);
            return false;
          }
        }
      } catch {
        // try next engine
      }
    }

    await sleep(2000);
  }

  log.warn(`Bundle ${bundleId} confirmation timed out after ${timeoutMs / 1000}s`);
  return false;
}
