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

function floatEnv(key: string, fallback: number, min?: number, max?: number): number {
  const val = parseFloat(process.env[key] || String(fallback));
  if (isNaN(val)) return fallback;
  if (min !== undefined && val < min) return min;
  if (max !== undefined && val > max) return max;
  return val;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = (process.env[key] || "").trim().toLowerCase();
  if (raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
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
  solPerWallet: floatEnv("SOL_PER_WALLET", 0.28, 0.02),

  // Max 3 bundle wallets (create TX + 3 buyers + tip = 5 Jito max)
  bundleWalletsCount: intEnv("BUNDLE_WALLETS_COUNT", 3, 1, 3),

  // Jito tip config (dynamic via tip_floor, fallback to static)
  jitoTipLamportsFallback: intEnv("JITO_TIP_LAMPORTS", 1_000_000, 1_000, 50_000_000),
  jitoTipMultiplier: floatEnv("JITO_TIP_MULTIPLIER", 1.5, 1.0, 10.0),
  jitoTipPercentile: optionalEnv("JITO_TIP_PERCENTILE", "75") as "25" | "50" | "75" | "95" | "99",
  jitoTipMaxLamports: intEnv("JITO_TIP_MAX_LAMPORTS", 5_000_000, 10_000, 100_000_000),

  vanityPrefix: optionalEnv("VANITY_PREFIX", ""),
  vanityTimeoutSec: intEnv("VANITY_TIMEOUT_SEC", 30, 5, 300),

  // Slippage as BPS (50-1000 bps = 0.5%-10%)
  slippageBps: intEnv("SLIPPAGE_BPS", 500, 50, 1000),

  // Creator + bundle buy amounts
  creatorBuySol: floatEnv("CREATOR_BUY_SOL", 0.5, 0.001),
  bundleBuyMinSol: floatEnv("BUNDLE_BUY_MIN_SOL", 0.09, 0.001),
  bundleBuyMaxSol: floatEnv("BUNDLE_BUY_MAX_SOL", 0.48, 0.001),

  // Post-launch
  autoMigrate: boolEnv("AUTO_MIGRATE", true),
  volumeEnabled: boolEnv("VOLUME_BOT_ENABLED", true),
  volumeBuysPerMin: intEnv("VOLUME_BUYS_PER_MIN", 12, 1, 30),
  autoSellPercent: intEnv("AUTO_SELL_PERCENT", 35, 5, 95),

  // Metadata
  pinataJwt: optionalEnv("PINATA_JWT", ""),

  // Jupiter (optional API key unlocks higher rate limits on Pro tier)
  jupiterApiKey: optionalEnv("JUPITER_API_KEY", ""),

  // Security
  walletVaultPassword: optionalEnv("WALLET_VAULT_PASSWORD", ""),
  dryRun: boolEnv("DRY_RUN", false),
};

export function validateConfig() {
  if (CONFIG.masterPrivateKey.length < 40) {
    throw new Error("MASTER_PRIVATE_KEY looks invalid (too short, expected base58)");
  }
  if (!CONFIG.rpcUrl.startsWith("https://")) {
    throw new Error("RPC_URL must use HTTPS");
  }
  if (CONFIG.bundleBuyMinSol > CONFIG.bundleBuyMaxSol) {
    throw new Error("BUNDLE_BUY_MIN_SOL must be <= BUNDLE_BUY_MAX_SOL");
  }
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
