import {
  Keypair,
  PublicKey,
  Connection,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { CONFIG } from "../config";
import { uploadMetadata } from "../metadata";
import { randomAmount, log } from "../utils";

// === Pump.fun Program Constants ===
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_FUN_TOKEN_MINT_AUTHORITY = new PublicKey("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM");
const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const PUMP_FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ2ESTxMwHri");
const PUMP_EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const SYSTEM_PROGRAM = SystemProgram.programId;
const RENT_PROGRAM = new PublicKey("SysvarRent111111111111111111111111111111111");
const METAPLEX_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// === Pump.fun Bonding Curve Constants ===
// Initial virtual reserves at token creation
const INITIAL_VIRTUAL_TOKEN_RESERVES = BigInt(1_073_000_000_000_000); // ~1.073B tokens (with 6 decimals)
const INITIAL_VIRTUAL_SOL_RESERVES = BigInt(30_000_000_000); // 30 SOL in lamports

/**
 * Calculate expected token output from bonding curve using constant product formula
 * tokens_out = (virtual_token_reserves * sol_in) / (virtual_sol_reserves + sol_in)
 *
 * FIX #2: Actually calculate token amount instead of passing 0
 */
function calculateTokensOut(
  solAmountLamports: bigint,
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint
): bigint {
  const numerator = virtualTokenReserves * solAmountLamports;
  const denominator = virtualSolReserves + solAmountLamports;
  return numerator / denominator;
}

/**
 * Calculate expected tokens for a buy on a fresh bonding curve (first buy)
 */
function calculateInitialBuyTokens(solAmountLamports: bigint): bigint {
  return calculateTokensOut(solAmountLamports, INITIAL_VIRTUAL_SOL_RESERVES, INITIAL_VIRTUAL_TOKEN_RESERVES);
}

/**
 * Build the Pump.fun create token instruction
 */
function buildPumpCreateInstruction(
  creator: PublicKey,
  mint: PublicKey,
  name: string,
  symbol: string,
  metadataUri: string
): TransactionInstruction {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  );
  const bondingCurveAta = getAssociatedTokenAddressSync(mint, bondingCurve, true);

  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_PROGRAM.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM
  );

  // Encode instruction data: discriminator + name + symbol + uri
  const nameBuffer = Buffer.from(name, "utf8");
  const symbolBuffer = Buffer.from(symbol, "utf8");
  const uriBuffer = Buffer.from(metadataUri, "utf8");

  const discriminator = Buffer.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(new Uint32Array([nameBuffer.length]).buffer),
    nameBuffer,
    Buffer.from(new Uint32Array([symbolBuffer.length]).buffer),
    symbolBuffer,
    Buffer.from(new Uint32Array([uriBuffer.length]).buffer),
    uriBuffer,
  ]);

  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM,
    keys: [
      { pubkey: mint, isSigner: true, isWritable: true },
      { pubkey: PUMP_FUN_TOKEN_MINT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: METAPLEX_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: metadataPda, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build a Pump.fun buy instruction
 *
 * FIX #2: Properly calculates minimum token amount from bonding curve
 * instead of passing 0 (which would revert or return 0 tokens)
 */
function buildPumpBuyInstruction(
  buyer: PublicKey,
  mint: PublicKey,
  solAmount: number,
  slippageBps: number,
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint
): TransactionInstruction {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  );
  const bondingCurveAta = getAssociatedTokenAddressSync(mint, bondingCurve, true);
  const buyerAta = getAssociatedTokenAddressSync(mint, buyer);

  const lamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));

  // Calculate expected tokens from bonding curve
  const expectedTokens = calculateTokensOut(lamports, virtualSolReserves, virtualTokenReserves);

  // Apply slippage to get minimum token amount
  const minTokens = (expectedTokens * BigInt(10000 - slippageBps)) / BigInt(10000);

  // Max SOL cost with slippage
  const maxSolCost = lamports + (lamports * BigInt(slippageBps)) / BigInt(10000);

  // Buy discriminator
  const discriminator = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
  const data = Buffer.alloc(8 + 8 + 8);
  discriminator.copy(data);
  data.writeBigUInt64LE(minTokens, 8); // FIX #2: actual minimum token amount
  data.writeBigUInt64LE(maxSolCost, 16);

  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM,
    keys: [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
      { pubkey: buyerAta, isSigner: false, isWritable: true },
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Launch on Pump.fun with local TX construction
 * Returns [mint, transactions[]] for Jito bundling
 *
 * FIX #2: Proper bonding curve math for token amounts
 * FIX #10: Fresh blockhash for each TX
 * FIX #13: Configurable creator buy amount
 */
export async function launchOnPumpFun(
  connection: Connection,
  creator: Keypair,
  buyerWallets: Keypair[]
): Promise<{ mint: PublicKey; transactions: VersionedTransaction[] }> {
  log.step("Building Pump.fun launch bundle locally...");

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  // Upload metadata
  const metadataUri = await uploadMetadata(
    CONFIG.tokenName,
    CONFIG.tokenSymbol,
    CONFIG.tokenDescription,
    CONFIG.tokenImageUrl
  );

  // FIX #10: Get fresh blockhash right before building TXs
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const transactions: VersionedTransaction[] = [];

  // === TX 1: Create token + Creator buy ===

  const createIx = buildPumpCreateInstruction(
    creator.publicKey,
    mint,
    CONFIG.tokenName,
    CONFIG.tokenSymbol,
    metadataUri
  );

  // Track virtual reserves as we simulate buys
  let currentVirtualSol = INITIAL_VIRTUAL_SOL_RESERVES;
  let currentVirtualTokens = INITIAL_VIRTUAL_TOKEN_RESERVES;

  // FIX #13: Configurable creator buy
  const creatorBuyIx = buildPumpBuyInstruction(
    creator.publicKey,
    mint,
    CONFIG.creatorBuySol,
    CONFIG.slippageBps,
    currentVirtualSol,
    currentVirtualTokens
  );

  // Update virtual reserves after creator buy
  const creatorLamports = BigInt(Math.floor(CONFIG.creatorBuySol * LAMPORTS_PER_SOL));
  const creatorTokens = calculateTokensOut(creatorLamports, currentVirtualSol, currentVirtualTokens);
  currentVirtualSol += creatorLamports;
  currentVirtualTokens -= creatorTokens;

  const createMsg = new TransactionMessage({
    payerKey: creator.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: [createIx, creatorBuyIx],
  }).compileToV0Message();

  const createTx = new VersionedTransaction(createMsg);
  createTx.sign([creator, mintKeypair]);
  transactions.push(createTx);

  log.info(
    `Creator buy: ${CONFIG.creatorBuySol} SOL → ~${(Number(creatorTokens) / 1e6).toFixed(0)} tokens`
  );

  // === TX 2-N: Bundle buyer transactions ===
  // Max 3 buyers to stay within Jito 5-tx limit (1 create + 3 buyers + 1 tip)
  const bundleBuyers = buyerWallets.slice(0, Math.min(CONFIG.bundleWalletsCount, 3));

  for (const buyer of bundleBuyers) {
    const buyAmount = randomAmount(0.09, 0.48);
    const buyLamports = BigInt(Math.floor(buyAmount * LAMPORTS_PER_SOL));

    const buyerAtaIx = createAssociatedTokenAccountInstruction(
      buyer.publicKey,
      getAssociatedTokenAddressSync(mint, buyer.publicKey),
      buyer.publicKey,
      mint
    );

    // FIX #2: Use tracked virtual reserves for accurate token calc
    const buyIx = buildPumpBuyInstruction(
      buyer.publicKey,
      mint,
      buyAmount,
      CONFIG.slippageBps,
      currentVirtualSol,
      currentVirtualTokens
    );

    // Update reserves for next buyer
    const buyerTokens = calculateTokensOut(buyLamports, currentVirtualSol, currentVirtualTokens);
    currentVirtualSol += buyLamports;
    currentVirtualTokens -= buyerTokens;

    const buyMsg = new TransactionMessage({
      payerKey: buyer.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: [buyerAtaIx, buyIx],
    }).compileToV0Message();

    const buyTx = new VersionedTransaction(buyMsg);
    buyTx.sign([buyer]);
    transactions.push(buyTx);

    log.info(
      `Bundle buy: ${buyAmount} SOL → ~${(Number(buyerTokens) / 1e6).toFixed(0)} tokens from ${buyer.publicKey.toBase58().slice(0, 8)}...`
    );
  }

  log.success(
    `Pump.fun bundle built: 1 create + ${bundleBuyers.length} buys (mint: ${mint.toBase58()})`
  );

  return { mint, transactions };
}
