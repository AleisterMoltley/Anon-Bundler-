import { Connection, PublicKey } from "@solana/web3.js";
import axios from "axios";
import { sleep, log } from "../utils";
import { CONFIG } from "../config";

const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

/**
 * Derive the bonding curve PDA for a given mint
 */
function getBondingCurveAddress(mint: PublicKey): PublicKey {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  );
  return bondingCurve;
}

/**
 * Check bonding curve progress from onchain data
 * Returns progress as 0-100 percent
 */
async function checkBondingCurveProgress(
  connection: Connection,
  mint: PublicKey
): Promise<{ progress: number; completed: boolean }> {
  try {
    const bondingCurve = getBondingCurveAddress(mint);
    const accountInfo = await connection.getAccountInfo(bondingCurve);

    if (!accountInfo) {
      return { progress: 0, completed: false };
    }

    // Pump.fun bonding curve account layout:
    // The curve completes when virtualSolReserves reach the threshold (~85 SOL)
    // Exact offsets depend on Pump.fun program version
    const data = accountInfo.data;

    // Check if account is still active (not migrated yet)
    if (data.length < 64) {
      // Account too small or already closed = likely migrated
      return { progress: 100, completed: true };
    }

    // Read virtualSolReserves (offset varies, common is at byte 8, u64 LE)
    const virtualSolReserves = Number(data.readBigUInt64LE(8)) / 1e9;

    // Pump.fun bonding curve completes around 85 SOL
    const targetSol = 85;
    const progress = Math.min(100, (virtualSolReserves / targetSol) * 100);
    const completed = virtualSolReserves >= targetSol;

    return { progress, completed };
  } catch (err: any) {
    log.warn(`Bonding curve check failed: ${err.message}`);
    return { progress: 0, completed: false };
  }
}

/**
 * Check if migration to PumpSwap (Raydium) has already occurred
 */
async function checkIfMigrated(
  connection: Connection,
  mint: PublicKey
): Promise<boolean> {
  try {
    // Check if there's a Raydium pool for this token (via DexScreener API)
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint.toBase58()}`,
      { timeout: 10_000 }
    );

    const pairs = res.data?.pairs || [];
    const hasRaydiumPool = pairs.some(
      (p: any) => p.dexId === "raydium" && p.liquidity?.usd > 0
    );

    return hasRaydiumPool;
  } catch {
    return false;
  }
}

/**
 * Start auto-migration monitor
 * Watches bonding curve progress and detects migration to PumpSwap/Raydium
 */
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
    // Initial delay for token to settle
    await sleep(10_000);

    while (running) {
      try {
        const { progress, completed } = await checkBondingCurveProgress(connection, mint);

        // Log progress changes
        if (Math.abs(progress - lastProgress) >= 5) {
          log.info(`Bonding curve progress: ${progress.toFixed(1)}%`);
          lastProgress = progress;
        }

        if (completed) {
          log.success("Bonding curve completed! Checking migration status...");

          // Check if already migrated
          const migrated = await checkIfMigrated(connection, mint);

          if (migrated) {
            log.success("Token has been migrated to PumpSwap/Raydium!");
            log.info("Migration monitor complete — stopping.");
            running = false;
            break;
          } else {
            log.info("Bonding curve complete but not yet migrated. Pump.fun will auto-migrate.");
            log.info("Waiting for migration...");
          }
        }
      } catch (err: any) {
        log.warn(`Migration monitor error: ${err.message}`);
      }

      // Poll every 7s during active phase, 30s after completion
      await sleep(lastProgress >= 100 ? 30_000 : 7_000);
    }
  };

  loop();

  return {
    stop: () => {
      running = false;
      log.info("Migration monitor stopped");
    },
  };
}
