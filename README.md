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

## TL;DR — can you hide the burnt amount of a shielded token?

**Yes. What leaks a burn's amount is public supply accounting, not the burn
itself.** A burn moves a coin to an unspendable address. At the coin level that
is an ordinary shielded transfer, so the value stays sealed in a Pedersen
commitment. OpenZeppelin's `ShieldedERC20.burn` does reveal the amount, but only
because it writes the `_totalSupply` ledger cell in the clear, not because of the
coin operations. Remove that write (the counter-free experiment below) or burn
outside the contract, and the amount is hidden. We proved every case on a live
local v8 stack and decoded the raw bytes.

| | Mint (via contract) | Contract `burn` (`ShieldedERC20`) | Contract `burn` (`NoSupplyToken`) | Direct wallet burn |
|---|---|---|---|---|
| Path | `mint` circuit | `burn` circuit | `burn` circuit, no `_totalSupply` write | plain Zswap transfer to the zero coin key |
| Amount visible to indexer | **yes** (`shieldedMints` effect) | **yes**, via the public `_totalSupply` write (not the coin ops) | **no** (only commitments / nullifiers) | **no** (only a Pedersen commitment) |
| Coin owner / recipient | hidden | hidden | hidden | hidden |
| Contract can count it (`totalSupply`) | yes | yes | **no** (gave up the counter) | **no** (invisible to the contract) |
| `disclose` required in Compact | yes | yes | yes (unchanged) | n/a (no contract code runs) |

**What actually leaks it.** Spending or receiving a shielded coin inside a
contract (`receiveShielded`, `sendImmediateShielded`, `sendShielded`) emits only a
commitment and a nullifier, both hashes of the coin and never its plaintext value.
The Compact compiler *forces* `disclose` on all three, but `disclose` is a
compile-time permission marker, not a disclosure: it lets a value reach a sink, it
does not put it there. The amount becomes public only when the contract writes it
to a public sink. In `ShieldedERC20.burn` that sink is the `_totalSupply` ledger
cell (`_totalSupply = _totalSupply - disclose(amount)`). Remove that write and the
burn reveals nothing but hashes. The counter-free
[`NoSupplyToken`](./contracts/experiments/NoSupplyToken.compact) experiment below
proves it, cross-checked against the decoded bytes in
[`DISCLOSE-CLAIM-REVIEW.md`](./DISCLOSE-CLAIM-REVIEW.md).

**The trade-off.** Hiding the amount means giving up a public supply counter: a
globally auditable `totalSupply` has to be a public ledger cell, and that cell is
exactly what leaks. An off-contract hidden burn never touches the contract at all,
so a `totalBurned` counter could only ever be a lower bound on circulating supply.

Evidence: [`out/HIDDEN-BURN-VIEW.md`](./out/HIDDEN-BURN-VIEW.md) (amount hidden,
`pnpm hidden-burn`) vs [`out/INDEXER-VIEW.md`](./out/INDEXER-VIEW.md) (contract
burn, amount leaks, `pnpm reproduce`).

## Supply auditability: does the fold match the contract counter?

