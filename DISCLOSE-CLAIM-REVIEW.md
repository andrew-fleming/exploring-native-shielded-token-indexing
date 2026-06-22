# What actually leaks the burned amount — an evidence-based review

This document checks the README's claims against (a) the official Midnight
disclosure spec, (b) the Compact compiler's own messages, and (c) the **raw
decoded bytes** of real transactions from two live local-stack runs. Every
verdict cites where the evidence comes from. Where the README is right, it says
so; where it is wrong, it shows the bytes.

## The question

Does a **contract-mediated** burn of a shielded token reveal the burned amount
to a public indexer, and if so, *why*? The README's thesis:

> A contract-mediated burn **always** reveals the amount … the Compact compiler
> *forces* `disclose` on the coin ops … **Total-supply accounting is irrelevant
> to it.** ([README.md](./README.md), TL;DR + "Experiment")

The competing hypothesis: the author conflated *"the compiler requires a
`disclose()` wrapper on the coin operations"* with *"the amount is therefore
public"* — and the real leak is the public `_totalSupply` ledger counter, not
the coin operations.

## What `disclose` means (official spec)

> "Placing a `disclose()` wrapper **does not cause disclosure in itself**; in
> fact, it has no effect other than telling the compiler that it is okay to
> disclose the value of the wrapped expression."

Disclosure happens only at a **sink**: *storing in the public ledger, returning
from an exported circuit, or passing to another contract.* So "a `disclose()`
is required here" and "this value is public" are **different statements**. A
required `disclose()` only means a witness value *could* reach a sink along some
path; whether a plaintext value actually lands in the public view is a separate,
checkable fact.

## The experiment

Two runs on a local v8 stack, identical scenario (mint 1,000,000 → burn
400,000, change 600,000), decoding each tx from its **raw on-wire bytes**:

| Run | Contract | Burn `_totalSupply` write? | Coin ops + `disclose`? |
|---|---|---|---|
| A | author's `ShieldedERC20` (unmodified) | **yes** | yes |
| B | `NoSupplyToken` (this review) | **no** (counter removed) | **yes — identical** |

`NoSupplyToken` ([contracts/experiments/NoSupplyToken.compact](./contracts/experiments/NoSupplyToken.compact))
is `ShieldedERC20.burn` with exactly one change: the line
`_totalSupply = _totalSupply - disclose(amount)` (and the `_totalSupply` field /
`totalSupply()` circuit) removed. The coin operations
(`receiveShielded(disclose(coin))`, `sendImmediateShielded(disclose(coin), …,
disclose(amount))`, and the change-send) and **all their `disclose` wrappers are
kept byte-for-byte**. It compiles — first proof that the `disclose` requirement
is independent of the counter.

Amounts as little-endian field literals (how the VM encodes `Uint`):
`1,000,000 = 0x0F4240 = 40420f`, `600,000 = 0x0927C0 = c02709`,
`400,000 = 0x061A80 = 801a06`.

## The decisive bytes

**Run A — author's burn** ([out/3-burn.decode.txt](./out/3-burn.decode.txt), guaranteed transcript `program`):

```
… idx [<[02]: b1>], popeq <[40420f]: b16>, push <[02]: b1>, pushs <[c02709]: b16>, ins 1 …
gas: { … bytesWritten: 663, bytesDeleted: 663 }
```

- `idx [<[02]>]` = read **ledger field 2**. The compiler's own metadata
  (`contract-info.json`) lists `{"name": "_totalSupply", "index": 2, …, "storage":
  "Cell", "type": {"type-name": "Uint", …}}` — so **field 2 is `_totalSupply`**
  (verified, not inferred from declaration order).
- `popeq <[40420f]>` asserts the old `_totalSupply` = **1,000,000**.
- `pushs <[c02709]>, ins` writes the new `_totalSupply` = **600,000**.
- `bytesWritten: 663` — a public ledger cell was written.

So both numbers are plaintext in the transcript — **and they are the counter's
old and new values**, emitted by `_totalSupply = _totalSupply - amount`
(1,000,000 − 400,000 = 600,000). The burned amount (400,000 = `801a06`) does not
appear directly; it is derivable as old − new.

**Run B — counter-free burn** ([out/ns-3-burn.decode.txt](./out/ns-3-burn.decode.txt), guaranteed transcript `program`):

```
… idx [<[03]: b1>], popeq <[2cc41fa8…]: b32>, … (every other push/insert is a b32 commitment or nullifier) …
gas: { … bytesWritten: 0, bytesDeleted: 0 }
```

- The only field read is `idx [<[03]>]` = `_color` (NoSupplyToken order:
  `_counter(0), _nonce(1), _domain(2), _color(3)`), and `popeq <[2cc41fa8…]:
  b32>` is the `assert(coin.color == _color)` check — a 32-byte hash.
- **No `b16` numeric literal appears anywhere.** Every other op pushes/inserts a
  `b32` commitment or nullifier — the outputs of the coin operations.
