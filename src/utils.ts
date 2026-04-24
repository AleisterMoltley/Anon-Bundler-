import chalk from "chalk";
import {
  Connection,
  PublicKey,
  TransactionSignature,
  BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import axios from "axios";
import { CONFIG } from "./config";

// === Jupiter API endpoints (lite-api.jup.ag is the current public endpoint) ===
export const JUPITER_QUOTE_API = "https://lite-api.jup.ag/swap/v1/quote";
export const JUPITER_SWAP_API = "https://lite-api.jup.ag/swap/v1/swap";
export const JUPITER_PRICE_API = "https://lite-api.jup.ag/price/v3";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export function jupiterHeaders(): Record<string, string> {
  return CONFIG.jupiterApiKey ? { "x-api-key": CONFIG.jupiterApiKey } : {};
}

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

// === Rate Limiter ===

export class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private maxCalls: number,
    private windowMs: number
  ) {}

  async wait(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxCalls) {
      const oldest = this.timestamps[0]!;
      const waitMs = this.windowMs - (now - oldest) + 100;
      log.warn(`Rate limit: waiting ${Math.round(waitMs)}ms`);
      await sleep(waitMs);
    }

    this.timestamps.push(Date.now());
  }
}

// Jupiter free tier: ~60 req/min. Be conservative at 30/min.
export const jupiterLimiter = new RateLimiter(30, 60_000);

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
        log.warn(
          `${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${Math.round(delayMs)}ms: ${err.message}`
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

// === TX Confirmation using blockhash expiry (far more robust than naive polling) ===

export async function confirmTx(
  connection: Connection,
  sig: TransactionSignature,
  blockhashInfo: BlockhashWithExpiryBlockHeight,
  commitment: "confirmed" | "finalized" = "confirmed"
): Promise<void> {
  const res = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: blockhashInfo.blockhash,
      lastValidBlockHeight: blockhashInfo.lastValidBlockHeight,
    },
    commitment
  );

  if (res.value.err) {
    throw new Error(`Transaction ${sig} failed onchain: ${JSON.stringify(res.value.err)}`);
  }
}

// === Jito Tip Accounts (static fallback list — identical across block engines) ===

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

let cachedTipAccounts: PublicKey[] | null = null;

export async function getDynamicTipAccounts(): Promise<PublicKey[]> {
  if (cachedTipAccounts) return cachedTipAccounts;
  try {
    const res = await axios.get(
      "https://mainnet.block-engine.jito.wtf/api/v1/bundles/tip_accounts",
      { timeout: 5_000 }
    );
    if (Array.isArray(res.data?.result) && res.data.result.length > 0) {
      cachedTipAccounts = res.data.result.map((a: string) => new PublicKey(a));
      return cachedTipAccounts!;
    }
    if (Array.isArray(res.data) && res.data.length > 0) {
      cachedTipAccounts = res.data.map((a: string) => new PublicKey(a));
      return cachedTipAccounts!;
    }
  } catch {
    // fallback
  }
  cachedTipAccounts = FALLBACK_TIP_ACCOUNTS.map((a) => new PublicKey(a));
  return cachedTipAccounts;
}

// === Jito tip_floor (dynamic tip sizing based on recent landed bundles) ===

interface TipFloorResponse {
  time: string;
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
  ema_landed_tips_50th_percentile: number;
}

/**
 * Returns tip in lamports based on recent landed-bundle percentile × multiplier,
 * capped by JITO_TIP_MAX_LAMPORTS. Falls back to JITO_TIP_LAMPORTS if API fails.
 */
export async function getDynamicTipLamports(): Promise<number> {
  const pctKey = `landed_tips_${CONFIG.jitoTipPercentile}th_percentile` as keyof TipFloorResponse;

  try {
    const res = await axios.get("https://bundles.jito.wtf/api/v1/bundles/tip_floor", {
      timeout: 5_000,
    });
    const data: TipFloorResponse | undefined = Array.isArray(res.data) ? res.data[0] : undefined;
    const solTip = data?.[pctKey];

    if (typeof solTip === "number" && solTip > 0) {
      const scaled = Math.floor(solTip * 1e9 * CONFIG.jitoTipMultiplier);
      const tip = Math.min(
        Math.max(scaled, CONFIG.jitoTipLamportsFallback),
        CONFIG.jitoTipMaxLamports
      );
      log.info(
        `Jito tip: p${CONFIG.jitoTipPercentile}=${(solTip * 1e9).toFixed(0)} lamports × ${CONFIG.jitoTipMultiplier} → ${tip} lamports (${(tip / 1e9).toFixed(6)} SOL)`
      );
      return tip;
    }
  } catch (err: any) {
    log.warn(`Jito tip_floor fetch failed: ${err.message} — using fallback`);
  }
  return CONFIG.jitoTipLamportsFallback;
}

// === Logging ===

export const log = {
  success: (msg: string) => console.log(chalk.green(`✅ ${msg}`)),
  info: (msg: string) => console.log(chalk.cyan(`ℹ️  ${msg}`)),
  error: (msg: string) => console.log(chalk.red(`❌ ${msg}`)),
  warn: (msg: string) => console.log(chalk.yellow(`⚠️  ${msg}`)),
  step: (msg: string) => console.log(chalk.bold.blue(`→ ${msg}`)),
};
