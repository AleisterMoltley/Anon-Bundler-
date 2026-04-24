import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  Raydium,
  TxVersion,
  CREATE_CPMM_POOL_PROGRAM,
  CREATE_CPMM_POOL_FEE_ACC,
  DEVNET_PROGRAM_ID,
} from "@raydium-io/raydium-sdk-v2";
import { CONFIG } from "../config";
import { log, retry } from "../utils";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/**
 * Launch on Raydium V2 CPMM.
 *
 * NOTE: Raydium does NOT support atomic bundle buys — pool must be confirmed
 * onchain before swaps can be built. Buyer wallets are used by volumeBot instead.
 */
export async function launchOnRaydium(
  creator: Keypair,
  connection: Connection,
  buyerWallets: Keypair[]
): Promise<{ mint: PublicKey; transactions: VersionedTransaction[] }> {
  log.step("Starting Raydium V2 CPMM pool creation...");

  if (CONFIG.dryRun) {
    log.warn("DRY_RUN: Simulating Raydium launch");
    return { mint: Keypair.generate().publicKey, transactions: [] };
  }

  const isDevnet = CONFIG.rpcUrl.includes("devnet");

  // 1. Create base mint (9 decimals, standard SPL)
  const baseMint = await retry(
    async () => {
      const mint = await createMint(connection, creator, creator.publicKey, null, 9);
      log.success(`Base mint: ${mint.toBase58()}`);
      return mint;
    },
    { retries: 2, label: "createMint" }
  );

  // 2. Mint initial supply to creator (1B @ 9 decimals)
  const creatorAta = await getOrCreateAssociatedTokenAccount(
    connection,
    creator,
    baseMint,
    creator.publicKey
  );
  await mintTo(
    connection,
    creator,
    baseMint,
    creatorAta.address,
    creator,
    1_000_000_000_000_000_000n // 1B * 1e9 (matches 9-decimal supply)
  );
  log.success("Minted 1B tokens to creator");

  // 3. Load Raydium SDK
  const raydium = await Raydium.load({
    connection,
    owner: creator,
    cluster: isDevnet ? "devnet" : "mainnet",
  });

  // 4. Fetch CPMM fee config (required by v0.2.x createPool)
  const cpmmConfigs = await raydium.api.getCpmmConfigs();
  if (!cpmmConfigs || cpmmConfigs.length === 0) {
    throw new Error("No CPMM fee configs returned by Raydium API");
  }
  const feeConfig = cpmmConfigs[0]!;

  // 5. Create CPMM pool — 500M tokens + 10 SOL initial liquidity
  const baseAmount = new BN("500000000000000000"); // 500M * 1e9
  const quoteAmount = new BN(10 * LAMPORTS_PER_SOL);

  const programId = isDevnet
    ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM
    : CREATE_CPMM_POOL_PROGRAM;
  const poolFeeAccount = isDevnet
    ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC
    : CREATE_CPMM_POOL_FEE_ACC;

  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId,
    poolFeeAccount,
    mintA: {
      address: baseMint.toBase58(),
      decimals: 9,
      programId: TOKEN_PROGRAM_ID.toBase58(),
    },
    mintB: {
      address: WSOL_MINT.toBase58(),
      decimals: 9,
      programId: TOKEN_PROGRAM_ID.toBase58(),
    },
    mintAAmount: baseAmount,
    mintBAmount: quoteAmount,
    startTime: new BN(Math.floor(Date.now() / 1000)),
    feeConfig,
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  });

  log.step("Executing CPMM pool creation...");
  const { txId } = await execute({ sendAndConfirm: true });
  log.success(`CPMM pool created! TX: ${txId}`);
  log.success(`Pool ID: ${extInfo.address.poolId.toBase58()}`);

  log.info(`${buyerWallets.length} buyer wallets available for post-launch volume`);

  return { mint: baseMint, transactions: [] };
}