- `bytesWritten: 0` — no ledger value is written at all.

Grep, both files:

| literal | = | Run A (author) | Run B (counter-free) |
|---|---|---|---|
| `40420f` | 1,000,000 (coin value / old supply) | **1** | **0** |
| `c02709` | 600,000 (change / new supply) | **1** | **0** |
| `801a06` | 400,000 (burn amount) | 0 (derivable) | 0 |

Same coin operations, same `disclose` wrappers, same minted/burned values. The
**only** difference is the `_totalSupply` write — and it is the **only** thing
that put a plaintext amount in the public transcript. Remove it and the
contract-mediated burn reveals nothing but commitments and nullifiers (hashes).

## Point-by-point verdicts

**1. "`disclose` required ⇒ value is public."**
**FALSE** — [spec]. `disclose` is a permission marker, not a disclosure. The
counter-free burn keeps every `disclose` the compiler demands on the coin ops,
yet leaks no amount.

**2. "Spending/receiving a shielded coin … writes its value into the public VM
transcript" ([README.md:32-34](./README.md#L32-L34)).**
**FALSE for the value** — [bytes, Run B]. The coin ops emit only `b32`
commitments/nullifiers. In Run B they run identically and no value appears. The
compiler's own probe message agrees: it discloses *"a link … with the commitment
given by a **hash** of the witness value"* ([README.md:206-208](./README.md#L206-L208)) — a hash, not the value.

**3. "Contract burn: amount visible, `disclose`'d into the public VM transcript"
([README.md:26](./README.md#L26), [README.md:176](./README.md#L176)).**
**Right that it's visible, wrong about the mechanism** — [bytes]. The amount is
visible in Run A, but via the `_totalSupply` ledger read/write (`idx [02]`,
`bytesWritten: 663`), not the coin ops.

**4. "the change-send carries no `disclose` yet `600000` still shows up as a
literal" ([README.md:233-234](./README.md#L233-L234)).**
**Misattribution** — [bytes]. The `600000` (`c02709`) literal is the **new
`_totalSupply` value** written by `_totalSupply = _totalSupply - amount`, sitting
at `idx [02]`. It is not the change coin. The change-send produces a `b32`
commitment (e.g. `ce7a93be…` in Run B), which carries no amount.

**5. "Removing `_totalSupply` … fails to compile with 53 disclosure errors" ⇒
"Total-supply accounting is irrelevant" ([README.md:223-236](./README.md#L223-L236)).**
**The fact is true; the conclusion is FALSE** — [bytes, Run B]. Dropping
`disclose` from the coin ops does fail to compile (the probe confirms it). But
that proves only that `disclose` is *required* — it does not make the amount
public. Run B keeps the `disclose` wrappers, removes only `_totalSupply`, and the
amount is gone. Total-supply accounting is **the entire leak**, not irrelevant
to it.

**6. "mint publishes the amount in `shieldedMints`" ([README.md:175](./README.md#L175)).**
**CORRECT** — [bytes]. Both mints show `shieldedMints: {…:"1000000"}`. This is a
genuine, separate protocol-level disclosure (from `mintShieldedToken`), present
even in the counter-free contract. Mint leaks the amount regardless of the
counter; burn does not.

**7. Hidden burn / protocol burn behavior.**
**CORRECT** — [committed [SUPPLY-AUDIT.md](./out/SUPPLY-AUDIT.md)]. Unaffected by
the above.

## Conclusion

A contract-mediated burn does **not** inherently reveal the burned amount. In
`ShieldedERC20` it does, but **only because `burn` writes the amount-derived
value into the public `_totalSupply` ledger cell** — exactly the accounting the
README calls "irrelevant." The shielded coin operations expose commitments and
nullifiers (hashes), never the plaintext value, and the required `disclose`
wrappers are about declaring the witness→commitment link, not about making the
amount public. A contract burn that omits the public counter (or writes it
through a commitment) hides the amount while still running inside the contract —
contradicting the README's headline.

### Reproduce

```bash
# Run A (author's contract): out/3-burn.decode.txt
bash scripts/run-verify-supply.sh

# Run B (counter-free): out/ns-3-burn.decode.txt
pnpm compile:no-supply        # compact compile of contracts/experiments/NoSupplyToken.compact
bash scripts/run-no-supply-burn.sh

# Then, in each burn decode, the amounts are little-endian hex:
#   1,000,000=40420f  600,000=c02709  400,000=801a06
grep -oE '40420f|c02709|801a06' out/3-burn.decode.txt      # author: 40420f, c02709 present (at _totalSupply idx[02])
grep -oE '40420f|c02709|801a06' out/ns-3-burn.decode.txt   # counter-free: none
```

> Note on method: an earlier reading guessed the literals came from the coin
> operations. The counter-free control run disproved that — the literals track
> the `_totalSupply` write, and vanish when it is removed. The bytes settled it.