A second question: can a public indexer **recompute** a shielded token's supply,
and does it agree with the contract's own `totalSupply()` counter? `pnpm
verify-supply` runs one stack through deploy → mint → contract burn → hidden burn
→ protocol burn and, after each step, compares three numbers:

- **contract `totalSupply()`** — the contract's own counter (a ledger cell),
- **fold `−Σ deltas[tt]`** — what an indexer recomputes from public zswap deltas,
- **true circulating** — what is actually spendable, by construction of the run.

| Step | tx `delta[tt]` | fold `−Σδ` | contract `totalSupply()` | true circulating |
|---|---|---|---|---|
| mint 1,000,000 | −1,000,000 | 1,000,000 | 1,000,000 | 1,000,000 |
| contract burn 400,000 | 0 | **1,000,000** | 600,000 | 600,000 |
| hidden burn 200,000 | 0 | **1,000,000** | 600,000 | 400,000 |
| protocol burn 400,000 | **+400,000** | 600,000 | 600,000 | 0 |

All rows verified **PASS** on a live stack. Three findings:

1. **Supply = `−Σ deltas[tt]`.** After the mint, the indexer fold equals the
   minted amount. (The `shieldedMints` effect carries the mint amount too — but
   keyed by a *different* token type than the zswap color; see note below.)
2. **A "protocol burn" is public and real.** A hand-built one-input / zero-output
   zswap offer (a positive imbalance) is *accepted* by the node; the surplus is
   destroyed and the burned amount is plaintext in `deltas[tt] = +P` — no contract
   call, no record of who. This is the one burn the fold actually sees.
3. **Dead-coin burns are invisible to the fold.** Both the contract burn and the
   hidden burn leave the coin sitting in the pool (net delta 0), so the fold stays
   at 1,000,000 while the contract counter and the real circulating supply move.
   Neither the fold nor `totalSupply()` tracks real circulating supply — each is an
   upper bound that misses a *different* set of burns.

> **Two token-type keys.** `rawTokenType(domain, contractAddress)` equals the coin
> **color** (the zswap delta key). The `shieldedMints` mint effect is keyed by a
> separate derived value. The supply fold keys on the color; the mint cross-check
> sums `shieldedMints`. The report prints both.

Output: [`out/SUPPLY-AUDIT.md`](./out/SUPPLY-AUDIT.md) (committed sample:
[`SAMPLE-SUPPLY-AUDIT.md`](./SAMPLE-SUPPLY-AUDIT.md)).

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

Other entry points (same vendored contract + local stack):

```bash
pnpm hidden-burn      # mint via contract, then burn outside it (amount stays hidden)
pnpm verify-supply    # the supply-auditability scenario (5 steps, PASS/FAIL matrix)
```

If testkit's container log-wait is flaky in your environment (it can report
"Log stream ended … Started not received" within ~1s on a healthy stack), run the
self-managed variants instead, which bring the stack up with plain `docker compose`:

```bash
bash scripts/run-hidden-burn.sh      # -> pnpm hidden-burn
bash scripts/run-verify-supply.sh    # -> pnpm verify-supply
```

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

| File | Contents | Written by |
|---|---|---|
| `INDEXER-VIEW.md` | Per-tx public view + a public-vs-hidden summary | `reproduce` |
| `HIDDEN-BURN-VIEW.md` | The direct (amount-hidden) burn, decoded | `hidden-burn` |
| `SUPPLY-AUDIT.md` | Supply PASS/FAIL matrix + per-tx delta fold + protocol-burn finding | `verify-supply` |
| `<n>-<kind>.hex` | The exact raw bytes submitted on-chain (deploy/mint/burn/hidden-burn/protocol-burn) | all |
| `*.decode.txt` | Full structured decode of each tx (transcript effects, Zswap offers, ledger dump) | all |

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

**Amount visibility depends on what the circuit writes to public state.** In this
contract:

- **mint** publishes the amount in the transcript's `shieldedMints` effect. This
  is a protocol-level disclosure of token issuance, unavoidable from contract code.
- **burn** writes the `_totalSupply` ledger cell: the decode shows the old value
  (1,000,000) and new value (600,000) as plaintext `b16` literals at ledger field
  2, so the burned amount (400,000) is derivable as old − new. The `disclose`'d
  coin operations themselves emit only `b32` commitments and nullifiers (hashes)
  and carry no plaintext amount.

So mint always leaks the amount, but burn leaks it *only* because of the
`_totalSupply` write. An amount-private burn just has to avoid writing the amount
to public state: drop the counter, or burn off-contract.

## Experiment: what actually makes the burn amount public?

The original claim conflated two separate things: *"`disclose` is required on the
coin ops"* and *"the amount is therefore public."* Two experiments pull them apart.

### 1. `disclose` is required regardless of the supply counter

The `disclose` on the burn is **not** there for the supply counter; it is forced
by the shielded coin operations themselves. Reproduce with a tiny standalone
probe, [`contracts/experiments/disclose-probe.compact`](./contracts/experiments/disclose-probe.compact),
which calls each coin spend/receive primitive on a witness value (a circuit
parameter) WITHOUT `disclose`, using the normal compact command:

```bash
pnpm compile:disclose-probe
# = compact compile +0.31.0 --skip-zk contracts/experiments/disclose-probe.compact build/disclose-probe
```

The compiler **rejects** it (`exit 255`). All three coin spend/receive
primitives fail the same way — `receiveShielded`, `sendImmediateShielded`, and
`sendShielded`:

```
Exception: disclose-probe.compact line 19 char 3:
  potential witness-value disclosure must be declared but is not:
    witness value potentially disclosed:
      the value of parameter coin of exported circuit probeReceive
    nature of the disclosure:
      the call to standard-library circuit receiveShielded might disclose a link between a
      coin receive and the coin with the commitment given by a hash of the witness value

