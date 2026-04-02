import dotenv from "dotenv";
dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val || val.trim() === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val.trim();
}

function optionalEnv(key: string, fallback: string): string {
  return (process.env[key] || "").trim() || fallback;
}

function intEnv(key: string, fallback: number, min?: number, max?: number): number {
  const val = parseInt(process.env[key] || String(fallback));
  if (isNaN(val)) return fallback;
  if (min !== undefined && val < min) return min;
  if (max !== undefined && val > max) return max;
  return val;
}

function floatEnv(key: string, fallback: number): number {
  const val = parseFloat(process.env[key] || String(fallback));
  return isNaN(val) ? fallback : val;
}

export const CONFIG = {
  // RPC
  rpcUrl: requireEnv("RPC_URL"),
  masterPrivateKey: requireEnv("MASTER_PRIVATE_KEY"),

  // Mode
  mode: optionalEnv("MODE", "pump").toLowerCase() as "pump" | "raydium" | "multi",

  // Token config
  tokenName: optionalEnv("TOKEN_NAME", "MyToken"),
  tokenSymbol: optionalEnv("TOKEN_SYMBOL", "MTK"),
  tokenDescription: optionalEnv("TOKEN_DESCRIPTION", ""),
  tokenImageUrl: optionalEnv("TOKEN_IMAGE_URL", ""),

  // Wallet config
  numWallets: intEnv("NUM_WALLETS", 20, 1, 300),
  solPerWallet: floatEnv("SOL_PER_WALLET", 0.28),

  // FIX #3/#14: Max 3 bundle wallets (create TX + 3 buyers + tip = 5 Jito max)
  bundleWalletsCount: intEnv("BUNDLE_WALLETS_COUNT", 3, 1, 3),

  jitoTipLamports: intEnv("JITO_TIP_LAMPORTS", 950_000, 100_000, 10_000_000),
  vanityPrefix: optionalEnv("VANITY_PREFIX", ""),
  vanityTimeoutSec: intEnv("VANITY_TIMEOUT_SEC", 30, 5, 300),

  // Slippage — capped at 10% max
  slippageBps: intEnv("SLIPPAGE_BPS", 500, 50, 1000),

  // FIX #13: Creator buy amount configurable
  creatorBuySol: floatEnv("CREATOR_BUY_SOL", 0.5),

  // Post-launch
  autoMigrate: process.env.AUTO_MIGRATE !== "false",
  volumeEnabled: process.env.VOLUME_BOT_ENABLED !== "false",
  volumeBuysPerMin: intEnv("VOLUME_BUYS_PER_MIN", 12, 1, 30), // FIX #17: Cap at 30 to avoid rate limits
  autoSellPercent: intEnv("AUTO_SELL_PERCENT", 35, 5, 95),

  // Metadata
  pinataJwt: optionalEnv("PINATA_JWT", ""),

  // Security
  walletVaultPassword: optionalEnv("WALLET_VAULT_PASSWORD", ""),
  dryRun: process.env.DRY_RUN === "true",
};

export function validateConfig() {
  if (CONFIG.masterPrivateKey.length < 40) {
    throw new Error("MASTER_PRIVATE_KEY looks invalid (too short)");
  }
  if (!CONFIG.rpcUrl.startsWith("https://")) {
    throw new Error("RPC_URL must use HTTPS");
  }

  // FIX #4: Require vault password for real launches
  if (!CONFIG.dryRun && !CONFIG.walletVaultPassword) {
    throw new Error(
      "WALLET_VAULT_PASSWORD is required for non-dry-run launches. " +
        "Generated wallet private keys will be written to disk — set a password to encrypt them."
    );
  }

  if (CONFIG.dryRun) {
    console.log("⚠️  DRY_RUN mode active — no transactions will be sent onchain");
  }
}
