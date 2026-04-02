# SOLANA MAX BUNDLER v2

All-in-one Solana Token Launch Bundler with Jito Bundles, Pump.fun & Raydium support.

## Features

- **Pump.fun Launch** — local TX construction (no 3rd-party API), atomic create + multi-buy via Jito Bundle
- **Raydium V2 CPMM** — pool creation with full liquidity control
- **Jito Bundles** — real dual-submission to multiple block engines with tip transactions
- **Volume Bot** — Jupiter-based buy/sell cycles with randomized amounts and timing
- **Auto-Sell** — Jupiter price tracking, profit target sells, trailing stop-loss
- **Auto-Migration Monitor** — onchain bonding curve progress tracking, migration detection
- **Wallet Vault** — AES-256-GCM encrypted wallet persistence (crash recovery)
- **Dry-Run Mode** — simulate the entire flow without sending transactions

## Setup

```bash
git clone https://github.com/youruser/solana-max-bundler.git
cd solana-max-bundler
npm install
cp .env.example .env
# Edit .env with your config
```

## Configuration

See `.env.example` for all options. Key settings:

| Variable | Default | Description |
|---|---|---|
| `MODE` | `pump` | `pump`, `raydium`, or `multi` |
| `NUM_WALLETS` | `20` | Number of buyer wallets (1-300) |
| `SOL_PER_WALLET` | `0.28` | SOL funded to each wallet |
| `SLIPPAGE_BPS` | `500` | Slippage tolerance (50-1000 bps) |
| `DRY_RUN` | `true` | Simulate without sending TXs |
| `WALLET_VAULT_PASSWORD` | — | Encrypt wallet vault (recommended) |
| `PINATA_JWT` | — | Required for IPFS metadata upload |

## Usage

```bash
# Dry run first (always)
DRY_RUN=true npx ts-node src/index.ts

# Real launch
DRY_RUN=false npx ts-node src/index.ts
```

## Architecture

```
src/
├── config.ts            # Validated config with sane defaults
├── utils.ts             # Retry, backoff, TX confirmation, logging
├── wallets.ts           # Generation + encrypted vault persistence
├── funding.ts           # Balance-checked batch funding
├── lut.ts               # Address Lookup Table with confirmation
├── metadata.ts          # Real Pinata IPFS upload
├── jito.ts              # Bundle sending + dual submission + polling
├── index.ts             # State machine orchestrator
├── launches/
│   ├── pumpfun.ts       # Local TX construction (no 3rd party API)
│   └── raydium.ts       # CPMM pool creation
└── postlaunch/
    ├── migration.ts     # Onchain bonding curve monitor
    ├── volumeBot.ts     # Jupiter buy/sell cycles
    └── autoSell.ts      # Price tracking + profit target sells
```

## Security

- Never commit `.env` — use `.env.example` as template
- Set `WALLET_VAULT_PASSWORD` to encrypt generated wallets on disk
- Always start with `DRY_RUN=true`
- Slippage is capped at 10% (1000 bps) to prevent sandwich attacks
- All TX confirmations are awaited before proceeding
- Graceful shutdown (Ctrl+C) stops all services cleanly

## Recovery

If the process crashes after wallet funding, wallets are persisted in `wallets/vault.enc` (encrypted) or `wallets/vault.json`. The next run will reload them automatically.
