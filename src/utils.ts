import chalk from "chalk";
import { Connection, PublicKey, TransactionSignature } from "@solana/web3.js";

// === Random helpers ===

export function randomAmount(min: number, max: number): number {
  return parseFloat((min + Math.random() * (max - min)).toFixed(4));
}

export function randomDelay(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

export async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// === Retry with exponential backoff ===

export async function retry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; label?: string } = {}
): Promise<T> {
  const { retries = 3, baseMs = 1000, label = "operation" } = opts;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < retries) {
        const delayMs = baseMs * Math.pow(2, attempt) + Math.random() * 500;
        log.warn(`${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${Math.round(delayMs)}ms...`);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

// === TX Confirmation with timeout ===

export async function confirmTx(
  connection: Connection,
  sig: TransactionSignature,
  commitment: "confirmed" | "finalized" = "confirmed",
  timeoutMs: number = 30_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatus(sig);
    if (status?.value?.confirmationStatus === commitment || status?.value?.confirmationStatus === "finalized") {
      if (status.value.err) {
        throw new Error(`Transaction ${sig} confirmed with error: ${JSON.stringify(status.value.err)}`);
      }
      return;
    }
    await sleep(1500);
  }
  throw new Error(`Transaction ${sig} confirmation timed out after ${timeoutMs}ms`);
}

// === Jito Tip Accounts ===

const FALLBACK_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bPUZPon1DEaf6fk3K5NXNY",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSLm3CnLmSE9fUCPvo1",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export async function getDynamicTipAccounts(connection: Connection): Promise<PublicKey[]> {
  try {
    const resp = await (connection as any)._rpcRequest("getTipAccounts", []);
    if (resp?.result && Array.isArray(resp.result) && resp.result.length > 0) {
      return resp.result.map((a: string) => new PublicKey(a));
    }
  } catch {
    // fallback below
  }
  return FALLBACK_TIP_ACCOUNTS.map((a) => new PublicKey(a));
}

// === Logging ===

export const log = {
  success: (msg: string) => console.log(chalk.green(`✅ ${msg}`)),
  info: (msg: string) => console.log(chalk.cyan(`ℹ️  ${msg}`)),
  error: (msg: string) => console.log(chalk.red(`❌ ${msg}`)),
  warn: (msg: string) => console.log(chalk.yellow(`⚠️  ${msg}`)),
  step: (msg: string) => console.log(chalk.bold.blue(`→ ${msg}`)),
};