Exception: disclose-probe.compact line 27 char 3:
    witness value: parameter coin of circuit probeSendImmediate
    nature of the disclosure:
      the call to standard-library circuit sendImmediateShielded might disclose a link between
      a claim of nullifier and the coin with the nullifier given by a hash of the witness value

Exception: disclose-probe.compact line 35 char 3:
    witness value: parameter coin of circuit probeSendShielded
    nature of the disclosure:
      the call to standard-library circuit sendShielded might disclose a link between a claim
      of nullifier and the coin with the nullifier given by a hash of the witness value
```

The same holds inside the real `ShieldedERC20.burn`: removing `_totalSupply` *and
then also* dropping `disclose` from the coin ops fails to compile with 53 such
disclosure errors. That proves the `disclose` requirement is independent of the
counter. It does **not** prove the amount is public: a required `disclose` only
means the value *could* reach a sink, never that it does.

### 2. The leak is the `_totalSupply` write, not the coin ops

[`NoSupplyToken`](./contracts/experiments/NoSupplyToken.compact) is
`ShieldedERC20.burn` with exactly one change: the `_totalSupply` field, its
`totalSupply()` circuit, and the `_totalSupply = _totalSupply - disclose(amount)`
write are removed. Every coin operation and **every `disclose` wrapper is kept
byte-for-byte**, and it still compiles. Run the same scenario (mint 1,000,000 →
burn 400,000) against both and decode the burn tx from its raw bytes:

| burn tx | plaintext (`b16`) amount literals | `bytesWritten` |
|---|---|---|
| `ShieldedERC20` (`out/3-burn.decode.txt`) | `40420f` = 1,000,000 and `c02709` = 600,000, both at the `_totalSupply` cell (ledger field 2) | 663 |
| `NoSupplyToken` (`out/ns-3-burn.decode.txt`) | **none** — every op is a `b32` commitment / nullifier | 0 |

```bash
pnpm reproduce                       # baseline ShieldedERC20 burn -> out/3-burn.decode.txt
pnpm compile:no-supply               # build the counter-free contract (full ZK)
bash scripts/run-no-supply-burn.sh   # NoSupplyToken burn -> out/ns-3-burn.decode.txt
grep -oE '40420f|c02709' out/3-burn.decode.txt      # ShieldedERC20: both present (at _totalSupply)
grep -oE '40420f|c02709' out/ns-3-burn.decode.txt   # NoSupplyToken: nothing
```

Same coin ops, same `disclose` wrappers, same amounts. The **only** difference is
the `_totalSupply` write, and it is the **only** thing that put a plaintext amount
in the public transcript. The `600000` literal in the baseline burn is the *new
`_totalSupply` value* (1,000,000 − 400,000), not the change-send coin: the
change-send produces a commitment, like every other coin op. Full byte-level
write-up in [`DISCLOSE-CLAIM-REVIEW.md`](./DISCLOSE-CLAIM-REVIEW.md).

**So there are two ways to hide a burnt amount:**

1. **Inside a contract**, by not writing the amount to public state — e.g. drop
   the `_totalSupply` cell, as `NoSupplyToken` does. The burn still runs in the
   contract; it just can no longer keep a public supply counter.
2. **Outside the contract**, with a plain wallet → burn-address Zswap transfer,
   where the value lives only inside a Pedersen commitment. `src/hidden-burn.ts`
   runs exactly that; see [`out/HIDDEN-BURN-VIEW.md`](./out/HIDDEN-BURN-VIEW.md).

Both hide the amount, and both give up the contract's ability to publicly count
the burn.

## How it works

| File | Role |
|---|---|
| `src/reproduce.ts` | Orchestrator: start local stack → wallet → deploy → mint → burn → decode → report |
| `src/hidden-burn.ts` | Variant orchestrator: mint via the contract, then burn by a direct wallet → burn-address transfer (amount stays hidden). Decodes to `out/HIDDEN-BURN-VIEW.md` |
| `src/verify-supply.ts` | Supply-audit orchestrator: deploy → mint → contract burn → hidden burn → protocol burn; per-step PASS/FAIL matrix to `out/SUPPLY-AUDIT.md` |
| `src/supply.ts` | Pure delta-fold: `deltaForType`, `shieldedMintsForType`, `foldSupply` over decoded txs (also a CLI for offline folding of captured `.hex`) |
| `scripts/run-hidden-burn.sh` | Brings the `compose.yml` stack up with plain `docker compose`, injects ports, runs `hidden-burn` (avoids testkit's flaky log-wait) |
| `scripts/run-verify-supply.sh` | Same self-managed-stack wrapper, for `verify-supply` |
| `src/wallet-provider.ts` | `WalletProvider`/`MidnightProvider` (balance + submit); captures each submitted tx's raw bytes |
| `src/providers.ts` | Assembles the midnight-js providers (indexer, proof, zk-config, private-state) |
| `src/contract.ts` | Deploy / join / mint / burn + `totalSupply()` read against the vendored contract |
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
| `BURN_AMOUNT` | `400000` | amount to (contract-)burn (must be ≤ mint) |
| `HIDDEN_BURN_AMOUNT` | `200000` | `verify-supply` only: hidden-burn amount (must satisfy `B + H ≤ M`) |
| `SOFT_ASSERT` | `1` | `verify-supply` only: collect FAILs into the report (`0` = exit non-zero on a measured-cell miss) |
| `DEBUG_LEVEL` | `info` | pino log level (`debug` for sync detail) |

```bash
MINT_AMOUNT=5000 BURN_AMOUNT=5000 pnpm reproduce              # full burn, no change
MINT_AMOUNT=900 BURN_AMOUNT=300 HIDDEN_BURN_AMOUNT=300 \
  bash scripts/run-verify-supply.sh                           # protocol burn P = 300
```

## Rebuilding the contract from source (optional)

The vendored `artifacts/` were produced by compiling `contracts/*.compact` with
the Compact compiler. You do **not** need this to run the reproducer. To rebuild
them you need the Compact toolchain (`compact`) matching `compact-runtime`
`0.16.0`. The import closure is:

```
ShieldedFungibleToken.compact → ShieldedERC20.compact → Utils.compact
```

The sources are stored flat, but their imports assume a structured layout
(`shielded-token/` + `openzeppelin/`), so `pnpm compile` stages them into that
layout and runs the normal compact command:

```bash
pnpm compile               # full build (TS + zkir + proving keys) -> build/ShieldedFungibleToken
pnpm compile -- --skip-zk  # fast: TS + zkir only, no proving keys
```

To use a rebuild at runtime, point `ZK_CONFIG_PATH` (in `src/reproduce.ts` /
`src/hidden-burn.ts`) at `build/ShieldedFungibleToken`, or copy it over
`artifacts/shielded-token/ShieldedFungibleToken`.

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
