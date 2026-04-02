import { Keypair } from "@solana/web3.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CONFIG } from "./config";
import { log } from "./utils";

const VAULT_DIR = path.resolve("wallets");
const VAULT_FILE = path.join(VAULT_DIR, "vault.enc");

// === AES-256-GCM Encryption ===

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, 100_000, 32, "sha256");
}

function encrypt(data: string, password: string): Buffer {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]);
}

function decrypt(buf: Buffer, password: string): string {
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const ciphertext = buf.subarray(44);
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

// === Wallet Vault (FIX #4: Always encrypted, no plaintext fallback) ===

function serializeWallets(wallets: Keypair[]): string {
  return JSON.stringify(
    wallets.map((w) => Buffer.from(w.secretKey).toString("base64")),
    null,
    2
  );
}

function deserializeWallets(json: string): Keypair[] {
  const keys: string[] = JSON.parse(json);
  return keys.map((k) => Keypair.fromSecretKey(Buffer.from(k, "base64")));
}

export function saveWalletVault(wallets: Keypair[]): void {
  if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });

  if (!CONFIG.walletVaultPassword) {
    // In dry-run mode, config validation won't catch this, so just warn
    log.warn("No WALLET_VAULT_PASSWORD set — wallet vault NOT saved to disk");
    return;
  }

  const json = serializeWallets(wallets);
  const encrypted = encrypt(json, CONFIG.walletVaultPassword);
  fs.writeFileSync(VAULT_FILE, encrypted);
  log.success(`Wallet vault saved (encrypted, ${wallets.length} wallets)`);
}

export function loadWalletVault(): Keypair[] | null {
  try {
    if (CONFIG.walletVaultPassword && fs.existsSync(VAULT_FILE)) {
      const buf = fs.readFileSync(VAULT_FILE);
      const json = decrypt(buf, CONFIG.walletVaultPassword);
      const wallets = deserializeWallets(json);
      log.info(`Loaded ${wallets.length} wallets from encrypted vault`);
      return wallets;
    }
  } catch (err: any) {
    log.error(`Failed to load wallet vault: ${err.message}`);
  }
  return null;
}

// === Wallet Generation ===

export async function generateWallets(count: number): Promise<Keypair[]> {
  const existing = loadWalletVault();
  if (existing && existing.length >= count) {
    log.info(`Reusing ${count} wallets from vault (${existing.length} available)`);
    return existing.slice(0, count);
  }

  const wallets: Keypair[] = [];
  const hasVanity = CONFIG.vanityPrefix.length > 0;
  const timeoutMs = CONFIG.vanityTimeoutSec * 1000;
  const start = Date.now();

  log.step(
    `Generating ${count} wallets${hasVanity ? ` (vanity: ${CONFIG.vanityPrefix}, timeout: ${CONFIG.vanityTimeoutSec}s)` : ""}...`
  );

  while (wallets.length < count) {
    const kp = Keypair.generate();

    if (hasVanity) {
      if (Date.now() - start > timeoutMs) {
        log.warn(
          `Vanity timeout reached after ${CONFIG.vanityTimeoutSec}s — generated ${wallets.length}/${count}, filling rest without vanity`
        );
        while (wallets.length < count) {
          wallets.push(Keypair.generate());
        }
        break;
      }
      if (!kp.publicKey.toBase58().toUpperCase().startsWith(CONFIG.vanityPrefix.toUpperCase())) {
        continue;
      }
    }

    wallets.push(kp);

    if (wallets.length % 50 === 0) {
      log.info(`${wallets.length}/${count} wallets generated...`);
    }
  }

  saveWalletVault(wallets);
  log.success(`${wallets.length} wallets generated and saved to vault`);
  return wallets;
}
