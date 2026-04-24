import {
  Keypair,
  PublicKey,
  Connection,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  AccountInfo,
  BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import {
  PumpSdk,
  OnlinePumpSdk,
  pumpIdl,
  newBondingCurve,
  getBuyTokenAmountFromSolAmount,
  type Global,
  type FeeConfig,
  type BondingCurve,
  PUMP_PROGRAM_ID,
} from "@pump-fun/pump-sdk";
import { BorshCoder, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CONFIG } from "../config";
import { uploadMetadata } from "../metadata";
import { randomAmount, log } from "../utils";

/**
 * Constant-product simulation of a Pump.fun bonding curve buy.
 * Mirrors the on-chain math so bundle buys can predict the min-tokens slippage
 * bound while all buys are queued atomically in the same Jito bundle.
 */
function simulateBuy(
  vsr: BN,
  vtr: BN,
  solInLamports: BN
): { tokensOut: BN; newVsr: BN; newVtr: BN } {
  // tokens_out = (vtr * sol_in) / (vsr + sol_in)
  const tokensOut = vtr.mul(solInLamports).div(vsr.add(solInLamports));
  const newVsr = vsr.add(solInLamports);
  const newVtr = vtr.sub(tokensOut);
  return { tokensOut, newVsr, newVtr };
}

/**
 * Encode a BondingCurve state into an AccountInfo<Buffer> that the SDK's
 * buyInstructions() can consume. Used for bundle buys where the real on-chain
 * account doesn't exist yet but will by the time the bundle lands.
 *
 * The SDK uses `bondingCurve` (decoded) for math and `bondingCurveAccountInfo`
 * only for the initialization branch check (data length / discriminator).
 */
function encodeBondingCurveAccountInfo(
  bc: BondingCurve,
  coder: BorshCoder
): Promise<AccountInfo<Buffer>> {
  return coder.accounts
    .encode("BondingCurve", {
      virtual_token_reserves: bc.virtualTokenReserves,
      virtual_sol_reserves: bc.virtualSolReserves,
      real_token_reserves: bc.realTokenReserves,
      real_sol_reserves: bc.realSolReserves,
      token_total_supply: bc.tokenTotalSupply,
      complete: bc.complete,
      creator: bc.creator,
      is_mayhem_mode: bc.isMayhemMode,
      is_cashback_coin: bc.isCashbackCoin,
    })
    .then((data) => ({
      data,
      owner: PUMP_PROGRAM_ID,
      executable: false,
      lamports: 0,
      rentEpoch: 0,
    }));
}

/**
 * Launch on Pump.fun using the official @pump-fun/pump-sdk.
 *
 * TX 1: Create mint + Creator buy (via createAndBuyInstructions)
 * TX 2..N: Bundle buyers purchasing from progressively updated curve state
 *
 * Returns unsigned VersionedTransactions ready for Jito bundling.
 */
export async function launchOnPumpFun(
  connection: Connection,
  creator: Keypair,
  buyerWallets: Keypair[]
): Promise<{
  mint: PublicKey;
  transactions: VersionedTransaction[];
  blockhashInfo: BlockhashWithExpiryBlockHeight;
}> {
  log.step("Building Pump.fun launch bundle via official SDK...");

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  // Upload metadata (Pinata)
  const metadataUri = await uploadMetadata(
    CONFIG.tokenName,
    CONFIG.tokenSymbol,
    CONFIG.tokenDescription,
    CONFIG.tokenImageUrl
  );

  const pumpSdk = new PumpSdk();
  const onlineSdk = new OnlinePumpSdk(connection);
  const coder = new BorshCoder(pumpIdl as any);

  // Fetch live protocol state — creator buy must match current fee schedule & caps
  const [global, feeConfig]: [Global, FeeConfig] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig(),
  ]);

  // Single fresh blockhash for all bundle TXs — Jito executes them in one slot
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");

  // Slippage as decimal (0.05 = 5%), matching SDK convention
  const slippage = CONFIG.slippageBps / 10_000;

  const transactions: VersionedTransaction[] = [];

  // === TX 1: Create + Creator buy ===

  const creatorSolLamports = new BN(Math.floor(CONFIG.creatorBuySol * 1e9));

  // Expected token amount the creator will receive — SDK needs this as `amount`
  const creatorTokenAmount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null, // null = pre-creation (fresh curve)
    bondingCurve: null, // null = use newBondingCurve(global) internally
    amount: creatorSolLamports,
  });

  const createIxs = await pumpSdk.createAndBuyInstructions({
    global,
    mint,
    name: CONFIG.tokenName,
    symbol: CONFIG.tokenSymbol,
    uri: metadataUri,
    creator: creator.publicKey,
    user: creator.publicKey,
    amount: creatorTokenAmount,
    solAmount: creatorSolLamports,
  });

  const createMsg = new TransactionMessage({
    payerKey: creator.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ...createIxs,
    ],
  }).compileToV0Message();

  const createTx = new VersionedTransaction(createMsg);
  createTx.sign([creator, mintKeypair]);
  transactions.push(createTx);

  log.info(
    `Creator buy: ${CONFIG.creatorBuySol} SOL → ~${creatorTokenAmount.toString()} raw tokens`
  );

  // === Simulate curve progression for bundle buyers ===

  // Start from fresh curve + apply creator buy
  const liveBc = newBondingCurve(global);
  liveBc.creator = creator.publicKey;

  {
    const sim = simulateBuy(
      liveBc.virtualSolReserves,
      liveBc.virtualTokenReserves,
      creatorSolLamports
    );
    liveBc.virtualSolReserves = sim.newVsr;
    liveBc.virtualTokenReserves = sim.newVtr;
    liveBc.realSolReserves = liveBc.realSolReserves.add(creatorSolLamports);
    liveBc.realTokenReserves = liveBc.realTokenReserves.sub(sim.tokensOut);
  }

  // === TX 2..N: Bundle buyers ===
  // Max 3 buyers to stay under Jito bundle limit: 1 create + 3 buys + 1 tip = 5

  const bundleBuyers = buyerWallets.slice(0, Math.min(CONFIG.bundleWalletsCount, 3));

  for (const buyer of bundleBuyers) {
    const buyAmount = randomAmount(CONFIG.bundleBuyMinSol, CONFIG.bundleBuyMaxSol);
    const buyLamports = new BN(Math.floor(buyAmount * 1e9));

    // Min tokens acceptable (slippage bound is applied inside the SDK — we pass
    // the expected amount computed from current simulated curve state).
    const expectedTokens = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: liveBc.tokenTotalSupply,
      bondingCurve: { ...liveBc },
      amount: buyLamports,
    });

    // Build synthetic AccountInfo so buyInstructions treats the curve as already existing
    const bondingCurveAccountInfo = await encodeBondingCurveAccountInfo(liveBc, coder);

    const buyIxs = await pumpSdk.buyInstructions({
      global,
      bondingCurveAccountInfo,
      bondingCurve: { ...liveBc },
      associatedUserAccountInfo: null, // SDK creates ATA idempotently
      mint,
      user: buyer.publicKey,
      amount: expectedTokens,
      solAmount: buyLamports,
      slippage,
      tokenProgram: TOKEN_PROGRAM_ID,
    });

    const buyMsg = new TransactionMessage({
      payerKey: buyer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
        ...buyIxs,
      ],
    }).compileToV0Message();

    const buyTx = new VersionedTransaction(buyMsg);
    buyTx.sign([buyer]);
    transactions.push(buyTx);

    log.info(
      `Bundle buy: ${buyAmount} SOL → ~${expectedTokens.toString()} raw tokens from ${buyer.publicKey.toBase58().slice(0, 8)}`
    );

    // Advance simulated curve for next buyer
    const sim = simulateBuy(
      liveBc.virtualSolReserves,
      liveBc.virtualTokenReserves,
      buyLamports
    );
    liveBc.virtualSolReserves = sim.newVsr;
    liveBc.virtualTokenReserves = sim.newVtr;
    liveBc.realSolReserves = liveBc.realSolReserves.add(buyLamports);
    liveBc.realTokenReserves = liveBc.realTokenReserves.sub(sim.tokensOut);
  }

  log.success(
    `Pump.fun bundle built: 1 create + ${bundleBuyers.length} buys (mint: ${mint.toBase58()})`
  );

  return { mint, transactions, blockhashInfo: latestBlockhash };
}

