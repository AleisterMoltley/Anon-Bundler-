import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import axios from "axios";
import { CONFIG } from "../config";
import { sleep, log, jupiterLimiter } from "../utils";

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
    await jupiterLimiter.wait();
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
 * Execute a sell of token holdings
 */
async function sellTokens(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  tokenAmount: bigint
): Promise<string | null> {
  try {
    await jupiterLimiter.wait();

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

    await jupiterLimiter.wait();

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
    const info = await connection.getTokenAccountBalance(accounts.value[0]!.pubkey);
    return BigInt(info.value.amount);
  } catch {
    return BigInt(0);
  }
}

/**
 * Execute sells across master + buyer wallets
 * Extracted to avoid code duplication between profit target and trailing stop
 *
 * FIX #7: Shared sell logic so trailing stop actually sells
 */
async function executeSellAll(
  connection: Connection,
  mint: PublicKey,
  masterWallet: Keypair,
  buyerWallets: Keypair[],
  reason: string
): Promise<void> {
  log.success(`Selling all positions — reason: ${reason}`);

  // Sell from master wallet first (50% of holdings)
  const masterBalance = await getTokenBalance(connection, masterWallet.publicKey, mint);
  if (masterBalance > BigInt(0)) {
    const sellAmount = (masterBalance * BigInt(50)) / BigInt(100);
    const sig = await sellTokens(connection, masterWallet, mint, sellAmount);
    if (sig) {
      log.success(`Master auto-sell executed: ${sig.slice(0, 16)}...`);
    }
  }

  // Sell from buyer wallets (100% of holdings)
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

  log.success("Auto-sell complete.");
}

/**
 * Start auto-sell monitor with real price tracking and sell execution
 *
 * FIX #7: Trailing stop now actually triggers sell execution
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
          log.success(
            `Profit target triggered! Profit: +${profitPercent.toFixed(1)}% (target: +${targetProfitPercent}%)`
          );

          await executeSellAll(
            connection,
            mint,
            masterWallet,
            buyerWallets,
            `profit target +${profitPercent.toFixed(1)}%`
          );

          state.soldPercent = 100;
        }

        // FIX #7: Trailing stop — actually execute sells (was just setting flag before)
        if (state.soldPercent === 0 && state.highestPrice > 0) {
          const dropFromHigh = ((state.highestPrice - price) / state.highestPrice) * 100;
          if (dropFromHigh >= 20 && profitPercent > 10) {
            log.warn(
              `Trailing stop: price dropped ${dropFromHigh.toFixed(1)}% from ATH (profit still +${profitPercent.toFixed(1)}%)`
            );

            await executeSellAll(
              connection,
              mint,
              masterWallet,
              buyerWallets,
              `trailing stop -${dropFromHigh.toFixed(1)}% from ATH`
            );

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
