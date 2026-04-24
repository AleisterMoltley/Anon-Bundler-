import { Connection, PublicKey } from "@solana/web3.js";
import axios from "axios";
import { OnlinePumpSdk, PumpSdk, bondingCurvePda } from "@pump-fun/pump-sdk";
import { sleep, log } from "../utils";
import { CONFIG } from "../config";

/**
 * Read bonding curve state from chain via the official SDK.
 * Uses decodeBondingCurveNullable so we correctly detect a closed/migrated account.
 */
async function checkBondingCurveProgress(
  connection: Connection,
  mint: PublicKey
): Promise<{ progress: number; completed: boolean; unreadable: boolean }> {
  try {
    const pda = bondingCurvePda(mint);
    const accountInfo = await connection.getAccountInfo(pda);

    if (!accountInfo) {
      // Account doesn't exist yet or has been closed post-migration
      return { progress: 0, completed: false, unreadable: false };
    }

    const pumpSdk = new PumpSdk();
    const bc = pumpSdk.decodeBondingCurveNullable(accountInfo);
    if (!bc) {
      return { progress: -1, completed: false, unreadable: true };
    }

    // Already graduated
    if (bc.complete) {
      return { progress: 100, completed: true, unreadable: false };
    }

    // Progress estimated from virtualSolReserves against the 85 SOL graduation target.
    // Using virtualSolReserves (not realSolReserves) matches how Pump.fun displays progress.
    const virtualSolSol = bc.virtualSolReserves.toNumber() / 1e9;
    const targetSol = 85;
    const progress = Math.min(100, (virtualSolSol / targetSol) * 100);

    return { progress, completed: false, unreadable: false };
  } catch (err: any) {
    log.warn(`Bonding curve check failed: ${err.message}`);
    return { progress: 0, completed: false, unreadable: true };
  }
}

/**
 * DexScreener check for Raydium/PumpSwap pool — complementary signal to the
 * on-chain `complete` flag (off-chain pool may lag a few seconds).
 */
async function checkIfMigrated(mint: PublicKey): Promise<boolean> {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint.toBase58()}`,
      { timeout: 10_000 }
    );
    const pairs = res.data?.pairs || [];
    return pairs.some(
      (p: any) =>
        (p.dexId === "raydium" || p.dexId === "pumpswap") && (p.liquidity?.usd ?? 0) > 0
    );
  } catch {
    return false;
  }
}

export function startAutoMigration(
  connection: Connection,
  mint: PublicKey
): { stop: () => void } {
  if (CONFIG.dryRun) {
    log.warn("DRY_RUN: Auto-migration monitor not started");
    return { stop: () => {} };
  }

  let running = true;
  let lastProgress = 0;

  log.success(`Auto-migration monitor started for ${mint.toBase58().slice(0, 12)}...`);

  const loop = async () => {
    await sleep(10_000);
    while (running) {
      try {
        const { progress, completed, unreadable } = await checkBondingCurveProgress(connection, mint);

        if (!unreadable && progress >= 0 && Math.abs(progress - lastProgress) >= 5) {
          log.info(`Bonding curve progress: ${progress.toFixed(1)}%`);
          lastProgress = progress;
        }

        if (completed) {
          log.success("Bonding curve completed — checking DEX migration...");
          const migrated = await checkIfMigrated(mint);
          if (migrated) {
            log.success("Token migrated to PumpSwap/Raydium!");
            running = false;
            break;
          } else {
            log.info("Curve complete but DEX not visible yet — will recheck");
          }
        }
      } catch (err: any) {
        log.warn(`Migration monitor error: ${err.message}`);
      }
      await sleep(lastProgress >= 100 ? 30_000 : 7_000);
    }
  };
  loop();

  return { stop: () => { running = false; log.info("Migration monitor stopped"); } };
}
