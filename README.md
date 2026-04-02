# Anon Bundler — Solana Token Launch Bundler v2.1

All-in-one Solana Token Launch Bundler mit Jito-Bundle-Unterstützung, Pump.fun- und Raydium-Start, Volume-Bot, Auto-Sell und SOL-Recovery — komplett lokal, kein Third-Party-API erforderlich.

---

## Inhaltsverzeichnis

1. [Was ist der Anon Bundler?](#was-ist-der-anon-bundler)
2. [Was ist neu in v2.1?](#was-ist-neu-in-v21)
3. [Features im Überblick](#features-im-überblick)
4. [Voraussetzungen](#voraussetzungen)
5. [Installation & Setup](#installation--setup)
6. [Konfiguration (.env)](#konfiguration-env)
7. [Verwendung](#verwendung)
8. [Architektur](#architektur)
9. [Technische Details](#technische-details)
   - [Wallet-Generierung & Vault](#wallet-generierung--vault)
   - [Wallet-Finanzierung](#wallet-finanzierung)
   - [Address Lookup Table (LUT)](#address-lookup-table-lut)
   - [Pump.fun Launch](#pumpfun-launch)
   - [Raydium CPMM Launch](#raydium-cpmm-launch)
   - [Jito Bundle](#jito-bundle)
   - [Volume Bot](#volume-bot)
   - [Auto-Sell Monitor](#auto-sell-monitor)
   - [Migration Monitor](#migration-monitor)
   - [SOL-Recovery](#sol-recovery)
10. [Sicherheitshinweise](#sicherheitshinweise)
11. [Fehlerbehebung](#fehlerbehebung)
12. [Häufige Fragen (FAQ)](#häufige-fragen-faq)

---

## Was ist der Anon Bundler?

Der Anon Bundler ist ein vollständig lokales TypeScript-Tool zum atomaren Launch von SPL-Token auf Solana. Es bündelt Token-Erstellung und koordinierte Käufe mehrerer Wallets in einem einzigen Jito-Bundle, sodass Create- und Buy-Transaktionen in einem Block bestätigt werden.

**Kernprinzip:** Alle Transaktionen werden lokal signiert und konstruiert — es werden keine privaten Schlüssel an externe APIs übertragen. Die Metadaten werden über Pinata auf IPFS hochgeladen (konfigurierbar), der Rest läuft vollständig on-chain.

Der Bundler unterstützt zwei Launch-Plattformen:

- **Pump.fun** — Token-Erstellung plus koordinierte Käufe über die Bonding Curve, alles in einem Jito-Bundle (max. 5 Transaktionen: 1 Create + 3 Buys + 1 Tip)
- **Raydium V2 CPMM** — Direkter Pool-Launch mit voller Liquiditätskontrolle

Nach dem Launch laufen optional drei Post-Launch-Dienste:

- **Volume Bot** — simuliert organisches Handelsvolumen über Jupiter
- **Auto-Sell Monitor** — verkauft automatisch bei Profit-Target oder Trailing Stop
- **Migration Monitor** — erkennt Pump.fun → PumpSwap/Raydium-Migration

---

## Was ist neu in v2.1?

Version 2.1 behebt mehrere kritische Bugs aus v2.0 und fügt neue Funktionen hinzu:

### Bug Fixes

| # | Bereich | Problem in v2.0 | Fix in v2.1 |
|---|---------|-----------------|-------------|
| FIX #1 | Jito Bundle | Transaktionen wurden base64-kodiert übertragen — Jito-API lehnt das ab | Korrekte base58-Kodierung |
| FIX #2 | Pump.fun Buy | Token-Betrag wurde als `0` übergeben, was zu Revert oder 0 Tokens führte | Echter Bonding-Curve-Math (Constant Product Formula) |
| FIX #3 | Bundle-Größe | Tip-TX wurde abgeschnitten wenn Bundle voll war (max. 5 TXs) | Payload-TXs werden zuerst auf max. 4 begrenzt, Slot 5 = Tip |
| FIX #4 | Wallet Vault | Plaintext-Fallback schrieb private Schlüssel unverschlüsselt auf die Festplatte | Kein Plaintext-Fallback; Vault-Passwort für echte Launches erforderlich |
| FIX #7 | Trailing Stop | Trailing Stop setzte nur ein internes Flag, verkaufte aber nicht | Shared `executeSellAll()`-Funktion, die tatsächlich verkauft |
| FIX #8 | Migration | Bonding-Curve-Daten wurden ohne Validierung gelesen (Buffer-Overflow-Risiko) | Diskriminator-Prüfung + Datenlängen-Validierung vor jedem Lesen |
| FIX #9 | Volume Bot | Sell-Betrag war `solAmount * 1e9` (vollständig falsch) | Verkauft prozentualen Anteil des tatsächlichen Token-Guthabens |
| FIX #10 | Blockhash | Veralteter Blockhash führte zu TX-Fehlern | Frischer Blockhash kurz vor TX-Konstruktion |
| FIX #11 | Jito Tip-Accounts | Private RPC-Methode für Tip-Account-Abfrage | Offizielle Jito-API + statische Fallback-Adressen |
| FIX #13 | Creator Buy | Creator-Kaufbetrag war hardcoded auf 0,5 SOL | Konfigurierbar via `CREATOR_BUY_SOL` |
| FIX #14 | Bundle-Limit | `bundleWalletsCount` konnte auf 4 gesetzt werden (überschreitet Jito-Limit) | Max. 3 Bundle-Wallets (1 Create + 3 Buys + 1 Tip = 5) |
| FIX #17 | Rate Limiting | Jupiter-API-Aufrufe ohne Ratenbegrenzung → HTTP 429-Fehler | `RateLimiter`-Klasse, max. 30 Anfragen/Minute |

### Neue Features

- **`npm run recover`** — Recovery-Skript zum Zurückholen von SOL aus finanzierten Buyer-Wallets nach Crashes
- **`RateLimiter`-Klasse** — Verhindert API-Bans durch Ratenbegrenzung der Jupiter-Aufrufe
- **Konfigurierbarer Creator-Kauf** — `CREATOR_BUY_SOL` Umgebungsvariable
- **Bonding-Curve-Validierung** — Diskriminator-Check vor dem Lesen von Account-Daten
- **Verbesserte `tsconfig.json`** — `declarationMap` und `sourceMap` für besseres Debugging

---

## Features im Überblick

| Feature | Beschreibung |
|---------|-------------|
| **Pump.fun Launch** | Lokale TX-Konstruktion (kein Pump.fun API), atomares Create + Multi-Buy via Jito-Bundle |
| **Raydium V2 CPMM** | Pool-Erstellung mit voller Liquiditätskontrolle |
| **Jito Bundles** | Echte Dual-Submission an mehrere Block-Engines mit Tip-Transaktionen |
| **Volume Bot** | Jupiter-basierte Buy/Sell-Zyklen mit randomisierten Beträgen und Timing |
| **Auto-Sell** | Jupiter-Preisverfolgung, Profit-Target-Verkäufe, Trailing Stop-Loss |
| **Migration Monitor** | Onchain Bonding-Curve-Fortschritt + automatische Migrationserkennung |
| **Wallet Vault** | AES-256-GCM verschlüsselte Wallet-Persistenz (Crash-Recovery) |
| **Fund Recovery** | SOL aus Buyer-Wallets zurückholen wenn Launch fehlschlug |
| **Dry-Run-Modus** — | Gesamten Ablauf simulieren ohne Transaktionen zu senden |
| **Graceful Shutdown** | Ctrl+C stoppt alle laufenden Dienste sauber |
| **Vanity-Adressen** | Optionale Generierung von Wallet-Adressen mit bestimmtem Präfix |

---

## Voraussetzungen

- **Node.js** v18+ (empfohlen: v20 LTS)
- **npm** v9+
- **Solana-Wallet** mit ausreichend SOL auf dem Master-Wallet
  - Faustregel: `NUM_WALLETS × SOL_PER_WALLET + 0.5 SOL` für Fees und LUT
- **Pinata-Account** für IPFS-Metadaten-Upload (kostenloser Plan ausreichend)
  - Nur bei echten Launches; Dry-Run funktioniert ohne Pinata
- **RPC-Endpunkt** mit ausreichend Rate-Limits (empfohlen: QuickNode, Helius, oder Triton)
  - Jito-kompatible RPC-Endpunkte sind für Bundle-Submission bevorzugt

---

## Installation & Setup

```bash
# 1. Repository klonen
git clone <your-repo-url>
cd Anon-Bundler-

# 2. Abhängigkeiten installieren
npm install

# 3. Umgebungskonfiguration erstellen
cp .env.example .env

# 4. .env mit deinen Werten befüllen
nano .env   # oder ein beliebiger Editor
```

### Schnellstart-Checkliste

- [ ] Node.js v18+ installiert
- [ ] `npm install` ausgeführt
- [ ] `.env` erstellt und konfiguriert
- [ ] `RPC_URL` auf einen funktionierenden Solana-RPC-Endpunkt gesetzt
- [ ] `MASTER_PRIVATE_KEY` auf deinen Base58-kodierten privaten Schlüssel gesetzt
- [ ] `WALLET_VAULT_PASSWORD` auf ein sicheres Passwort gesetzt (für echte Launches)
- [ ] `PINATA_JWT` auf deinen Pinata-JWT-Token gesetzt (für echte Launches)
- [ ] Dry-Run ausgeführt und Ausgabe geprüft
- [ ] Master-Wallet mit ausreichend SOL aufgeladen

---

## Konfiguration (.env)

Alle Einstellungen werden über Umgebungsvariablen in der `.env`-Datei vorgenommen. Niemals `.env` in Git committen — nur `.env.example` als Template verwenden.

### RPC & Master-Wallet

| Variable | Pflicht | Beschreibung |
|----------|---------|-------------|
| `RPC_URL` | ✅ | HTTPS-URL zu deinem Solana-RPC-Endpunkt. Muss mit `https://` beginnen. Empfohlen: QuickNode, Helius, Triton mit dediziertem Endpunkt |
| `MASTER_PRIVATE_KEY` | ✅ | Base58-kodierter privater Schlüssel des Master-Wallets. Das Master-Wallet finanziert alle Buyer-Wallets, zahlt Jito-Tip und Launch-Fees |

### Launch-Modus

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `MODE` | `pump` | Launch-Plattform: `pump` (Pump.fun), `raydium` (Raydium V2 CPMM), oder `multi` (beides — zuerst Pump.fun) |

### Token-Konfiguration

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `TOKEN_NAME` | `MyToken` | Name des Tokens (z. B. `PepeKing`) |
| `TOKEN_SYMBOL` | `MTK` | Ticker-Symbol (z. B. `PEPE`) |
| `TOKEN_DESCRIPTION` | leer | Beschreibung für Metadaten (erscheint auf Pump.fun und DexScreener) |
| `TOKEN_IMAGE_URL` | leer | URL zu einem öffentlich zugänglichen Bild (PNG/JPG, empfohlen: quadratisch). Wird auf IPFS hochgeladen |

### Wallet- & Bundle-Konfiguration

| Variable | Standard | Min | Max | Beschreibung |
|----------|----------|-----|-----|-------------|
| `NUM_WALLETS` | `20` | `1` | `300` | Anzahl der Buyer-Wallets. Mehr Wallets = mehr Post-Launch-Volumen. **Kosten**: `NUM_WALLETS × SOL_PER_WALLET` SOL |
| `SOL_PER_WALLET` | `0.28` | — | — | SOL, das jedes Buyer-Wallet erhält. Sollte mindestens `0.1` SOL sein, um Gas + Käufe zu decken |
| `BUNDLE_WALLETS_COUNT` | `3` | `1` | `3` | Anzahl der Buyer-Wallets im Jito-Bundle. **Maximal 3**, da Jito maximal 5 Transaktionen erlaubt (1 Create + 3 Buys + 1 Tip = 5) |
| `JITO_TIP_LAMPORTS` | `950000` | `100000` | `10000000` | Jito-Tip in Lamports (1 SOL = 1.000.000.000 Lamports). Höherer Tip = höhere Priorität bei der Blockaufnahme. Standard: ~0.00095 SOL |
| `VANITY_PREFIX` | leer | — | — | Optionales Präfix für generierte Wallet-Adressen (z. B. `ABC`). Leer lassen für zufällige Adressen |
| `VANITY_TIMEOUT_SEC` | `30` | `5` | `300` | Timeout in Sekunden für Vanity-Adresssuche. Danach werden normale Adressen generiert |

### Creator-Kauf

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `CREATOR_BUY_SOL` | `0.5` | SOL-Betrag, den der Creator (Master-Wallet) beim Token-Launch kauft. Dieser Kauf ist Teil der Create-Transaktion im Bundle |

### Slippage

| Variable | Standard | Min | Max | Beschreibung |
|----------|----------|-----|-----|-------------|
| `SLIPPAGE_BPS` | `500` | `50` | `1000` | Slippage-Toleranz in Basis-Punkten (1 bps = 0,01%). `500` = 5%, `1000` = 10% (Maximum, schützt vor Sandwich-Attacks). Gilt für alle Pump.fun-Käufe, Volume-Bot und Auto-Sell |

### Post-Launch-Dienste

| Variable | Standard | Beschreibung |
|----------|----------|-------------|
| `AUTO_MIGRATE` | `true` | Migration Monitor aktivieren. Verfolgt den Bonding-Curve-Fortschritt und erkennt Migration zu PumpSwap/Raydium. Nur sinnvoll im `pump`/`multi`-Modus |
| `VOLUME_BOT_ENABLED` | `true` | Volume Bot aktivieren. Erzeugt organisch wirkendes Handelsvolumen via Jupiter nach dem Launch |
| `VOLUME_BUYS_PER_MIN` | `12` | Anzahl der Transaktionen pro Minute im Volume Bot. Wird intern auf max. 30 begrenzt um API-Rate-Limits zu vermeiden |
| `AUTO_SELL_PERCENT` | `35` | Profit-Target in Prozent. Bei +35% über Einstiegspreis werden Positionen automatisch verkauft |

### Metadaten

| Variable | Pflicht | Beschreibung |
|----------|---------|-------------|
| `PINATA_JWT` | Für echte Launches | JWT-Token von [app.pinata.cloud](https://app.pinata.cloud). Wird für den Upload der Token-Metadaten (Name, Symbol, Beschreibung, Bild) auf IPFS benötigt |

### Sicherheit

| Variable | Pflicht | Beschreibung |
|----------|---------|-------------|
| `WALLET_VAULT_PASSWORD` | Für echte Launches | Passwort zur AES-256-GCM-Verschlüsselung des Wallet-Vaults auf der Festplatte. Bei echten Launches (**`DRY_RUN=false`**) **zwingend erforderlich** — verhindert, dass private Schlüssel unverschlüsselt gespeichert werden |
| `DRY_RUN` | — | `true`: Simuliert den gesamten Ablauf ohne Transaktionen zu senden (Standard: `true`). **Immer zuerst mit `DRY_RUN=true` testen!** |

---

## Verwendung

### 1. Dry-Run (empfohlen als erster Schritt)

Simuliert den kompletten Launch-Ablauf ohne echte Transaktionen:

```bash
DRY_RUN=true npx ts-node src/index.ts
# oder:
npm start
```

Im Dry-Run wird die komplette Ausgabe angezeigt (Wallet-Generierung, Funding-Simulation, Bundle-Konstruktion), aber keine Transaktion gesendet.

### 2. Echter Launch

Nachdem der Dry-Run erfolgreich war und alle Konfigurationen geprüft wurden:

```bash
DRY_RUN=false npx ts-node src/index.ts
```

**Vorher sicherstellen:**
- Master-Wallet hat ausreichend SOL (`NUM_WALLETS × SOL_PER_WALLET + ~1 SOL` Puffer)
- `WALLET_VAULT_PASSWORD` ist gesetzt
- `PINATA_JWT` ist gesetzt
- RPC-Endpunkt ist zuverlässig

### 3. Build-Version (optional, schneller als ts-node)

```bash
npm run build           # Kompiliert TypeScript nach dist/
npm run start:built     # Führt kompilierte Version aus
```

### 4. SOL-Recovery nach Crash

Falls der Prozess nach der Wallet-Finanzierung aber vor dem Launch abstürzt:

```bash
npm run recover
```

Das Recovery-Skript lädt den verschlüsselten Wallet-Vault, prüft alle Balances und überträgt SOL zurück zum Master-Wallet. Token-Bestände müssen vorher manuell oder über den Volume Bot verkauft werden.

### Ablauf-Übersicht

```
Schritt 1: Wallets generieren (oder aus Vault laden)
     ↓
Schritt 2: Buyer-Wallets finanzieren (Master → je Buyer)
     ↓
Schritt 3: Address Lookup Table erstellen
     ↓
Schritt 4: Token launchen (Pump.fun oder Raydium)
     ↓
Schritt 5: Jito-Bundle senden + auf Bestätigung warten
     ↓
Post-Launch: Volume Bot + Auto-Sell + Migration Monitor
     ↓
Ctrl+C: Graceful Shutdown aller Dienste
```

---

## Architektur

```
Anon-Bundler-/
├── .env.example              # Template für alle Umgebungsvariablen
├── .gitignore                # Schließt .env, wallets/, dist/ aus
├── package.json              # Abhängigkeiten + npm-Skripte
├── tsconfig.json             # TypeScript-Konfiguration
└── src/
    ├── config.ts             # Zentrales Konfigurations-Objekt (aus .env geparst)
    ├── utils.ts              # Hilfsfunktionen: Retry, Logging, RateLimiter, TX-Bestätigung
    ├── wallets.ts            # Wallet-Generierung + AES-256-GCM Vault-Verschlüsselung
    ├── funding.ts            # Balance-geprüfte Batch-Finanzierung der Buyer-Wallets
    ├── lut.ts                # Address Lookup Table erstellen + bestätigen
    ├── metadata.ts           # Pinata IPFS-Upload für Token-Metadaten
    ├── jito.ts               # Jito-Bundle senden (base58) + Dual-Submission + Status-Polling
    ├── index.ts              # State-Machine-Orchestrator (Hauptablauf)
    ├── recover.ts            # Recovery-Skript: SOL aus Buyer-Wallets zurückholen
    ├── launches/
    │   ├── pumpfun.ts        # Lokale TX-Konstruktion: Create + Buy mit Bonding-Curve-Math
    │   └── raydium.ts        # Raydium V2 CPMM Pool-Erstellung
    └── postlaunch/
        ├── migration.ts      # Onchain Bonding-Curve-Monitor + Migrationserkennung
        ├── volumeBot.ts      # Jupiter Buy/Sell-Zyklen (rate-limited)
        └── autoSell.ts       # Preisverfolgung + Profit-Target + Trailing-Stop-Sells
```

---

## Technische Details

### Wallet-Generierung & Vault

**Datei:** `src/wallets.ts`

Buyer-Wallets werden mit `Keypair.generate()` generiert. Falls ein `VANITY_PREFIX` gesetzt ist, werden Wallets generiert bis eine Adresse mit dem gewünschten Präfix gefunden wird (case-insensitive). Nach `VANITY_TIMEOUT_SEC` Sekunden werden restliche Wallets ohne Vanity aufgefüllt.

**Vault-Verschlüsselung:**
- Algorithmus: AES-256-GCM mit PBKDF2-abgeleitetem Schlüssel (100.000 Iterationen, SHA-256)
- Speicherformat: `salt (16 Bytes) | iv (12 Bytes) | authTag (16 Bytes) | ciphertext`
- Speicherort: `wallets/vault.enc`
- Ohne `WALLET_VAULT_PASSWORD` werden Wallets nicht gespeichert (nur im Dry-Run-Modus toleriert)

Beim Start prüft der Bundler automatisch ob ein Vault existiert und lädt die Wallets wieder. So können unterbrochene Launches fortgesetzt werden ohne neue Wallets zu generieren.

### Wallet-Finanzierung

**Datei:** `src/funding.ts`

Das Master-Wallet überträgt `SOL_PER_WALLET` SOL an jedes Buyer-Wallet via Batch-Transaktionen. Vor der Überweisung wird geprüft ob das Wallet bereits ausreichend Guthaben hat (idempotent). Transaktionen werden mit `confirmTx()` bestätigt bevor fortgefahren wird.

### Address Lookup Table (LUT)

**Datei:** `src/lut.ts`

Eine Address Lookup Table wird erstellt die Master- und alle Buyer-Wallets enthält. LUTs erlauben es, mehr Accounts pro Transaktion zu referenzieren (bis zu 256 statt 32 statischer Accounts). Nach der Erstellung wird auf Bestätigung gewartet bevor die LUT verwendet werden kann.

### Pump.fun Launch

**Datei:** `src/launches/pumpfun.ts`

Der Launch wird vollständig lokal konstruiert — keine Pump.fun API wird verwendet:

**Token-Erstellung (TX 1: Create + Creator Buy):**
- `buildPumpCreateInstruction()` — codiert den `create`-Discriminator (`0x18, 0x1e, 0xc8, ...`) plus Name/Symbol/URI als Borsh-ähnliches Layout
- Metaplex-Metadaten-PDA wird für On-Chain-Metadaten mitgegeben
- Creator kauft direkt in der gleichen Transaktion

**Käufe (TX 2-4: Buyer-Wallets):**
- `buildPumpBuyInstruction()` — codiert den `buy`-Discriminator (`0x66, 0x06, 0x3d, ...`)
- Bonding-Curve-Math via Constant-Product-Formula:
  ```
  tokens_out = (virtual_token_reserves × sol_in) / (virtual_sol_reserves + sol_in)
  ```
- Initiale virtuelle Reserven: 30 SOL / ~1,073 Mrd. Tokens
- Virtuelle Reserven werden nach jedem simulierten Kauf nachgeführt um akkurate Mengen für folgende Käufer zu berechnen
- Slippage wird angewendet: `min_tokens = expected × (10000 - slippageBps) / 10000`

**Jito-Bundle-Limit:**
- Max. 5 Transaktionen pro Bundle: 1 Create + max. 3 Buys + 1 Tip
- `BUNDLE_WALLETS_COUNT` ist daher auf 3 begrenzt

### Raydium CPMM Launch

**Datei:** `src/launches/raydium.ts`

Erstellt einen Raydium V2 CPMM (Constant Product Market Maker) Pool via `@raydium-io/raydium-sdk-v2`. Der Pool enthält den neu erstellten Token und SOL (als WSOL). Die initiale Liquidität kommt vom Master-Wallet.

### Jito Bundle

**Datei:** `src/jito.ts`

**Ablauf:**
1. Payload-Transaktionen werden auf max. 4 begrenzt (reserviert Slot 5 für Tip)
2. Tip-Transaktion wird gebaut: SOL-Transfer vom Master zu einem zufälligen Jito-Tip-Account
3. Tip-Accounts werden dynamisch via Jito-API geladen (`https://mainnet.block-engine.jito.wtf/api/v1/bundles/tip_accounts`) mit statischen Fallback-Adressen
4. Bundle wird an **beide** Block-Engines submitted (mainnet + ny) — Dual-Submission für höhere Erfolgswahrscheinlichkeit:
   - `https://mainnet.block-engine.jito.wtf/api/v1/bundles`
   - `https://ny.block-engine.jito.wtf/api/v1/bundles`
5. Transaktionen werden **base58-kodiert** übertragen (Jito-API-Anforderung — base64 wird abgelehnt)
6. Status-Polling über `getBundleStatuses` bis Bestätigung oder Timeout (60s)

### Volume Bot

**Datei:** `src/postlaunch/volumeBot.ts`

Erzeugt organisch wirkendes Handelsvolumen:
- **Ratio:** 70% Käufe, 30% Verkäufe
- **Käufe:** Zufälliger Betrag zwischen 0,005 und 0,09 SOL via Jupiter Quote + Swap API
- **Verkäufe:** 5–15% des tatsächlichen Token-Guthabens (nicht SOL-basiert wie in v2.0)
- **Timing:** `60.000 / VOLUME_BUYS_PER_MIN` ms Intervall + zufälliger Jitter (0–30%)
- **Rate Limiting:** Alle Jupiter-Aufrufe über `jupiterLimiter` (max. 30 Anfragen/60s)
- Rotiert durch alle verfügbaren Buyer-Wallets der Reihe nach

### Auto-Sell Monitor

**Datei:** `src/postlaunch/autoSell.ts`

Verfolgt den Token-Preis via Jupiter Price API und verkauft automatisch:

**Profit-Target:**
- Bei `+AUTO_SELL_PERCENT%` über dem initialen Preis werden alle Positionen verkauft
- Master-Wallet: 50% der Bestände
- Buyer-Wallets: 100% der Bestände (bis `BUNDLE_WALLETS_COUNT`)

**Trailing Stop:**
- Triggert wenn der Preis >20% vom All-Time-High gefallen ist UND noch >10% im Profit
- Schützt aufgelaufene Gewinne ohne zu früh zu verkaufen

**Sell-Mechanismus:**
- Jupiter Quote API → Jupiter Swap API → `sendRawTransaction`
- Prioritization Fee: 100.000 Lamports für schnelle Ausführung
- Sells werden gestaffelt (2s Pause) um Slippage zu minimieren

### Migration Monitor

**Datei:** `src/postlaunch/migration.ts`

Überwacht den Pump.fun Bonding-Curve-Fortschritt onchain:
- Liest `virtualSolReserves` aus dem Bonding-Curve-PDA (`bonding-curve` Seed + Mint)
- **Validierung:** Prüft Diskriminator (`0x17, 0xb7, 0xf8, ...`) und Datenlänge (min. 128 Bytes) vor dem Lesen
- Fortschritt: `virtualSolReserves / 85 SOL × 100%` (Pump.fun migriert bei ~85 SOL)
- Erkennt Migration via DexScreener-API: Prüft ob Raydium-Pool mit Liquidität existiert
- Polling-Intervall: 7s (unter 100%), 30s (nach Abschluss)

### SOL-Recovery

**Datei:** `src/recover.ts`

```bash
npm run recover
```

Läuft durch alle Wallets im Vault und überträgt SOL zurück zum Master:
- Lässt 5.000 Lamports für Transaktionsgebühren übrig
- Überspringt Wallets mit weniger als 890.880 Lamports (Rent-Exempt-Mindestbetrag)
- 500ms Pause zwischen den Wallets (RPC-freundlich)
- Dry-Run zeigt voraussichtlich zurückgeholte Menge an ohne Transaktionen zu senden
- **Hinweis:** Nur SOL wird recovered — Token-Bestände müssen vorher verkauft werden

---

## Sicherheitshinweise

### Kritisch

- **Niemals `.env` committen** — enthält deinen privaten Schlüssel und Vault-Passwort
- **`WALLET_VAULT_PASSWORD` immer setzen** bei echten Launches — ohne Passwort keine Verschlüsselung, private Schlüssel bleiben ungesichert
- **Master-Wallet-Schlüssel sichern** — wer den Schlüssel hat, kontrolliert alle Funds
- **Immer mit `DRY_RUN=true` starten** — prüfe den Ablauf bevor echte Funds eingesetzt werden

### Empfohlen

- Dediziertes Master-Wallet für den Bundler verwenden (kein Wallet mit anderen Funds)
- RPC-Endpunkt mit Rate-Limit-Schutz wählen
- Nicht mehr SOL einsetzen als bereit zu verlieren
- Slippage auf max. 10% (1000 bps) begrenzen — das ist der eingebaute Schutz vor Sandwich-Attacks
- TX-Bestätigungen werden abgewartet bevor der nächste Schritt ausgeführt wird
- Graceful Shutdown via Ctrl+C — beendet alle laufenden Dienste sauber

### Was der Bundler NICHT tut

- Keine privaten Schlüssel werden an externe Server gesendet
- Keine Transaktionen werden ohne Bestätigung fortgeführt
- Keine Transaktionen werden gesendet wenn `DRY_RUN=true`

---

## Fehlerbehebung

### "Missing required env var: RPC_URL"
→ `.env`-Datei fehlt oder `RPC_URL` ist nicht gesetzt. `cp .env.example .env` ausführen und ausfüllen.

### "MASTER_PRIVATE_KEY looks invalid (too short)"
→ Der private Schlüssel muss mindestens 40 Zeichen lang sein. Base58-kodierten Key aus Phantom/Solflare exportieren.

### "WALLET_VAULT_PASSWORD is required for non-dry-run launches"
→ `WALLET_VAULT_PASSWORD` in `.env` setzen. Für Dry-Runs ist das nicht nötig.

### "All Jito block engines rejected bundle"
→ Mögliche Ursachen: Bundle zu groß (>5 TXs), Transaktion fehlgeschlagen, Blockhash veraltet. `BUNDLE_WALLETS_COUNT` auf 3 reduzieren; RPC-Verbindung prüfen.

### "Bonding curve discriminator mismatch"
→ Pump.fun hat möglicherweise das Account-Layout geändert. Migration-Monitor läuft weiter mit Heuristik (Account-Existenz-Check).

### Volume Bot: "Volume buy failed: 429 Too Many Requests"
→ `VOLUME_BUYS_PER_MIN` reduzieren (z.B. auf 6). Die eingebaute `RateLimiter`-Klasse begrenzt auf 30 Aufrufe/Minute, aber manche RPC-Endpunkte haben strengere Limits.

### Recovery: "No wallets found in vault. Nothing to recover."
→ Vault-Datei (`wallets/vault.enc`) fehlt oder `WALLET_VAULT_PASSWORD` stimmt nicht überein. Passwort prüfen.

### Build-Fehler: "Cannot find module '@raydium-io/raydium-sdk-v2'"
→ `npm install` erneut ausführen.

---

## Häufige Fragen (FAQ)

**Wie viel SOL brauche ich für einen Launch?**
Formel: `(NUM_WALLETS × SOL_PER_WALLET) + CREATOR_BUY_SOL + JITO_TIP_SOL + ~0.3 SOL Puffer`
Beispiel mit Defaults: `(20 × 0.28) + 0.5 + 0.00095 + 0.3 ≈ 6.4 SOL`

**Kann ich das Tool mehrfach ausführen?**
Ja. Falls ein Vault existiert werden die gleichen Wallets wiederverwendet (idempotent). Falls die Wallets bereits finanziert sind wird das erkannt und übersprungen.

**Was passiert wenn der Prozess während der Finanzierung abstürzt?**
Die Wallets sind im Vault gespeichert. Beim nächsten Start werden sie geladen. Nach dem Launch `npm run recover` ausführen um SOL zurückzuholen.

**Wie sicher ist der Volume Bot vor Erkennung?**
Der Bot verwendet zufällige Beträge (0.005–0.09 SOL Käufe), zufälliges Timing (±30% Jitter) und wechselt zwischen Käufen (70%) und Verkäufen (30%) ab — wirkt organischer als reine Käufe.

**Kann ich nach dem Launch neue Wallets hinzufügen?**
Nein — die Wallet-Liste wird beim ersten Start generiert und im Vault gesichert. Für neue Wallets einen neuen Vault mit anderem Passwort erstellen.

**Was bedeutet `BUNDLE_WALLETS_COUNT=3` (max)?**
Jito erlaubt maximal 5 Transaktionen pro Bundle. Der Bundler verwendet: 1 Create-TX + bis zu 3 Buy-TXs + 1 Tip-TX = 5. Mehr als 3 Bundle-Wallets würden das Limit überschreiten und das Bundle würde abgelehnt.

**Funktioniert das Tool auch auf Devnet?**
Nicht out-of-the-box — Pump.fun und Jito existieren nur auf Mainnet. Für Tests immer den Dry-Run-Modus (`DRY_RUN=true`) verwenden.

**Wie erkenne ich eine erfolgreiche Migration?**
Der Migration Monitor loggt `"Token has been migrated to PumpSwap/Raydium!"` sobald ein Raydium-Pool mit Liquidität auf DexScreener erkannt wird.

---

## Lizenz

Dieses Projekt wird ohne Garantien bereitgestellt. Nutzung auf eigenes Risiko. Nicht für illegale Aktivitäten verwenden.
