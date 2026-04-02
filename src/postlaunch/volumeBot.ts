import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import axios from "axios";
import { CONFIG } from "../config";
import { randomAmount, randomDelay, sleep, log, jupiterLimiter } from "../utils";

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Get token balance for a wallet
 */
async function getTokenBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey
): Promise<bigint> {
  try {
    const accounts = await connection.getTokenAccountsByOwner(wallet, { mint });
    if (accounts.value.length === 0) return BigInt(0);
    const info = await connection.getTokenAccountBalance(accounts.value[0]!.pubkey);
    return BigInt(info.value.amount);
  } catch {
    return BigInt(0);
  }
}

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
    await jupiterLimiter.wait();

    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

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

    await jupiterLimiter.wait();

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

    log.info(
      `Volume buy: ${solAmount} SOL from ${wallet.publicKey.toBase58().slice(0, 8)}... (sig: ${sig.slice(0, 16)}...)`
    );
    return sig;
  } catch (err: any) {
    log.warn(`Volume buy failed: ${err.message}`);
    return null;
  }
}

/**
 * Execute a single sell via Jupiter
 *
 * FIX #9: Sell a percentage of actual token balance instead of
 * using SOL amount * 1e9 (which was completely wrong)
 */
async function executeSell(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  sellPercent: number = 10
): Promise<string | null> {
  try {
    // Get actual token balance
    const balance = await getTokenBalance(connection, wallet.publicKey, mint);
    if (balance === BigInt(0)) {
      return null; // nothing to sell
    }

    // Sell a percentage of holdings
    const sellAmount = (balance * BigInt(sellPercent)) / BigInt(100);
    if (sellAmount === BigInt(0)) return null;

    await jupiterLimiter.wait();

    const quoteRes = await axios.get(JUPITER_QUOTE_API, {
      params: {
        inputMint: mint.toBase58(),
        outputMint: WSOL_MINT,
        amount: sellAmount.toString(),
        slippageBps: CONFIG.slippageBps,
      },
      timeout: 10_000,
    });

    if (!quoteRes.data) return null;

    await jupiterLimiter.wait();

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

    log.info(
      `Volume sell: ${sellPercent}% from ${wallet.publicKey.toBase58().slice(0, 8)}... (sig: ${sig.slice(0, 16)}...)`
    );
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
        const wallet = wallets[walletIndex % wallets.length]!;
        walletIndex++;

        const amount = randomAmount(0.005, 0.09);
        const jitter = randomDelay(0, Math.floor(intervalMs * 0.3));

        await sleep(intervalMs + jitter);

        if (!running) break;

        // 70% buy, 30% sell for organic-looking volume
        if (Math.random() < 0.7) {
          await executeBuy(connection, wallet, mint, amount);
        } else {
          // FIX #9: Sell 5-15% of actual token balance
          await executeSell(connection, wallet, mint, randomAmount(5, 15));
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
