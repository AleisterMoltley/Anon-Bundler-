import { Connection, PublicKey } from "@solana/web3.js";
import axios from "axios";
import { sleep, log } from "../utils";
import { CONFIG } from "../config";

const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// Pump.fun bonding curve account discriminator (first 8 bytes)
// This should be verified against the actual program
const BONDING_CURVE_DISCRIMINATOR = Buffer.from([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);

// Expected account data size for bonding curve
const EXPECTED_MIN_SIZE = 128; // bytes

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
 *
 * FIX #8: Validate account data structure before reading offsets.
 * Checks discriminator, minimum data length, and validates the read
 * value is within a sane range.
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

    const data = accountInfo.data;

    // Account closed or too small = likely migrated
    if (data.length < EXPECTED_MIN_SIZE) {
      return { progress: 100, completed: true };
    }

    // FIX #8: Validate discriminator before reading data
    const discriminator = data.subarray(0, 8);
    if (!discriminator.equals(BONDING_CURVE_DISCRIMINATOR)) {
      log.warn(
        `Bonding curve discriminator mismatch. Expected ${BONDING_CURVE_DISCRIMINATOR.toString("hex")}, ` +
          `got ${discriminator.toString("hex")}. Account layout may have changed.`
      );
      // Fall back to checking if account still has data (rough heuristic)
      return { progress: -1, completed: false };
    }

    // Read virtualSolReserves at offset 8 (u64 LE, after 8-byte discriminator)
    const virtualSolReserves = Number(data.readBigUInt64LE(8)) / 1e9;

    // Sanity check: reserves should be between 0 and 200 SOL
    if (virtualSolReserves < 0 || virtualSolReserves > 200) {
      log.warn(
        `Bonding curve virtualSolReserves out of range: ${virtualSolReserves} SOL. ` +
          `Account layout may have changed.`
      );
      return { progress: -1, completed: false };
    }

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
async function checkIfMigrated(connection: Connection, mint: PublicKey): Promise<boolean> {
  try {
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
    await sleep(10_000);

    while (running) {
      try {
        const { progress, completed } = await checkBondingCurveProgress(connection, mint);

        // Skip logging if we can't read the curve (-1 = unreadable)
        if (progress >= 0 && Math.abs(progress - lastProgress) >= 5) {
          log.info(`Bonding curve progress: ${progress.toFixed(1)}%`);
          lastProgress = progress;
        }

        if (completed) {
          log.success("Bonding curve completed! Checking migration status...");

          const migrated = await checkIfMigrated(connection, mint);

          if (migrated) {
            log.success("Token has been migrated to PumpSwap/Raydium!");
            log.info("Migration monitor complete — stopping.");
            running = false;
            break;
          } else {
            log.info("Bonding curve complete but not yet migrated. Pump.fun will auto-migrate.");
          }
        }
      } catch (err: any) {
        log.warn(`Migration monitor error: ${err.message}`);
      }

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
