// Decode a raw Midnight transaction (hex) with ledger-v8 into the
// publicly-observable / indexer-visible content.
//
// As a library:  import { decodeTx, formatDecode } from "./decode.js"
// As a CLI:       tsx src/decode.ts <path-to-hexfile>  (or: npm run decode -- <file>)
//
// A transaction's serialized bytes are exactly what the node accepts and the
// indexer ingests, so everything decoded here is public. What it CANNOT show
// (coin owners, values sealed in commitments) stays private.
import { readFileSync } from "node:fs";
import { Transaction } from "@midnight-ntwrk/ledger-v8";

export interface DecodedTranscript {
	gas: unknown;
	programOps: number;
	effects: {
		shieldedMints: Record<string, string | number>;
		unshieldedMints: Record<string, string | number>;
		claimedShieldedSpends: string[];
		claimedShieldedReceives: string[];
		claimedNullifiers: string[];
		claimedContractCalls: number;
	};
}

export interface DecodedAction {
	kind: "ContractCall" | "ContractDeploy";
	address: string;
	entryPoint?: string;
	communicationCommitment?: string;
	guaranteedTranscript?: DecodedTranscript;
	fallibleTranscript?: DecodedTranscript;
}

export interface DecodedOffer {
	inputs: { nullifier: string }[];
	outputs: { commitment: string }[];
	transients: number;
	deltas: { type: string; delta: string }[];
}

export interface DecodedTx {
	byteLength: number;
	transactionHash: string;
	identifiers: string[];
	intents: { segment: number; actions: DecodedAction[] }[];
	guaranteedOffer?: DecodedOffer;
	fallibleOffers: { segment: number; offer?: DecodedOffer }[];
	toStringCompact?: string;
}

export const hx = (v: unknown): string => {
	try {
		if (v === null || v === undefined) return String(v);
		if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
		return String(v);
	} catch {
		return "<unprintable>";
	}
};

const mapToObj = (m: unknown): Record<string, string | number> => {
	const out: Record<string, string | number> = {};
	try {
		if (!m) return out;
		const entries =
			m instanceof Map ? Array.from(m.entries()) : Object.entries(m as object);
		for (const [k, v] of entries) {
			out[hx(k)] = typeof v === "bigint" ? v.toString() : (v as string | number);
		}
	} catch {}
	return out;
};

const arrToHex = (a: unknown): string[] => {
	try {
		return (a as unknown[] | undefined ?? []).map(hx);
	} catch {
		return [];
	}
};

