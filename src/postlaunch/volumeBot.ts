import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import axios from "axios";
import { CONFIG } from "../config";
import {
  randomAmount,
  randomDelay,
  sleep,
  log,
  jupiterLimiter,
  JUPITER_QUOTE_API,
  JUPITER_SWAP_API,
  WSOL_MINT,
  jupiterHeaders,
} from "../utils";

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
        prioritizationFeeLamports: 50_000,
      },
      { headers: jupiterHeaders(), timeout: 10_000 }
    );

    const swapTxBuf = Buffer.from(swapRes.data.swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(swapTxBuf);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });
    log.info(`Volume buy: ${solAmount} SOL from ${wallet.publicKey.toBase58().slice(0, 8)} (${sig.slice(0, 16)}...)`);
    return sig;
  } catch (err: any) {
    log.warn(`Volume buy failed: ${err.message}`);
    return null;
  }
}

async function executeSell(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  sellPercent: number
): Promise<string | null> {
  try {
    const balance = await getTokenBalance(connection, wallet.publicKey, mint);
    if (balance === 0n) return null;
    const sellAmount = (balance * BigInt(Math.floor(sellPercent))) / 100n;
    if (sellAmount === 0n) return null;

    await jupiterLimiter.wait();
    const quoteRes = await axios.get(JUPITER_QUOTE_API, {
      params: {
        inputMint: mint.toBase58(),
        outputMint: WSOL_MINT,
        amount: sellAmount.toString(),
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
        prioritizationFeeLamports: 50_000,
      },
      { headers: jupiterHeaders(), timeout: 10_000 }
    );

    const swapTxBuf = Buffer.from(swapRes.data.swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(swapTxBuf);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });
    log.info(`Volume sell: ${sellPercent}% from ${wallet.publicKey.toBase58().slice(0, 8)} (${sig.slice(0, 16)}...)`);
    return sig;
  } catch (err: any) {
    log.warn(`Volume sell failed: ${err.message}`);
    return null;
  }
}

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
  let idx = 0;

  log.success(`Volume bot started: ${CONFIG.volumeBuysPerMin}/min, ${wallets.length} wallets`);

  const loop = async () => {
    while (running) {
      try {
        const wallet = wallets[idx % wallets.length]!;
        idx++;
        const amount = randomAmount(0.005, 0.09);
        const jitter = randomDelay(0, Math.floor(intervalMs * 0.3));
        await sleep(intervalMs + jitter);
        if (!running) break;

        if (Math.random() < 0.7) {
          await executeBuy(connection, wallet, mint, amount);
        } else {
          await executeSell(connection, wallet, mint, randomAmount(5, 15));
        }
      } catch (err: any) {
        log.warn(`Volume bot cycle error: ${err.message}`);
        await sleep(5000);
      }
    }
  };
  loop();

  return { stop: () => { running = false; log.info("Volume bot stopped"); } };
}
