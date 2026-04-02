import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { CONFIG } from "../config";
import { log, retry, confirmTx } from "../utils";
import BN from "bn.js";

import {
  Raydium,
  TxVersion,
  getCpmmPdaAmmConfigId,
  DEVNET_PROGRAM_ID,
  MAINNET_PROGRAM_ID,
} from "@raydium-io/raydium-sdk-v2";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/**
 * Launch on Raydium V2 CPMM
 *
 * NOTE: Raydium mode does NOT support atomic bundle buys because the pool
 * must be confirmed onchain before swap TXs can be built. Buyer wallets
 * are used by the post-launch volume bot instead.
 */
export async function launchOnRaydium(
  creator: Keypair,
  connection: Connection,
  buyerWallets: Keypair[]
): Promise<{ mint: PublicKey; transactions: VersionedTransaction[] }> {
  log.step("Starting Raydium V2 CPMM Pool Creation...");

  if (CONFIG.dryRun) {
    log.warn("DRY_RUN: Simulating Raydium launch");
    return { mint: Keypair.generate().publicKey, transactions: [] };
  }

  // 1. Create Base Token Mint
  const baseMint = await retry(
    async () => {
      const mint = await createMint(connection, creator, creator.publicKey, null, 9);
      log.success(`Base Token Mint: ${mint.toBase58()}`);
      return mint;
    },
    { retries: 2, label: "createMint" }
  );

  // 2. Mint initial supply to creator
  const creatorBaseATA = await getOrCreateAssociatedTokenAccount(
    connection,
    creator,
    baseMint,
    creator.publicKey
  );

  const mintSig = await mintTo(
    connection,
    creator,
    baseMint,
    creatorBaseATA.address,
    creator,
    1_000_000_000_000 // 1 Billion Tokens (9 decimals)
  );
  await confirmTx(connection, mintSig, "confirmed");
  log.success("Minted 1B tokens to creator");

  // 3. Load Raydium SDK
  const isDevnet = CONFIG.rpcUrl.includes("devnet");
  const raydium = await Raydium.load({
    connection,
    owner: creator,
    cluster: isDevnet ? "devnet" : "mainnet",
  });

  // 4. Create CPMM Pool
  const baseAmount = new BN(500_000_000_000); // 500M tokens
  const quoteAmount = new BN(10 * LAMPORTS_PER_SOL); // 10 SOL

  const feeConfig = await getCpmmPdaAmmConfigId(
    isDevnet ? DEVNET_PROGRAM_ID : MAINNET_PROGRAM_ID
  );

  const { execute, extInfo } = await raydium.cpmm.createPool({
    mintA: baseMint,
    mintB: WSOL_MINT,
    mintAAmount: baseAmount,
    mintBAmount: quoteAmount,
    startTime: new BN(Math.floor(Date.now() / 1000)),
    feeConfig,
    txVersion: TxVersion.V0,
  });

  log.step("Executing CPMM Pool Creation...");

  const { txId } = await execute({ sendAndConfirm: true });
  log.success(`Raydium CPMM Pool created! TX: ${txId}`);
  log.success(`Pool: ${extInfo.poolId.toBase58()}`);

  log.info(`${buyerWallets.length} buyer wallets available for post-launch volume`);

  return { mint: baseMint, transactions: [] };
}