const safeGas = (gas: unknown): unknown => {
	try {
		return JSON.parse(
			JSON.stringify(gas, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
		);
	} catch {
		return undefined;
	}
};

const readTranscript = (t: any): DecodedTranscript | undefined => {
	if (!t) return undefined;
	const e = t.effects ?? {};
	return {
		gas: safeGas(t.gas),
		programOps: (t.program ?? []).length,
		effects: {
			shieldedMints: mapToObj(e.shieldedMints),
			unshieldedMints: mapToObj(e.unshieldedMints),
			claimedShieldedSpends: arrToHex(e.claimedShieldedSpends),
			claimedShieldedReceives: arrToHex(e.claimedShieldedReceives),
			claimedNullifiers: arrToHex(e.claimedNullifiers),
			claimedContractCalls: (e.claimedContractCalls ?? []).length,
		},
	};
};

const readOffer = (offer: any): DecodedOffer | undefined => {
	if (!offer) return undefined;
	const deltas = offer.deltas
		? Array.from(offer.deltas.entries() as Iterable<[unknown, unknown]>).map(
				([t, v]) => ({
					type: hx(t),
					delta: typeof v === "bigint" ? (v as bigint).toString() : String(v),
				}),
			)
		: [];
	return {
		inputs: (offer.inputs ?? []).map((i: any) => ({ nullifier: hx(i.nullifier) })),
		outputs: (offer.outputs ?? []).map((o: any) => ({ commitment: hx(o.commitment) })),
		transients: (offer.transients ?? []).length,
		deltas,
	};
};

/** Deserialize raw tx bytes (Uint8Array or hex string) into a structured, public view. */
export const decodeTx = (bytesOrHex: Uint8Array | string): DecodedTx => {
	const bytes =
		typeof bytesOrHex === "string"
			? Uint8Array.from(Buffer.from(bytesOrHex.trim(), "hex"))
			: bytesOrHex;
	// FinalizedTransaction = Transaction<SignatureEnabled, Proof, Binding>
	const tx = Transaction.deserialize("signature", "proof", "binding", bytes) as any;

	const intents: DecodedTx["intents"] = [];
	try {
		if (tx.intents) {
			for (const [seg, intent] of tx.intents as Iterable<[unknown, any]>) {
				const actions: DecodedAction[] = (intent.actions ?? []).map((a: any) => {
					const ep = a.entryPoint;
					if (ep !== undefined) {
						return {
							kind: "ContractCall",
							address: hx(a.address),
							entryPoint: typeof ep === "string" ? ep : hx(ep),
							communicationCommitment: hx(a.communicationCommitment),
							guaranteedTranscript: readTranscript(a.guaranteedTranscript),
							fallibleTranscript: readTranscript(a.fallibleTranscript),
						};
					}
					return { kind: "ContractDeploy", address: hx(a.address) };
				});
				intents.push({ segment: Number(seg), actions });
			}
		}
	} catch {}

	const fallibleOffers: DecodedTx["fallibleOffers"] = [];
	try {
		if (tx.fallibleOffer) {
			for (const [seg, offer] of tx.fallibleOffer as Iterable<[unknown, any]>) {
				fallibleOffers.push({ segment: Number(seg), offer: readOffer(offer) });
			}
		}
	} catch {}

	let toStringCompact: string | undefined;
	try {
		toStringCompact = tx.toString(true);
	} catch {}

	return {
		byteLength: bytes.length,
		transactionHash: hx(tx.transactionHash()),
		identifiers: arrToHex(tx.identifiers()),
		intents,
		guaranteedOffer: readOffer(tx.guaranteedOffer),
		fallibleOffers,
		toStringCompact,
	};
};

/** Render a decoded tx as a human-readable text block. */
export const formatDecode = (d: DecodedTx): string => {
	const L: string[] = [];
	L.push(`=== DECODED FROM RAW BYTES (${d.byteLength} bytes) ===`);
	L.push(`transactionHash : ${d.transactionHash}`);
	L.push(`identifiers     : ${d.identifiers.join(", ")}`);
	for (const it of d.intents) {
		L.push("");
		L.push(`-- intent segment ${it.segment}: ${it.actions.length} action(s) --`);
		it.actions.forEach((a, i) => {
			if (a.kind === "ContractCall") {
				L.push(`  action[${i}] ContractCall`);
				L.push(`    address    : ${a.address}`);
				L.push(`    entryPoint : ${a.entryPoint}`);
				L.push(`    communicationCommitment : ${a.communicationCommitment}`);
				const gt = a.guaranteedTranscript;
				if (gt) {
					L.push(`    guaranteedTranscript.gas : ${JSON.stringify(gt.gas)}`);
					L.push(`    guaranteedTranscript.effects.shieldedMints           : ${JSON.stringify(gt.effects.shieldedMints)}`);
					L.push(`    guaranteedTranscript.effects.claimedShieldedSpends   : [${gt.effects.claimedShieldedSpends.join(", ")}]`);
					L.push(`    guaranteedTranscript.effects.claimedShieldedReceives : [${gt.effects.claimedShieldedReceives.join(", ")}]`);
					L.push(`    guaranteedTranscript.effects.claimedNullifiers       : [${gt.effects.claimedNullifiers.join(", ")}]`);
					L.push(`    guaranteedTranscript.program ops count               : ${gt.programOps}`);
				}
			} else {
				L.push(`  action[${i}] ${a.kind} address=${a.address}`);
			}
		});
	}
	const off = d.guaranteedOffer;
	if (off) {
		L.push("");
		L.push(`-- guaranteed Zswap offer: inputs=${off.inputs.length} outputs=${off.outputs.length} transients=${off.transients} --`);
		L.push(`  deltas: ${off.deltas.map((x) => `${x.type}=${x.delta}`).join(", ")}`);
		off.inputs.forEach((i, n) => L.push(`  input[${n}]  nullifier=${i.nullifier}`));
		off.outputs.forEach((o, n) => L.push(`  output[${n}] commitment=${o.commitment}`));
	}
	if (d.toStringCompact) {
		L.push("");
		L.push("=== LEDGER toString(compact) ===");
		L.push(d.toStringCompact);
	}
	return L.join("\n");
};

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
	// Ignore a stray "--" (npm/pnpm forward it when invoked as `run decode -- <file>`).
	const path = process.argv.slice(2).find((a) => a !== "--");
	if (!path) {
		console.error("usage: tsx src/decode.ts <path-to-hexfile>");
		process.exit(1);
	}
	const hex = readFileSync(path, "utf8").trim();
	console.log(formatDecode(decodeTx(hex)));
}
