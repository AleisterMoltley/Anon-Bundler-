import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import axios from "axios";
import { CONFIG } from "../config";
import { randomAmount, randomDelay, sleep, log, retry } from "../utils";

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Execute a single buy via Jupiter
 */
async function executeBuy(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  solAmount: number
): Promise<string | null> {
  try {
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

    // Get Jupiter quote
    const quoteRes = await axios.get(JUPITER_QUOTE_API, {
      params: {
        inputMint: WSOL_MINT,
        outputMint: mint.toBase58(),
        amount: lamports,
        slippageBps: CONFIG.slippageBps,
      },
      timeout: 10_000,
    });

    if (!quoteRes.data) {
      log.warn(`No Jupiter quote for ${solAmount} SOL → ${mint.toBase58().slice(0, 8)}`);
      return null;
    }

    // Get swap transaction
    const swapRes = await axios.post(
      JUPITER_SWAP_API,
      {
        quoteResponse: quoteRes.data,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 50_000,
      },
      { timeout: 10_000 }
    );

    const swapTxBuf = Buffer.from(swapRes.data.swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(swapTxBuf);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });

    log.info(`Volume buy: ${solAmount} SOL from ${wallet.publicKey.toBase58().slice(0, 8)}... (sig: ${sig.slice(0, 16)}...)`);
    return sig;
  } catch (err: any) {
    log.warn(`Volume buy failed: ${err.message}`);
    return null;
  }
}

/**
 * Execute a single sell via Jupiter
 */
async function executeSell(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  tokenAmount: number
): Promise<string | null> {
  try {
    const quoteRes = await axios.get(JUPITER_QUOTE_API, {
      params: {
        inputMint: mint.toBase58(),
        outputMint: WSOL_MINT,
        amount: tokenAmount,
        slippageBps: CONFIG.slippageBps,
      },
      timeout: 10_000,
    });

    if (!quoteRes.data) return null;

    const swapRes = await axios.post(
      JUPITER_SWAP_API,
      {
        quoteResponse: quoteRes.data,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 50_000,
      },
      { timeout: 10_000 }
    );

    const swapTxBuf = Buffer.from(swapRes.data.swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(swapTxBuf);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });

    log.info(`Volume sell from ${wallet.publicKey.toBase58().slice(0, 8)}... (sig: ${sig.slice(0, 16)}...)`);
    return sig;
  } catch (err: any) {
    log.warn(`Volume sell failed: ${err.message}`);
    return null;
  }
}

/**
 * Start the volume bot with real buy/sell cycles
 */
export function startVolumeBot(
  connection: Connection,
  mint: PublicKey,
  wallets: Keypair[]
): { stop: () => void } {
  if (CONFIG.dryRun) {
    log.warn("DRY_RUN: Volume bot not started");
    return { stop: () => {} };
  }

  if (wallets.length === 0) {
    log.warn("No wallets for volume bot");
    return { stop: () => {} };
  }

  const intervalMs = Math.floor(60_000 / CONFIG.volumeBuysPerMin);
  let running = true;
  let walletIndex = 0;

  log.success(`Volume bot started: ${CONFIG.volumeBuysPerMin} buys/min, ${wallets.length} wallets`);

  const loop = async () => {
    while (running) {
      try {
        // Round-robin through wallets
        const wallet = wallets[walletIndex % wallets.length];
        walletIndex++;

        const amount = randomAmount(0.005, 0.09);
        const jitter = randomDelay(0, Math.floor(intervalMs * 0.3));

        await sleep(intervalMs + jitter);

        if (!running) break;

        // 70% buy, 30% sell for organic-looking volume
        if (Math.random() < 0.7) {
          await executeBuy(connection, wallet, mint, amount);
        } else {
          // Sell a small token amount
          await executeSell(connection, wallet, mint, Math.floor(amount * 1e9));
        }
      } catch (err: any) {
        log.warn(`Volume bot cycle error: ${err.message}`);
        await sleep(5000);
      }
    }
  };

  loop();

  return {
    stop: () => {
      running = false;
      log.info("Volume bot stopped");
    },
  };
}
