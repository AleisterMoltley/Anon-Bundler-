# Anon Bundler — Solana Token Launch Bundler v2.2

All-in-one Solana Token Launch Bundler with Jito Bundle support, Pump.fun and Raydium launch, Volume Bot, Auto-Sell, and SOL Recovery — fully local, no third-party API required.

---

## Table of Contents

1. [What is the Anon Bundler?](#what-is-the-anon-bundler)
2. [What's new in v2.2?](#whats-new-in-v22)
3. [What's new in v2.1?](#whats-new-in-v21)
4. [Feature Overview](#feature-overview)
5. [Prerequisites](#prerequisites)
6. [Installation & Setup](#installation--setup)
7. [Configuration (.env)](#configuration-env)
8. [Usage](#usage)
9. [Architecture](#architecture)
10. [Technical Details](#technical-details)
    - [Wallet Generation & Vault](#wallet-generation--vault)
    - [Wallet Funding](#wallet-funding)
    - [Pump.fun Launch](#pumpfun-launch)
    - [Raydium CPMM Launch](#raydium-cpmm-launch)
    - [Jito Bundle](#jito-bundle)
    - [Volume Bot](#volume-bot)
    - [Auto-Sell Monitor](#auto-sell-monitor)
    - [Migration Monitor](#migration-monitor)
    - [SOL Recovery](#sol-recovery)
11. [Security Notes](#security-notes)
12. [Troubleshooting](#troubleshooting)
13. [Frequently Asked Questions (FAQ)](#frequently-asked-questions-faq)

---

## What's new in v2.2?

Version 2.2 replaces all hand-coded protocol logic with official SDKs, upgrades to the latest Jupiter and Jito APIs, and eliminates the Address Lookup Table step.

### Upgrades & Changes

| Area | v2.1 → v2.2 |
|------|-------------|
| Pump.fun | Hand-coded instruction → **official `@pump-fun/pump-sdk`** (always up-to-date with program upgrades incl. volume accumulators, fee config, cashback/mayhem) |
| Jupiter | Dead v6 endpoints → **Price V3 + Swap V1** (`lite-api.jup.ag`) |
| Jito tip | Fixed 950k lamports → **dynamic via `tip_floor` API** (configurable percentile + multiplier, hard cap) |
| Jito engines | Mainnet + NY → **Frankfurt + NY + Global** (lower latency for EU users) |
| TX confirmation | 1.5s polling → **blockhash-expiry based** (`confirmTransaction` with `lastValidBlockHeight`) |
| Bundle buys | Hand-coded discriminators → **official SDK `buyInstructions`** with synthesized `BondingCurve` state |
| Raydium CPMM | Outdated SDK shape → **v0.2.41 `CreateCpmmPoolParam`** (full required fields) |
| Migration | Hand-decoded discriminator → **`OnlinePumpSdk.decodeBondingCurveNullable` + `bc.complete`** |
| Token balance | `getTokenAccountsByOwner` (slow, misses multi-ATA) → **`getAssociatedTokenAddressSync`** (direct ATA) |
| LUT | Created but unused → **removed** (didn't help bundle; LUT needs 1 slot to activate) |
| Funding | Legacy TX → **V0 TX with fresh blockhash per batch** |
| Transaction versions | Mixed Legacy/V0 → **V0 throughout** |

### New Environment Variables in v2.2

| Variable | Default | Description |
|----------|---------|-------------|
| `BUNDLE_BUY_MIN_SOL` | `0.09` | Minimum SOL per bundle buyer wallet |
| `BUNDLE_BUY_MAX_SOL` | `0.48` | Maximum SOL per bundle buyer wallet |
| `JITO_TIP_PERCENTILE` | `75` | Targets this percentile from the `landed_tips` API |
| `JITO_TIP_MULTIPLIER` | `1.5` | Multiplier applied to the percentile tip value |
| `JITO_TIP_MAX_LAMPORTS` | `5_000_000` | Hard cap to prevent runaway tip bids |
| `JUPITER_API_KEY` | — | Optional; unlocks higher Jupiter rate limits |

---

## What is the Anon Bundler?

The Anon Bundler is a fully local TypeScript tool for atomically launching SPL tokens on Solana. It bundles token creation and coordinated purchases from multiple wallets into a single Jito Bundle, so that Create and Buy transactions are confirmed in the same block.

**Core principle:** All transactions are signed and constructed locally — no private keys are sent to external APIs. Metadata is uploaded to IPFS via Pinata (configurable); everything else runs fully on-chain.

The bundler supports two launch platforms:

- **Pump.fun** — Token creation plus coordinated buys via the bonding curve, all in one Jito Bundle (max. 5 transactions: 1 Create + 3 Buys + 1 Tip)
- **Raydium V2 CPMM** — Direct pool launch with full liquidity control

After launch, three optional post-launch services run:

- **Volume Bot** — simulates organic trading volume via Jupiter
- **Auto-Sell Monitor** — automatically sells at profit target or trailing stop
- **Migration Monitor** — detects Pump.fun → PumpSwap/Raydium migration

---

## What's new in v2.1?

Version 2.1 fixes several critical bugs from v2.0 and adds new features:

### Bug Fixes

| # | Area | Problem in v2.0 | Fix in v2.1 |
|---|------|-----------------|-------------|
| FIX #1 | Jito Bundle | Transactions were sent base64-encoded — Jito API rejects this | Correct base58 encoding |
| FIX #2 | Pump.fun Buy | Token amount was passed as `0`, causing revert or 0 tokens | Real bonding curve math (Constant Product Formula) |
| FIX #3 | Bundle size | Tip TX was dropped when bundle was full (max. 5 TXs) | Payload TXs are capped at 4 first; slot 5 = Tip |
| FIX #4 | Wallet Vault | Plaintext fallback wrote private keys unencrypted to disk | No plaintext fallback; vault password required for real launches |
| FIX #7 | Trailing Stop | Trailing stop only set an internal flag but did not actually sell | Shared `executeSellAll()` function that actually sells |
| FIX #8 | Migration | Bonding curve data was read without validation (buffer overflow risk) | Discriminator check + data length validation before each read |
| FIX #9 | Volume Bot | Sell amount was `solAmount * 1e9` (completely wrong) | Sells a percentage of the actual token balance |
| FIX #10 | Blockhash | Stale blockhash caused TX failures | Fresh blockhash fetched immediately before TX construction |
| FIX #11 | Jito Tip Accounts | Private RPC method used for tip account lookup | Official Jito API + static fallback addresses |
| FIX #13 | Creator Buy | Creator buy amount was hardcoded to 0.5 SOL | Configurable via `CREATOR_BUY_SOL` |
| FIX #14 | Bundle limit | `bundleWalletsCount` could be set to 4 (exceeds Jito limit) | Max. 3 bundle wallets (1 Create + 3 Buys + 1 Tip = 5) |
| FIX #17 | Rate Limiting | Jupiter API calls without rate limiting → HTTP 429 errors | `RateLimiter` class, max. 30 requests/minute |

### New Features

- **`npm run recover`** — Recovery script to retrieve SOL from funded buyer wallets after crashes
- **`RateLimiter` class** — Prevents API bans by rate-limiting Jupiter calls
- **Configurable creator buy** — `CREATOR_BUY_SOL` environment variable
- **Bonding curve validation** — Discriminator check before reading account data
- **Improved `tsconfig.json`** — `declarationMap` and `sourceMap` for better debugging

---

## Feature Overview

| Feature | Description |
|---------|-------------|
| **Pump.fun Launch** | Local TX construction (no Pump.fun API), atomic Create + Multi-Buy via Jito Bundle |
| **Raydium V2 CPMM** | Pool creation with full liquidity control |
| **Jito Bundles** | Real dual-submission to multiple block engines with tip transactions |
| **Volume Bot** | Jupiter-based buy/sell cycles with randomized amounts and timing |
| **Auto-Sell** | Jupiter price tracking, profit target sells, trailing stop-loss |
| **Migration Monitor** | On-chain bonding curve progress + automatic migration detection |
| **Wallet Vault** | AES-256-GCM encrypted wallet persistence (crash recovery) |
| **Fund Recovery** | Retrieve SOL from buyer wallets if launch failed |
| **Dry-Run Mode** | Simulate the entire flow without sending transactions |
| **Graceful Shutdown** | Ctrl+C stops all running services cleanly |
| **Vanity Addresses** | Optional generation of wallet addresses with a specific prefix |

---

## Prerequisites

- **Node.js** v18+ (recommended: v20 LTS)
- **npm** v9+
- **Solana wallet** with enough SOL in the master wallet
  - Rule of thumb: `NUM_WALLETS × SOL_PER_WALLET + 0.5 SOL` for fees and LUT
- **Pinata account** for IPFS metadata upload (free plan is sufficient)
  - Only needed for real launches; dry-run works without Pinata
- **RPC endpoint** with sufficient rate limits (recommended: QuickNode, Helius, or Triton)
  - Jito-compatible RPC endpoints are preferred for bundle submission

---

## Installation & Setup

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd Anon-Bundler-

# 2. Install dependencies
npm install

# 3. Create environment configuration
cp .env.example .env

# 4. Fill in .env with your values
nano .env   # or any editor of your choice
```

### Quick-Start Checklist

- [ ] Node.js v18+ installed
- [ ] `npm install` executed
- [ ] `.env` created and configured
- [ ] `RPC_URL` set to a working Solana RPC endpoint
- [ ] `MASTER_PRIVATE_KEY` set to your base58-encoded private key
- [ ] `WALLET_VAULT_PASSWORD` set to a secure password (for real launches)
- [ ] `PINATA_JWT` set to your Pinata JWT token (for real launches)
- [ ] Dry-run executed and output reviewed
- [ ] Master wallet funded with enough SOL

---

## Configuration (.env)

All settings are provided via environment variables in the `.env` file. Never commit `.env` to Git — use `.env.example` as a template only.

### RPC & Master Wallet

| Variable | Required | Description |
|----------|----------|-------------|
| `RPC_URL` | ✅ | HTTPS URL to your Solana RPC endpoint. Must start with `https://`. Recommended: QuickNode, Helius, Triton with a dedicated endpoint |
| `MASTER_PRIVATE_KEY` | ✅ | Base58-encoded private key of the master wallet. The master wallet funds all buyer wallets, pays the Jito tip, and launch fees |

### Launch Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `MODE` | `pump` | Launch platform: `pump` (Pump.fun), `raydium` (Raydium V2 CPMM), or `multi` (both — Pump.fun first) |

### Token Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TOKEN_NAME` | `MyToken` | Name of the token (e.g. `PepeKing`) |
| `TOKEN_SYMBOL` | `MTK` | Ticker symbol (e.g. `PEPE`) |
| `TOKEN_DESCRIPTION` | empty | Description for metadata (shown on Pump.fun and DexScreener) |
| `TOKEN_IMAGE_URL` | empty | URL to a publicly accessible image (PNG/JPG, square recommended). Uploaded to IPFS |

### Wallet & Bundle Configuration

| Variable | Default | Min | Max | Description |
|----------|---------|-----|-----|-------------|
| `NUM_WALLETS` | `20` | `1` | `300` | Number of buyer wallets. More wallets = more post-launch volume. **Cost**: `NUM_WALLETS × SOL_PER_WALLET` SOL |
| `SOL_PER_WALLET` | `0.28` | — | — | SOL allocated to each buyer wallet. Should be at least `0.1` SOL to cover gas + purchases |
| `BUNDLE_WALLETS_COUNT` | `3` | `1` | `3` | Number of buyer wallets in the Jito Bundle. **Maximum 3**, since Jito allows at most 5 transactions (1 Create + 3 Buys + 1 Tip = 5) |
| `VANITY_PREFIX` | empty | — | — | Optional prefix for generated wallet addresses (e.g. `ABC`). Leave empty for random addresses |
| `VANITY_TIMEOUT_SEC` | `30` | `5` | `300` | Timeout in seconds for vanity address search. Remaining wallets are filled with regular addresses after the timeout |

### Creator Buy & Bundle Buy Amounts

| Variable | Default | Description |
|----------|---------|-------------|
| `CREATOR_BUY_SOL` | `0.5` | SOL amount the creator (master wallet) buys at token launch. This purchase is part of the Create transaction in the bundle |
| `BUNDLE_BUY_MIN_SOL` | `0.09` | Minimum SOL amount per bundle buyer wallet. Randomized between min and max for each wallet |
| `BUNDLE_BUY_MAX_SOL` | `0.48` | Maximum SOL amount per bundle buyer wallet |

### Jito Tip

The tip is fetched dynamically from the Jito `tip_floor` API and adjusted by a percentile and multiplier. A static fallback is used if the API is unavailable.

| Variable | Default | Description |
|----------|---------|-------------|
| `JITO_TIP_LAMPORTS` | `1000000` | Static fallback tip in lamports used when the `tip_floor` API is unreachable. Default: ~0.001 SOL |
| `JITO_TIP_PERCENTILE` | `75` | Percentile of landed bundle tips to target (25 / 50 / 75 / 95 / 99). Higher = faster inclusion, higher cost |
| `JITO_TIP_MULTIPLIER` | `1.5` | Multiplier applied to the percentile value (e.g. `1.5` = 50% above the 75th percentile) |
| `JITO_TIP_MAX_LAMPORTS` | `5000000` | Hard cap on tip bid to prevent runaway costs. Default: 0.005 SOL |

### Slippage

| Variable | Default | Min | Max | Description |
|----------|---------|-----|-----|-------------|
| `SLIPPAGE_BPS` | `500` | `50` | `1000` | Slippage tolerance in basis points (1 bps = 0.01%). `500` = 5%, `1000` = 10% (maximum, protects against sandwich attacks). Applies to all Pump.fun buys, Volume Bot, and Auto-Sell |

### Post-Launch Services

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_MIGRATE` | `true` | Enable Migration Monitor. Tracks bonding curve progress and detects migration to PumpSwap/Raydium. Only useful in `pump`/`multi` mode |
| `VOLUME_BOT_ENABLED` | `true` | Enable Volume Bot. Generates organically-looking trading volume via Jupiter after launch |
| `VOLUME_BUYS_PER_MIN` | `12` | Number of transactions per minute in the Volume Bot. Internally capped at 30 to avoid API rate limits |
| `AUTO_SELL_PERCENT` | `35` | Profit target in percent. Positions are automatically sold when price rises +35% above entry |

### Metadata

| Variable | Required | Description |
|----------|----------|-------------|
| `PINATA_JWT` | For real launches | JWT token from [app.pinata.cloud](https://app.pinata.cloud). Required to upload token metadata (name, symbol, description, image) to IPFS |

### Jupiter

| Variable | Required | Description |
|----------|----------|-------------|
| `JUPITER_API_KEY` | No | Optional API key from [portal.jup.ag](https://portal.jup.ag). Unlocks higher rate limits for the Jupiter swap and price APIs |

### Security

| Variable | Required | Description |
|----------|----------|-------------|
| `WALLET_VAULT_PASSWORD` | For real launches | Password for AES-256-GCM encryption of the wallet vault on disk. **Mandatory** for real launches (**`DRY_RUN=false`**) — prevents private keys from being stored unencrypted |
| `DRY_RUN` | — | `true`: Simulates the entire flow without sending transactions (default: `true`). **Always test with `DRY_RUN=true` first!** |

---

## Usage

### 1. Dry-Run (recommended first step)

Simulates the complete launch flow without real transactions:

```bash
DRY_RUN=true npx ts-node src/index.ts
# or:
npm start
```

In dry-run mode, the full output is shown (wallet generation, funding simulation, bundle construction), but no transaction is sent.

### 2. Real Launch

After a successful dry-run and reviewing all configuration:

```bash
DRY_RUN=false npx ts-node src/index.ts
```

**Make sure beforehand:**
- Master wallet has enough SOL (`NUM_WALLETS × SOL_PER_WALLET + ~1 SOL` buffer)
- `WALLET_VAULT_PASSWORD` is set
- `PINATA_JWT` is set
- RPC endpoint is reliable

### 3. Built Version (optional, faster than ts-node)

```bash
npm run build           # Compiles TypeScript to dist/
npm run start:built     # Runs the compiled version
```

### 4. SOL Recovery after Crash

If the process crashes after wallet funding but before launch:

```bash
npm run recover
```

The recovery script loads the encrypted wallet vault, checks all balances, and transfers SOL back to the master wallet. Token holdings must be sold first, either manually or via the Volume Bot.

### Flow Overview

```
Step 1: Generate wallets (or load from vault)
     ↓
Step 2: Fund buyer wallets (Master → each Buyer, V0 TX)
     ↓
Step 3: Launch token (Pump.fun or Raydium)
     ↓
Step 4: Submit Jito Bundle + wait for confirmation
     ↓
Post-Launch: Volume Bot + Auto-Sell + Migration Monitor
     ↓
Ctrl+C: Graceful shutdown of all services
```

---

## Architecture

```
Anon-Bundler-/
├── .env.example              # Template for all environment variables
├── .gitignore                # Excludes .env, wallets/, dist/
├── package.json              # Dependencies + npm scripts
├── tsconfig.json             # TypeScript configuration
└── src/
    ├── config.ts             # Central configuration object (parsed from .env)
    ├── utils.ts              # Helper functions: Jupiter endpoints, Jito tip_floor, confirmTx, RateLimiter
    ├── wallets.ts            # Wallet generation + AES-256-GCM vault encryption
    ├── funding.ts            # V0 batch transfers master → buyers with fresh blockhash per batch
    ├── metadata.ts           # Pinata IPFS upload for token metadata
    ├── jito.ts               # Dynamic tip, multi-engine bundle send (Frankfurt + NY + Global) + status polling
    ├── index.ts              # State-machine orchestrator (main flow) + graceful shutdown
    ├── recover.ts            # Recovery script: retrieve SOL from buyer wallets
    ├── launches/
    │   ├── pumpfun.ts        # @pump-fun/pump-sdk — createAndBuy + buyInstructions
    │   └── raydium.ts        # @raydium-io/raydium-sdk-v2 — CPMM pool creation
    └── postlaunch/
        ├── migration.ts      # OnlinePumpSdk bonding curve progress + DexScreener migration check
        ├── volumeBot.ts      # Jupiter swap V1 randomized buy/sell cycles (rate-limited)
        └── autoSell.ts       # Jupiter price V3 tracking + profit target + trailing stop sells
```

---

## Technical Details

### Wallet Generation & Vault

**File:** `src/wallets.ts`

Buyer wallets are generated with `Keypair.generate()`. If a `VANITY_PREFIX` is set, wallets are generated until an address with the desired prefix is found (case-insensitive). After `VANITY_TIMEOUT_SEC` seconds, remaining wallets are filled without vanity.

**Vault encryption:**
- Algorithm: AES-256-GCM with PBKDF2-derived key (100,000 iterations, SHA-256)
- Storage format: `salt (16 bytes) | iv (12 bytes) | authTag (16 bytes) | ciphertext`
- Storage location: `wallets/vault.enc`
- Without `WALLET_VAULT_PASSWORD`, wallets are not saved (tolerated only in dry-run mode)

On startup, the bundler automatically checks whether a vault exists and reloads the wallets. This allows interrupted launches to be resumed without generating new wallets.

### Wallet Funding

**File:** `src/funding.ts`

The master wallet transfers `SOL_PER_WALLET` SOL to each buyer wallet via batch transactions. Before each transfer, it checks whether the wallet already has sufficient balance (idempotent). Transactions are confirmed with `confirmTx()` before proceeding.

### Pump.fun Launch

**File:** `src/launches/pumpfun.ts`

The launch uses the official `@pump-fun/pump-sdk` — no hand-coded instruction discriminators or bonding curve math:

**Token creation (TX 1: Create + Creator Buy):**
- `OnlinePumpSdk.createAndBuy()` — builds the Create + initial buy instruction using the official SDK, always compatible with the current on-chain program (including volume accumulators, fee config, cashback/mayhem)
- Creator buys directly in the same transaction

**Buys (TX 2–4: Buyer wallets):**
- `OnlinePumpSdk.buyInstructions()` with synthesized `BondingCurve` state — randomized amount between `BUNDLE_BUY_MIN_SOL` and `BUNDLE_BUY_MAX_SOL`
- Slippage applied via `SLIPPAGE_BPS`

**Jito Bundle limit:**
- Max. 5 transactions per bundle: 1 Create + max. 3 Buys + 1 Tip
- `BUNDLE_WALLETS_COUNT` is therefore capped at 3

### Raydium CPMM Launch

**File:** `src/launches/raydium.ts`

Creates a Raydium V2 CPMM (Constant Product Market Maker) pool via `@raydium-io/raydium-sdk-v2` v0.2.41 using the full `CreateCpmmPoolParam` shape. The pool contains the newly created token and SOL (as WSOL). Initial liquidity comes from the master wallet.

### Jito Bundle

**File:** `src/jito.ts`

**Flow:**
1. Tip amount is fetched dynamically from the Jito `tip_floor` API — percentile × multiplier, capped by `JITO_TIP_MAX_LAMPORTS`. Falls back to `JITO_TIP_LAMPORTS` if the API is unavailable
2. Payload transactions are capped at 4 (reserves slot 5 for the tip)
3. Tip transaction is built: SOL transfer from master to a random Jito tip account
4. Bundle is submitted to **three** block engines for maximum coverage:
   - `https://mainnet.block-engine.jito.wtf/api/v1/bundles`
   - `https://ny.block-engine.jito.wtf/api/v1/bundles`
   - `https://frankfurt.block-engine.jito.wtf/api/v1/bundles`
5. Transactions are transmitted **base58-encoded** (Jito API requirement — base64 is rejected)
6. TX confirmation via blockhash-expiry based `confirmTransaction` with `lastValidBlockHeight`

### Volume Bot

**File:** `src/postlaunch/volumeBot.ts`

Generates organically-looking trading volume via Jupiter Swap V1 (`lite-api.jup.ag`):
- **Ratio:** 70% buys, 30% sells
- **Buys:** Random amount between 0.005 and 0.09 SOL via Jupiter Quote + Swap V1 API
- **Sells:** 5–15% of actual token balance via `getAssociatedTokenAddressSync` (direct ATA lookup)
- **Timing:** `60,000 / VOLUME_BUYS_PER_MIN` ms interval + random jitter (0–30%)
- **Rate limiting:** All Jupiter calls go through `jupiterLimiter` (max. 30 requests/60s)
- Rotates through all available buyer wallets in order

### Auto-Sell Monitor

**File:** `src/postlaunch/autoSell.ts`

Tracks the token price via Jupiter Price V3 API and sells automatically:

**Profit Target:**
- All positions are sold when price is `+AUTO_SELL_PERCENT%` above the initial price
- Master wallet: 50% of holdings
- Buyer wallets: 100% of holdings (up to `BUNDLE_WALLETS_COUNT`)

**Trailing Stop:**
- Triggers when price has dropped >20% from all-time high AND is still >10% in profit
- Protects accumulated gains without selling too early

**Sell mechanism:**
- Jupiter Quote V1 → Jupiter Swap V1 → `sendRawTransaction`
- Prioritization fee: 100,000 lamports for fast execution
- Sells are staggered (2s pause) to minimize slippage

### Migration Monitor

**File:** `src/postlaunch/migration.ts`

Monitors the Pump.fun bonding curve progress on-chain:
- Reads bonding curve state via `OnlinePumpSdk.decodeBondingCurveNullable` — no hand-decoded discriminators
- Migration detected via `bc.complete` flag on the bonding curve account
- Progress: `virtualSolReserves / 85 SOL × 100%` (Pump.fun migrates at ~85 SOL)
- DexScreener API check as secondary confirmation: checks whether a pool with liquidity exists
- Polling interval: 7s (below 100%), 30s (after completion)

### SOL Recovery

**File:** `src/recover.ts`

```bash
npm run recover
```

Iterates through all wallets in the vault and transfers SOL back to master:
- Leaves 5,000 lamports for transaction fees
- Skips wallets with less than 890,880 lamports (rent-exempt minimum)
- 500ms pause between wallets (RPC-friendly)
- Dry-run shows estimated amount to be recovered without sending transactions
- **Note:** Only SOL is recovered — token holdings must be sold first

---

## Security Notes

### Critical

- **Never commit `.env`** — it contains your private key and vault password
- **Always set `WALLET_VAULT_PASSWORD`** for real launches — without a password there is no encryption, private keys remain unsecured
- **Back up the master wallet key** — whoever holds the key controls all funds
- **Always start with `DRY_RUN=true`** — review the flow before using real funds

### Recommended

- Use a dedicated master wallet for the bundler (not a wallet holding other funds)
- Choose an RPC endpoint with rate-limit protection
- Do not use more SOL than you are willing to lose
- Cap slippage at max. 10% (1000 bps) — this is the built-in protection against sandwich attacks
- TX confirmations are awaited before the next step is executed
- Graceful shutdown via Ctrl+C — stops all running services cleanly

### What the Bundler does NOT do

- No private keys are sent to external servers
- No transactions are sent without confirmation
- No transactions are sent when `DRY_RUN=true`

---

## Troubleshooting

### "Missing required env var: RPC_URL"
→ `.env` file is missing or `RPC_URL` is not set. Run `cp .env.example .env` and fill it in.

### "MASTER_PRIVATE_KEY looks invalid (too short)"
→ The private key must be at least 40 characters long. Export the base58-encoded key from Phantom/Solflare.

### "WALLET_VAULT_PASSWORD is required for non-dry-run launches"
→ Set `WALLET_VAULT_PASSWORD` in `.env`. Not required for dry-runs.

### "All Jito block engines rejected bundle"
→ Possible causes: bundle too large (>5 TXs), transaction failed, blockhash stale. Reduce `BUNDLE_WALLETS_COUNT` to 3; check RPC connection.

### Volume Bot: "Volume buy failed: 429 Too Many Requests"
→ Reduce `VOLUME_BUYS_PER_MIN` (e.g. to 6). The built-in `RateLimiter` class caps at 30 calls/minute, but some RPC endpoints have stricter limits. Alternatively, set `JUPITER_API_KEY` to unlock higher rate limits.

### Recovery: "No wallets found in vault. Nothing to recover."
→ Vault file (`wallets/vault.enc`) is missing or `WALLET_VAULT_PASSWORD` does not match. Check the password.

### Build error: "Cannot find module '@pump-fun/pump-sdk'"
→ Run `npm install` again. The `@pump-fun/pump-sdk` package was added in v2.2.

### Build error: "Cannot find module '@raydium-io/raydium-sdk-v2'"
→ Run `npm install` again.

---

## Frequently Asked Questions (FAQ)

**How much SOL do I need for a launch?**
Formula: `(NUM_WALLETS × SOL_PER_WALLET) + CREATOR_BUY_SOL + dynamic_jito_tip + ~0.3 SOL buffer`
Example with defaults: `(20 × 0.28) + 0.5 + ~0.001 + 0.3 ≈ 6.4 SOL`

**Can I run the tool multiple times?**
Yes. If a vault exists, the same wallets are reused (idempotent). If the wallets are already funded, this is detected and skipped.

**What happens if the process crashes during funding?**
The wallets are saved in the vault. They are loaded on the next start. Run `npm run recover` after the launch to retrieve SOL.

**How well does the Volume Bot avoid detection?**
The bot uses random amounts (0.005–0.09 SOL buys), random timing (±30% jitter), and alternates between buys (70%) and sells (30%) — appears more organic than pure buys.

**Can I add new wallets after launch?**
No — the wallet list is generated on first start and secured in the vault. To use new wallets, create a new vault with a different password.

**What does `BUNDLE_WALLETS_COUNT=3` (max) mean?**
Jito allows a maximum of 5 transactions per bundle. The bundler uses: 1 Create TX + up to 3 Buy TXs + 1 Tip TX = 5. More than 3 bundle wallets would exceed the limit and the bundle would be rejected.

**Does the tool work on devnet?**
Not out-of-the-box — Pump.fun and Jito only exist on mainnet. For testing, always use dry-run mode (`DRY_RUN=true`).

**How do I know when migration was successful?**
The Migration Monitor logs `"Token has been migrated to PumpSwap/Raydium!"` as soon as a Raydium pool with liquidity is detected on DexScreener.

---

## License

This project is provided without warranties. Use at your own risk. Do not use for illegal activities.
