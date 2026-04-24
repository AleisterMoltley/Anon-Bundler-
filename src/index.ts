import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import chalk from "chalk";
import { CONFIG, validateConfig } from "./config";
import { generateWallets } from "./wallets";
import { fundWallets } from "./funding";
import { launchOnPumpFun } from "./launches/pumpfun";
import { launchOnRaydium } from "./launches/raydium";
import { sendJitoBundle, waitForBundleConfirmation } from "./jito";
import { startAutoMigration } from "./postlaunch/migration";
import { startVolumeBot } from "./postlaunch/volumeBot";
import { startAutoSellMonitor } from "./postlaunch/autoSell";
import { log, sleep } from "./utils";

type Step = "init" | "wallets" | "funding" | "launch" | "bundle" | "postlaunch" | "running";

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

function setupShutdown() {
  const shutdown = () => {
    console.log("\n");
    log.warn("Shutting down gracefully...");
    for (const handle of state.stopHandles) {
      try { handle.stop(); } catch {}
    }
    log.info("All services stopped. Exiting.");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  console.log(chalk.bold.magenta("\n🔥 SOLANA MAX BUNDLER v2.2\n"));

  validateConfig();
  setupShutdown();

  const connection = new Connection(CONFIG.rpcUrl, "confirmed");
  const master = Keypair.fromSecretKey(bs58.decode(CONFIG.masterPrivateKey));

  log.info(`Mode: ${CONFIG.mode}`);
  log.info(`Master: ${master.publicKey.toBase58()}`);
  log.info(`Wallets: ${CONFIG.numWallets} × ${CONFIG.solPerWallet} SOL`);
  log.info(`Bundle buyers: ${CONFIG.bundleWalletsCount} (Jito: 1 create + ${CONFIG.bundleWalletsCount} buys + 1 tip)`);
  log.info(`Creator buy: ${CONFIG.creatorBuySol} SOL`);
  log.info(`Slippage: ${CONFIG.slippageBps} bps (${CONFIG.slippageBps / 100}%)`);
  if (CONFIG.dryRun) log.warn("DRY_RUN mode active");

  // Step: Generate wallets
  state.step = "wallets";
  log.step("Step 1/4: Generating wallets...");
  state.buyerWallets = await generateWallets(CONFIG.numWallets);

  // Step: Fund wallets
  state.step = "funding";
  log.step("Step 2/4: Funding wallets...");
  await fundWallets(connection, master, state.buyerWallets);

  // Step: Launch
  state.step = "launch";
  log.step("Step 3/4: Launching token...");

  const usePump = CONFIG.mode === "pump" || CONFIG.mode === "multi";
  const useRaydium = CONFIG.mode === "raydium";

  if (usePump) {
    const { mint, transactions, blockhashInfo } = await launchOnPumpFun(
      connection,
      master,
      state.buyerWallets
    );
    state.mint = mint;
    console.log(chalk.green.bold(`\n🎉 Token: ${mint.toBase58()}\n`));

    // Step: Send Jito bundle
    state.step = "bundle";
    if (transactions.length > 0) {
      log.step("Step 4/4: Sending Jito bundle...");
      state.bundleId = await sendJitoBundle(transactions, master, blockhashInfo);

      if (state.bundleId && state.bundleId !== "dry-run-bundle-id") {
        const confirmed = await waitForBundleConfirmation(state.bundleId);
        if (!confirmed) {
          log.error("Bundle not confirmed — token may not have launched correctly");
          log.info("Run `npm run recover` to reclaim SOL from buyer wallets if needed");
        }
      }
    }
  } else if (useRaydium) {
    const { mint } = await launchOnRaydium(master, connection, state.buyerWallets);
    state.mint = mint;
    console.log(chalk.green.bold(`\n🎉 Token: ${mint.toBase58()}\n`));
  }

  if (!state.mint) {
    throw new Error("Launch failed: no mint produced");
  }

  // Post-launch services
  state.step = "postlaunch";
  log.step("Starting post-launch services...");

  if (CONFIG.autoMigrate && usePump) {
    state.stopHandles.push(startAutoMigration(connection, state.mint));
  }
  if (CONFIG.volumeEnabled) {
    state.stopHandles.push(startVolumeBot(connection, state.mint, state.buyerWallets));
  }
  state.stopHandles.push(
    startAutoSellMonitor(connection, state.mint, master, state.buyerWallets)
  );

  state.step = "running";
  console.log(chalk.bold.green("\n✅ ALL SYSTEMS RUNNING"));
  console.log(chalk.gray("Press Ctrl+C to stop gracefully\n"));

  while (true) await sleep(60_000);
}

main().catch((err) => {
  log.error(`Fatal error at step [${state.step}]: ${err.message}`);
  if (state.step === "funding") {
    log.warn("Wallets may have been funded. Run `npm run recover` to reclaim SOL.");
  }
  console.error(err);
  process.exit(1);
});
