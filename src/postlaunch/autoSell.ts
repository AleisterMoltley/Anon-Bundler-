import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import axios from "axios";
import { CONFIG } from "../config";
import {
  sleep,
  log,
  jupiterLimiter,
  JUPITER_QUOTE_API,
  JUPITER_SWAP_API,
  JUPITER_PRICE_API,
  WSOL_MINT,
  jupiterHeaders,
} from "../utils";

interface PriceState {
  initialPrice: number | null;
  highestPrice: number;
  soldAll: boolean;
}

/**
 * Fetch USD price from Jupiter Price V3.
 * Response shape: { "<mint>": { usdPrice, blockId, decimals, priceChange24h } }
 */
async function getTokenPrice(mint: PublicKey): Promise<number | null> {
  try {
    await jupiterLimiter.wait();
    const res = await axios.get(JUPITER_PRICE_API, {
      params: { ids: mint.toBase58() },
      headers: jupiterHeaders(),
      timeout: 10_000,
    });
    const entry = res.data?.[mint.toBase58()];
    return typeof entry?.usdPrice === "number" ? entry.usdPrice : null;
  } catch {
    return null;
  }
}

async function getTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<bigint> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner, true);
    const info = await connection.getTokenAccountBalance(ata);
    return BigInt(info.value.amount);
  } catch {
    return BigInt(0);
  }
}

async function sellViaJupiter(
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
      headers: jupiterHeaders(),
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
      { headers: jupiterHeaders(), timeout: 10_000 }
    );

    const swapTxBuf = Buffer.from(swapRes.data.swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(swapTxBuf);
    tx.sign([wallet]);

    return await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (err: any) {
    log.warn(`Auto-sell failed: ${err.message}`);
    return null;
  }
}

async function executeSellAll(
  connection: Connection,
  mint: PublicKey,
  masterWallet: Keypair,
  buyerWallets: Keypair[],
  reason: string
): Promise<void> {
  log.success(`Selling all positions — reason: ${reason}`);

  // Master: 50% of holdings
  const masterBal = await getTokenBalance(connection, masterWallet.publicKey, mint);
  if (masterBal > 0n) {
    const sellAmount = (masterBal * 50n) / 100n;
    const sig = await sellViaJupiter(connection, masterWallet, mint, sellAmount);
    if (sig) log.success(`Master sold 50%: ${sig.slice(0, 16)}...`);
  }

  // Buyer wallets: 100%, staggered
  for (const wallet of buyerWallets.slice(0, CONFIG.bundleWalletsCount)) {
    const bal = await getTokenBalance(connection, wallet.publicKey, mint);
    if (bal > 0n) {
      const sig = await sellViaJupiter(connection, wallet, mint, bal);
      if (sig) log.info(`Buyer ${wallet.publicKey.toBase58().slice(0, 8)} sold 100%: ${sig.slice(0, 16)}...`);
      await sleep(2000);
    }
  }

  log.success("Auto-sell complete.");
}

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

  const target = CONFIG.autoSellPercent;
  let running = true;
  const state: PriceState = { initialPrice: null, highestPrice: 0, soldAll: false };

  log.success(`Auto-sell monitor started (target: +${target}%)`);

  const loop = async () => {
    await sleep(15_000); // let token become tradeable

    while (running && !state.soldAll) {
      try {
        const price = await getTokenPrice(mint);
        if (price === null) {
          await sleep(9_000);
          continue;
        }

        if (state.initialPrice === null) {
          state.initialPrice = price;
          log.info(`Auto-sell: initial price $${price.toFixed(8)}`);
        }

        state.highestPrice = Math.max(state.highestPrice, price);
        const profitPct = ((price - state.initialPrice) / state.initialPrice) * 100;

        // Profit target
        if (profitPct >= target) {
          log.success(`Profit target: +${profitPct.toFixed(1)}% (target +${target}%)`);
          await executeSellAll(connection, mint, masterWallet, buyerWallets, `profit +${profitPct.toFixed(1)}%`);
          state.soldAll = true;
          break;
        }

        // Trailing stop: drop >20% from ATH while still >10% up
        const dropFromAth = ((state.highestPrice - price) / state.highestPrice) * 100;
        if (dropFromAth >= 20 && profitPct > 10) {
          log.warn(`Trailing stop: -${dropFromAth.toFixed(1)}% from ATH (profit +${profitPct.toFixed(1)}%)`);
          await executeSellAll(connection, mint, masterWallet, buyerWallets, `trailing stop -${dropFromAth.toFixed(1)}%`);
          state.soldAll = true;
          break;
        }
      } catch (err: any) {
        log.warn(`Auto-sell loop error: ${err.message}`);
      }
      await sleep(9_000);
    }
  };
  loop();

  return { stop: () => { running = false; log.info("Auto-sell monitor stopped"); } };
}
