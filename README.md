# Midnight ShieldedFungibleToken — indexer-view reproducer

A self-contained TypeScript project that, with **one command**, deploys a
shielded token on a local Midnight v8 stack, mints it, burns part of it, and
**decodes every raw transaction** to show exactly what a public observer (the
chain indexer) can and cannot see.

It uses OpenZeppelin's `ShieldedFungibleToken.compact` as the example contract.
The compiled contract + ZK keys are vendored, so no Compact compiler is needed:
`install` then `run`.

```
deploy ──▶ mint (1,000,000) ──▶ burn (400,000, change 600,000) ──▶ decode all 3 txs ──▶ out/INDEXER-VIEW.md
```

## Prerequisites

- **Docker** running (the script brings up node + indexer + proof-server as
  containers on random host ports via testcontainers).
- **Node.js >= 20**.
- **pnpm** (or npm). All dependencies come from the **public npm registry** —
  no private registry, no auth token. The `@midnight-ntwrk/*` packages
  (ledger-v8, testkit-js, midnight-js-*, wallet-sdk, compact-js,
  compact-runtime) are published there.
- ~3 GB free disk for Docker images (proof-server, indexer, node) on first run,
  plus the 24 MB of ZK keys vendored in this repo.

## Quick start

```bash
pnpm install
pnpm reproduce
```

(or `npm install && npm run reproduce`)

The first run pulls the Docker images (a few minutes). A full run takes roughly
8–12 minutes: container startup, wallet sync, then one ZK proof per transaction.
When it finishes you get a summary like:

```
DONE. Summary:
  contract : c6d82f32118e89bb562dc085458358d367b8a2651433888844d60dc5ffcedd60
  tx #1 deploy  15313 bytes  f28df45643f65aeb81356bf412182124469ed70adb606efe43f7041d58a1efa1
  tx #2 mint    14415 bytes  d725650e4ce26cf4032ba37e9762a01e21203b71415f5445ced9e81596299f36
  tx #3 burn    44295 bytes  579cc29ccdc4563cc51a9d7459f5df81871f6a31ce7f97d886ffabdca3175a85
  minted 1000000, burned 400000, change 600000
  report : .../out/INDEXER-VIEW.md
```

(Addresses and hashes differ every run — the contract uses a random nonce/domain;
byte sizes are roughly stable.) A committed example of the generated report is in
[`SAMPLE-OUTPUT.md`](./SAMPLE-OUTPUT.md).

## What you get (in `out/`)

| File | Contents |
|---|---|
| `INDEXER-VIEW.md` | Human-readable report: per-tx public view + a public-vs-hidden summary |
| `1-deploy.hex`, `2-mint.hex`, `3-burn.hex` | The exact raw bytes submitted on-chain |
| `*.decode.txt` | Full structured decode of each tx (transcript effects, Zswap offers, ledger dump) |

Re-decode any captured tx on its own:

```bash
pnpm decode -- out/3-burn.hex      # or: npx tsx src/decode.ts out/3-burn.hex
```

## What's public vs hidden (the point of this repo)

Decoding the raw bytes shows what an indexer ingests. For this archived
`ShieldedERC20`:

| Always public | Always hidden |
|---|---|
| Contract address + entry point (`mint` / `burn`) | Coin owners / recipient public keys |
| Token color (type) | Which output commitment belongs to whom |
| New coin commitments, spent-coin nullifiers | The value sealed inside a commitment |
| Public VM transcript + gas | Dust balance (only a nullifier + commitment) |
| A ZK proof is attached | What the proof proves |

**Amount visibility depends on the circuit.** In this contract:

- **mint** publishes the amount in the transcript's `shieldedMints` effect.
- **burn** calls `disclose(coin)` / `disclose(amount)`, so the coin value
  (1,000,000) and change (600,000) appear as literals in the public transcript —
  the burned amount (400,000) is therefore derivable.

So both mint and burn leak the *amount* here; only the coin *owners* stay
hidden. A future amount-private burn would need to avoid disclosing the coin
value and change to the public transcript.

## How it works

| File | Role |
|---|---|
| `src/reproduce.ts` | Orchestrator: start local stack → wallet → deploy → mint → burn → decode → report |
| `src/wallet-provider.ts` | `WalletProvider`/`MidnightProvider` (balance + submit); captures each submitted tx's raw bytes |
| `src/providers.ts` | Assembles the midnight-js providers (indexer, proof, zk-config, private-state) |
| `src/contract.ts` | Deploy / join / mint / burn against the vendored contract |
| `src/wallet-utils.ts` | Fund/sync waits, incl. waiting for a minted coin to become spendable before burn |
| `src/decode.ts` | Deserializes raw tx bytes into the public/indexer view (also a standalone CLI) |
| `compose.yml` | The local v8 stack testkit brings up (public Docker Hub images) |
| `artifacts/.../ShieldedFungibleToken/` | Vendored compiled contract + ZK keys (no compiler needed) |
| `contracts/*.compact` | The Compact source closure, for reference / optional rebuild |

The local stack is started by testkit's `LocalTestEnvironment`, which reads
`./compose.yml` and assigns random host ports, so it never clashes with other
local stacks. The wallet is built from a prefunded dev-preset genesis seed
(`00…01`), so no faucet is needed.

### Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `TOKEN_NAME` | `OZ Test Token` | token name |
| `TOKEN_SYMBOL` | `OZT` | token symbol |
| `MINT_AMOUNT` | `1000000` | amount to mint |
| `BURN_AMOUNT` | `400000` | amount to burn (must be ≤ mint) |
| `DEBUG_LEVEL` | `info` | pino log level (`debug` for sync detail) |

```bash
MINT_AMOUNT=5000 BURN_AMOUNT=5000 pnpm reproduce   # full burn, no change
```

## Rebuilding the contract from source (optional)

The vendored `artifacts/` were produced by compiling `contracts/*.compact` with
the Compact compiler. You do **not** need this to run the reproducer. To rebuild
them you need the Compact toolchain (`compactc`) matching `compact-runtime`
`0.16.0`, then point `ZK_CONFIG_PATH` (in `src/reproduce.ts`) at the rebuilt
output. The import closure is:

```
ShieldedFungibleToken.compact → ShieldedERC20.compact → Utils.compact
```

## Troubleshooting

- **Docker not running** → start Docker; the script fails fast at "Starting
  local test environment".
- **Image pull denied** → the `compose.yml` images are public Docker Hub tags;
  the gated `ghcr.io/midnight-ntwrk/*` tags are intentionally not used.
- **`Timeout waiting for shielded token`** → the minted coin had not synced
  before the burn; re-run, or raise the timeout in `src/wallet-utils.ts`.
- **Leftover containers** → with `TESTCONTAINERS_RYUK_DISABLED=true` testkit may
  leave containers after a crash; remove stale `node_*` / `indexer_*` /
  `proof-server_*` containers manually.
