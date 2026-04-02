import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import chalk from "chalk";
import { CONFIG, validateConfig } from "./config";
import { generateWallets } from "./wallets";
import { fundWallets } from "./funding";
import { createLUT } from "./lut";
import { launchOnPumpFun } from "./launches/pumpfun";
import { launchOnRaydium } from "./launches/raydium";
import { sendJitoBundle, waitForBundleConfirmation } from "./jito";
import { startAutoMigration } from "./postlaunch/migration";
import { startVolumeBot } from "./postlaunch/volumeBot";
import { startAutoSellMonitor } from "./postlaunch/autoSell";
import { log, sleep } from "./utils";

// === State Machine ===

type Step = "init" | "wallets" | "funding" | "lut" | "launch" | "bundle" | "postlaunch" | "running";

interface State {
  step: Step;
  buyerWallets: Keypair[];
  mint: PublicKey | null;
  bundleId: string | null;
  stopHandles: Array<{ stop: () => void }>;
}

const state: State = {
  step: "init",
  buyerWallets: [],
  mint: null,
  bundleId: null,
  stopHandles: [],
};

// === Graceful Shutdown ===

function setupShutdown() {
  const shutdown = () => {
    console.log("\n");
    log.warn("Shutting down gracefully...");
    for (const handle of state.stopHandles) {
      try {
        handle.stop();
      } catch {}
    }
    log.info("All services stopped. Exiting.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// === Main Flow ===

async function main() {
  console.log(chalk.bold.magenta("\n🔥 SOLANA MAX BUNDLER v2.1\n"));

  // Step: Init
  validateConfig();
  setupShutdown();

  const connection = new Connection(CONFIG.rpcUrl, "confirmed");
  const master = Keypair.fromSecretKey(bs58.decode(CONFIG.masterPrivateKey));

  log.info(`Mode: ${CONFIG.mode}`);
  log.info(`Master: ${master.publicKey.toBase58()}`);
  log.info(`Wallets: ${CONFIG.numWallets} × ${CONFIG.solPerWallet} SOL`);
  log.info(`Bundle buyers: ${CONFIG.bundleWalletsCount} (Jito limit: 3 + 1 create + 1 tip = 5)`);
  log.info(`Creator buy: ${CONFIG.creatorBuySol} SOL`);
  log.info(`Slippage: ${CONFIG.slippageBps} bps (${CONFIG.slippageBps / 100}%)`);
  if (CONFIG.dryRun) log.warn("DRY_RUN mode active");

  // Step: Generate Wallets
  state.step = "wallets";
  log.step("Step 1/5: Generating wallets...");
  state.buyerWallets = await generateWallets(CONFIG.numWallets);

  // Step: Fund Wallets
  state.step = "funding";
  log.step("Step 2/5: Funding wallets...");
  await fundWallets(connection, master, state.buyerWallets);

  // Step: Create LUT (for post-launch use)
  state.step = "lut";
  log.step("Step 3/5: Creating Address Lookup Table...");
  await createLUT(connection, master, [
    master.publicKey,
    ...state.buyerWallets.map((w) => w.publicKey),
  ]);

  // Step: Launch
  state.step = "launch";
  log.step("Step 4/5: Launching token...");

  let launchResult: { mint: PublicKey; transactions: any[] };

  if (CONFIG.mode.includes("pump") || CONFIG.mode === "multi") {
    launchResult = await launchOnPumpFun(connection, master, state.buyerWallets);
  } else {
    launchResult = await launchOnRaydium(master, connection, state.buyerWallets);
  }

  state.mint = launchResult.mint;
  console.log(chalk.green.bold(`\n🎉 Token: ${state.mint.toBase58()}\n`));

  // Step: Send Jito Bundle
  state.step = "bundle";
  if (launchResult.transactions.length > 0) {
    log.step("Step 5/5: Sending Jito bundle...");
    state.bundleId = await sendJitoBundle(
      connection,
      launchResult.transactions,
      CONFIG.jitoTipLamports,
      master
    );

    if (state.bundleId && state.bundleId !== "dry-run-bundle-id") {
      const confirmed = await waitForBundleConfirmation(state.bundleId);
      if (!confirmed) {
        log.error("Bundle was not confirmed — token may not have launched correctly");
        log.info("Check transaction status manually and decide whether to continue");
        log.info("Run `npm run recover` to reclaim SOL from buyer wallets if needed");
      }
    }
  } else {
    log.info("No bundle transactions to send (Raydium mode or dry run)");
  }

  // Step: Post-Launch Services
  state.step = "postlaunch";
  log.step("Starting post-launch services...");

  if (CONFIG.autoMigrate && (CONFIG.mode.includes("pump") || CONFIG.mode === "multi")) {
    const migrationHandle = startAutoMigration(connection, state.mint);
    state.stopHandles.push(migrationHandle);
  }

  if (CONFIG.volumeEnabled) {
    const volumeHandle = startVolumeBot(connection, state.mint, state.buyerWallets);
    state.stopHandles.push(volumeHandle);
  }

  const autoSellHandle = startAutoSellMonitor(
    connection,
    state.mint,
    master,
    state.buyerWallets
  );
  state.stopHandles.push(autoSellHandle);

  // Running
  state.step = "running";
  console.log(chalk.bold.green("\n✅ ALL SYSTEMS RUNNING"));
  console.log(chalk.gray("Press Ctrl+C to stop gracefully\n"));

  while (true) {
    await sleep(60_000);
  }
}

main().catch((err) => {
  log.error(`Fatal error at step [${state.step}]: ${err.message}`);
  if (state.step === "funding" || state.step === "lut") {
    log.warn("Wallets may have been funded. Run `npm run recover` to reclaim SOL.");
  }
  console.error(err);
  process.exit(1);
});
