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
// These are the onchain program addresses for Pump.fun
const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_FUN_TOKEN_MINT_AUTHORITY = new PublicKey("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM");
const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const PUMP_FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ2ESTxMwHri");
const PUMP_EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const SYSTEM_PROGRAM = SystemProgram.programId;
const RENT_PROGRAM = new PublicKey("SysvarRent111111111111111111111111111111111");

/**
 * Build the Pump.fun create token instruction
 * This constructs the instruction locally instead of using a 3rd party API
 */
function buildPumpCreateInstruction(
  creator: PublicKey,
  mint: PublicKey,
  name: string,
  symbol: string,
  metadataUri: string
): TransactionInstruction {
  // Derive PDAs
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  );
  const bondingCurveAta = getAssociatedTokenAddressSync(mint, bondingCurve, true);

  const [metadataPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s").toBuffer(),
      mint.toBuffer(),
    ],
    new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
  );

  // Encode instruction data: discriminator + name + symbol + uri
  const nameBuffer = Buffer.from(name, "utf8");
  const symbolBuffer = Buffer.from(symbol, "utf8");
  const uriBuffer = Buffer.from(metadataUri, "utf8");

  // Pump.fun create instruction discriminator
  const discriminator = Buffer.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]);

  const data = Buffer.concat([
    discriminator,
    // Borsh string: u32 len + bytes
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
      { pubkey: new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"), isSigner: false, isWritable: false },
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
 */
function buildPumpBuyInstruction(
  buyer: PublicKey,
  mint: PublicKey,
  solAmount: number,
  slippageBps: number
): TransactionInstruction {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_FUN_PROGRAM
  );
  const bondingCurveAta = getAssociatedTokenAddressSync(mint, bondingCurve, true);
  const buyerAta = getAssociatedTokenAddressSync(mint, buyer);

  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const maxSolCost = Math.floor(lamports * (1 + slippageBps / 10000));

  // Buy discriminator
  const discriminator = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
  const data = Buffer.alloc(8 + 8 + 8);
  discriminator.copy(data);
  data.writeBigUInt64LE(BigInt(0), 8); // token amount (0 = buy with SOL amount)
  data.writeBigUInt64LE(BigInt(maxSolCost), 16);

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
 */
export async function launchOnPumpFun(
  connection: Connection,
  creator: Keypair,
  buyerWallets: Keypair[]
): Promise<{ mint: PublicKey; transactions: VersionedTransaction[] }> {
  log.step("Building Pump.fun launch bundle locally...");

  // Generate mint keypair
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  // Upload metadata
  const metadataUri = await uploadMetadata(
    CONFIG.tokenName,
    CONFIG.tokenSymbol,
    CONFIG.tokenDescription,
    CONFIG.tokenImageUrl
  );

  const blockhash = await connection.getLatestBlockhash("confirmed");
  const transactions: VersionedTransaction[] = [];

  // TX 1: Create token
  const createIx = buildPumpCreateInstruction(
    creator.publicKey,
    mint,
    CONFIG.tokenName,
    CONFIG.tokenSymbol,
    metadataUri
  );

  // Creator's initial buy
  const creatorBuyIx = buildPumpBuyInstruction(
    creator.publicKey,
    mint,
    0.5,
    CONFIG.slippageBps
  );

  const createMsg = new TransactionMessage({
    payerKey: creator.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: [createIx, creatorBuyIx],
  }).compileToV0Message();

  const createTx = new VersionedTransaction(createMsg);
  createTx.sign([creator, mintKeypair]);
  transactions.push(createTx);

  // TX 2-N: Bundle buyer transactions (max 3 more to stay within Jito 5-tx limit incl. tip)
  const bundleBuyers = buyerWallets.slice(0, Math.min(CONFIG.bundleWalletsCount, 3));

  for (const buyer of bundleBuyers) {
    const buyAmount = randomAmount(0.09, 0.48);

    const buyerAtaIx = createAssociatedTokenAccountInstruction(
      buyer.publicKey,
      getAssociatedTokenAddressSync(mint, buyer.publicKey),
      buyer.publicKey,
      mint
    );

    const buyIx = buildPumpBuyInstruction(
      buyer.publicKey,
      mint,
      buyAmount,
      CONFIG.slippageBps
    );

    const buyMsg = new TransactionMessage({
      payerKey: buyer.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: [buyerAtaIx, buyIx],
    }).compileToV0Message();

    const buyTx = new VersionedTransaction(buyMsg);
    buyTx.sign([buyer]);
    transactions.push(buyTx);

    log.info(`Bundle buy: ${buyAmount} SOL from ${buyer.publicKey.toBase58().slice(0, 8)}...`);
  }

  log.success(`Pump.fun bundle built: 1 create + ${bundleBuyers.length} buys (mint: ${mint.toBase58()})`);

  return { mint, transactions };
}
