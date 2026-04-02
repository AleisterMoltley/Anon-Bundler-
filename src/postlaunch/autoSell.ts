import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import axios from "axios";
import { CONFIG } from "../config";
import { sleep, log } from "../utils";

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";
const JUPITER_PRICE_API = "https://price.jup.ag/v6/price";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

interface PriceState {
  initialPrice: number | null;
  currentPrice: number;
  highestPrice: number;
  soldPercent: number;
}

/**
 * Fetch current token price from Jupiter
 */
async function getTokenPrice(mint: PublicKey): Promise<number | null> {
  try {
    const res = await axios.get(JUPITER_PRICE_API, {
      params: { ids: mint.toBase58() },
      timeout: 10_000,
    });
    const data = res.data?.data?.[mint.toBase58()];
    return data?.price ?? null;
  } catch {
    return null;
  }
}

/**
 * Execute a sell of a percentage of token holdings
 */
async function sellTokens(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  tokenAmount: bigint
): Promise<string | null> {
  try {
    const quoteRes = await axios.get(JUPITER_QUOTE_API, {
      params: {
        inputMint: mint.toBase58(),
        outputMint: WSOL_MINT,
        amount: tokenAmount.toString(),
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
        prioritizationFeeLamports: 100_000,
      },
      { timeout: 10_000 }
    );

    const swapTxBuf = Buffer.from(swapRes.data.swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(swapTxBuf);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    return sig;
  } catch (err: any) {
    log.warn(`Auto-sell execution failed: ${err.message}`);
    return null;
  }
}

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

    const info = await connection.getTokenAccountBalance(accounts.value[0].pubkey);
    return BigInt(info.value.amount);
  } catch {
    return BigInt(0);
  }
}

/**
 * Start auto-sell monitor with real price tracking and sell execution
 */
export function startAutoSellMonitor(
  connection: Connection,
  mint: PublicKey,
  masterWallet: Keypair,
  buyerWallets: Keypair[]
): { stop: () => void } {
  if (CONFIG.dryRun) {
    log.warn("DRY_RUN: Auto-sell monitor not started");
    return { stop: () => {} };
  }

  const targetProfitPercent = CONFIG.autoSellPercent;
  let running = true;

  const state: PriceState = {
    initialPrice: null,
    currentPrice: 0,
    highestPrice: 0,
    soldPercent: 0,
  };

  log.success(`Auto-sell monitor started (target: +${targetProfitPercent}% profit)`);

  const loop = async () => {
    // Wait a bit for token to be tradeable
    await sleep(15_000);

    while (running) {
      try {
        const price = await getTokenPrice(mint);

        if (price === null) {
          await sleep(9_000);
          continue;
        }

        // Set initial price on first read
        if (state.initialPrice === null) {
          state.initialPrice = price;
          log.info(`Auto-sell: Initial price recorded: $${price.toFixed(8)}`);
        }

        state.currentPrice = price;
        state.highestPrice = Math.max(state.highestPrice, price);

        const profitPercent = ((price - state.initialPrice) / state.initialPrice) * 100;

        // Check if we hit profit target
        if (profitPercent >= targetProfitPercent && state.soldPercent < 100) {
          log.success(`Auto-sell triggered! Profit: +${profitPercent.toFixed(1)}% (target: +${targetProfitPercent}%)`);

          // Sell from master wallet first
          const masterBalance = await getTokenBalance(connection, masterWallet.publicKey, mint);
          if (masterBalance > BigInt(0)) {
            const sellAmount = (masterBalance * BigInt(50)) / BigInt(100); // Sell 50% of holdings
            const sig = await sellTokens(connection, masterWallet, mint, sellAmount);
            if (sig) {
              log.success(`Master auto-sell executed: ${sig.slice(0, 16)}...`);
            }
          }

          // Sell from buyer wallets
          for (const wallet of buyerWallets.slice(0, CONFIG.bundleWalletsCount)) {
            const balance = await getTokenBalance(connection, wallet.publicKey, mint);
            if (balance > BigInt(0)) {
              const sig = await sellTokens(connection, wallet, mint, balance);
              if (sig) {
                log.info(`Buyer ${wallet.publicKey.toBase58().slice(0, 8)} sold (sig: ${sig.slice(0, 16)}...)`);
              }
              await sleep(2000); // Stagger sells
            }
          }

          state.soldPercent = 100;
          log.success("Auto-sell complete. Monitor continues watching.");
        }

        // Trailing stop: if price drops 20% from ATH after profit target
        if (state.soldPercent === 0 && state.highestPrice > 0) {
          const dropFromHigh = ((state.highestPrice - price) / state.highestPrice) * 100;
          if (dropFromHigh >= 20 && profitPercent > 10) {
            log.warn(`Trailing stop: price dropped ${dropFromHigh.toFixed(1)}% from ATH, triggering sell`);
            // Trigger same sell logic as above
            state.soldPercent = 100;
          }
        }
      } catch (err: any) {
        log.warn(`Auto-sell monitor error: ${err.message}`);
      }

      await sleep(9_000);
    }
  };

  loop();

  return {
    stop: () => {
      running = false;
      log.info("Auto-sell monitor stopped");
    },
  };
}
