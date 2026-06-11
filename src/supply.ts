// Pure delta-fold supply accounting over decoded transactions.
//
// The outstanding supply of a shielded token `tt`, as a public indexer can
// recompute it from the chain, is:
//
//     supply(tt) = -Σ deltas[tt]   over every zswap offer since genesis
//
// Each mint adds a coin (negative delta), each spend-without-a-matching-output
// (a "protocol burn", a positive-imbalance offer) removes value (positive
// delta). A coin sent to the burn address stays *in* the pool as a dead coin,
// so the offer nets to zero delta. That is why this fold does NOT observe
// contract burns or hidden (zero-coin-key) burns: the value never leaves the
// commitment set. This module exists to demonstrate that auditability gap
// empirically, alongside the contract's own `totalSupply()` counter.
//
// `shieldedMints` is a separate, public per-tx effect. Note its token type is
// `rawTokenType(domain, contractAddress)`, which is DISTINCT from the coin
// color used in zswap deltas — so the mint cross-check keys on a different
// value than the fold.
import type { DecodedTx } from "./decode.js";

const toBig = (s: string | number): bigint => {
	try {
		return BigInt(s);
	} catch {
		return 0n;
	}
};

/** Every zswap offer in a tx: the guaranteed offer plus each fallible-segment offer. */
const offersOf = (tx: DecodedTx) =>
	[tx.guaranteedOffer, ...tx.fallibleOffers.map((f) => f.offer)].filter(
		(o): o is NonNullable<typeof o> => o != null,
	);

/** Net zswap delta for `tokenTypeHex` (the coin color) across all offers in the tx. */
export const deltaForType = (tx: DecodedTx, tokenTypeHex: string): bigint =>
	offersOf(tx).reduce(
		(sum, offer) =>
			sum +
			offer.deltas
				.filter((d) => d.type === tokenTypeHex)
				.reduce((s, d) => s + toBig(d.delta), 0n),
		0n,
	);

/**
 * Sum of `shieldedMints` across every ContractCall transcript (guaranteed +
 * fallible) in the tx. Pass `mintTypeHex` to filter to one minted type; omit it
 * to sum across ALL minted types (safe when a run mints a single token type).
 *
 * The minted type is `rawTokenType(domain, contractAddress)`, which differs
 * from the coin color used by {@link deltaForType}.
 */
export const shieldedMintsForType = (tx: DecodedTx, mintTypeHex?: string): bigint => {
	let total = 0n;
	for (const intent of tx.intents) {
		for (const action of intent.actions) {
			if (action.kind !== "ContractCall") continue;
			for (const transcript of [action.guaranteedTranscript, action.fallibleTranscript]) {
				const mints = transcript?.effects.shieldedMints;
				if (!mints) continue;
				for (const [type, value] of Object.entries(mints)) {
					if (mintTypeHex === undefined || type === mintTypeHex) total += toBig(value);
				}
			}
		}
	}
	return total;
};

export interface OrderedTx {
	index: number;
	kind: string;
	tx: DecodedTx;
}

export interface SupplyFoldRow {
	index: number;
	kind: string;
	/** Net zswap delta[tt] contributed by this tx. */
	delta: bigint;
	/** shieldedMints[mintType] contributed by this tx. */
	mints: bigint;
	/** Running fold supply (-Σ delta) after this tx. */
	runningSupply: bigint;
	/** Running total minted (Σ shieldedMints) after this tx. */
	runningMints: bigint;
}

export interface SupplyFold {
	tokenTypeHex: string;
	mintTypeHex?: string;
	rows: SupplyFoldRow[];
	/** Final -Σ delta over all txs. */
	supply: bigint;
	/** Final Σ shieldedMints over all txs. */
	totalMinted: bigint;
}

/**
 * Fold running supply (`-Σ delta`) and total minted (`Σ shieldedMints`) over an
 * ordered list of decoded txs. `tokenTypeHex` is the coin color for the delta
 * fold; `mintTypeHex` (optional) filters the mint cross-check.
 */
export const foldSupply = (
	txs: OrderedTx[],
	tokenTypeHex: string,
	mintTypeHex?: string,
): SupplyFold => {
	let runningSupply = 0n;
	let runningMints = 0n;
	const rows: SupplyFoldRow[] = [];
	for (const { index, kind, tx } of txs) {
		const delta = deltaForType(tx, tokenTypeHex);
		const mints = shieldedMintsForType(tx, mintTypeHex);
		runningSupply -= delta;
		runningMints += mints;
		rows.push({ index, kind, delta, mints, runningSupply, runningMints });
	}
	return {
		tokenTypeHex,
		mintTypeHex,
		rows,
		supply: runningSupply,
		totalMinted: runningMints,
	};
};

// CLI / offline smoke test: fold over a set of captured .hex fixtures.
//   tsx src/supply.ts <tokenColorHex> <tx1.hex> <tx2.hex> ...
// Decodes each file, runs the fold, and prints the per-tx table. Useful to
// exercise the pure logic against `out/*.hex` without a live stack.
if (import.meta.url === `file://${process.argv[1]}`) {
	const { readFileSync } = await import("node:fs");
	const { basename } = await import("node:path");
	const { decodeTx } = await import("./decode.js");
	const args = process.argv.slice(2).filter((a) => a !== "--");
	const tokenTypeHex = args[0];
	const files = args.slice(1);
	if (!tokenTypeHex || files.length === 0) {
		console.error("usage: tsx src/supply.ts <tokenColorHex> <tx1.hex> [tx2.hex ...]");
		process.exit(1);
	}
	const ordered: OrderedTx[] = files.map((f, i) => ({
		index: i + 1,
		kind: basename(f).replace(/\.hex$/, ""),
		tx: decodeTx(readFileSync(f, "utf8").trim()),
	}));
	const fold = foldSupply(ordered, tokenTypeHex);
	console.log(`token color : ${tokenTypeHex}`);
	console.log(`fold supply : ${fold.supply}`);
	console.log(`total minted: ${fold.totalMinted}`);
	console.log("");
	console.log("idx  kind            delta            mints       runningSupply");
	for (const r of fold.rows) {
		console.log(
			`${String(r.index).padEnd(4)} ${r.kind.padEnd(15)} ${String(r.delta).padStart(12)} ${String(r.mints).padStart(11)} ${String(r.runningSupply).padStart(15)}`,
		);
	}
}
