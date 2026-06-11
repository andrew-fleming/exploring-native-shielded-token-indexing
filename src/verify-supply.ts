// Verify shielded-token supply auditability on a local v8 stack.
//
// One stack run executes a five-step scenario against a single deployed
// ShieldedFungibleToken and, after each step, compares three independently
// derived numbers for the token:
//
//   1. contract  `totalSupply()`     — the contract's own counter (a ledger cell)
//   2. fold       `-Σ deltas[tt]`    — what a public indexer recomputes from
//                                       zswap deltas across every captured tx
//   3. true circulating              — what we know is actually spendable, by
//                                       construction of the scenario
//
// The scenario: deploy -> mint M -> contract burn B -> hidden burn H ->
// protocol burn P (P = the full remaining coin value, M-B-H).
//
//   - contract burn  : the `burn` circuit sends the coin to the burn address
//                      and `disclose`s the amount. `totalSupply` drops by B, but
//                      the coin stays in the pool (net delta 0) so the fold does
//                      NOT drop.
//   - hidden burn    : a direct wallet transfer to the zero coin key, no
//                      contract call. Neither `totalSupply` nor the fold move,
//                      yet H tokens are now truly unspendable.
//   - protocol burn  : a hand-built one-input / zero-output zswap offer (a
//                      positive imbalance). This is the novel claim: such a tx
//                      is valid, the surplus is destroyed, and the burned amount
//                      is plaintext in `deltas[tt] = +P`, so the fold DOES drop.
//
// The point: after the dead-coin burns, all three counters diverge — exactly
// the accounting gap the archived ShieldedERC20 warns about. Output is
// `out/SUPPLY-AUDIT.md` with a PASS/FAIL matrix and the per-tx fold table.
//
// Run from the package root:  pnpm verify-supply  (i.e. tsx src/verify-supply.ts)
// Env: MINT_AMOUNT, BURN_AMOUNT, HIDDEN_BURN_AMOUNT, SOFT_ASSERT (default soft;
// set SOFT_ASSERT=0 to exit non-zero on a measured-cell failure), DEBUG_LEVEL.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	rawTokenType,
	Transaction,
	unshieldedToken,
	ZswapOffer,
} from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { ttlOneHour } from "@midnight-ntwrk/midnight-js-utils";
import { getTestEnvironment, LocalTestConfiguration } from "@midnight-ntwrk/testkit-js";
import {
	ShieldedAddress,
	ShieldedCoinPublicKey,
	type WalletFacade,
} from "@midnight-ntwrk/wallet-sdk";
import { pino } from "pino";
import * as Rx from "rxjs";
import { WebSocket } from "ws";
// Generated ledger view: used only to read the sealed `_domain` for the
// rawTokenType cross-check. It exposes nonce/domain (NOT totalSupply).
import { ledger } from "../artifacts/shielded-token/ShieldedFungibleToken/contract/index.js";
import { ShieldedFungibleToken } from "./contract.js";
import { type DecodedTx, decodeTx, formatDecode } from "./decode.js";
import { configureProviders, type Providers } from "./providers.js";
import { deltaForType, foldSupply, type OrderedTx } from "./supply.js";
import { MidnightWalletProvider } from "./wallet-provider.js";
import { waitForShieldedToken, waitForUnshieldedFunds } from "./wallet-utils.js";

// Apollo (indexer subscriptions) needs a global WebSocket.
(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const ZK_CONFIG_PATH = resolve(PKG_ROOT, "artifacts", "shielded-token", "ShieldedFungibleToken");
const OUT_DIR = resolve(PKG_ROOT, "out");

const GENESIS_SEED = "0000000000000000000000000000000000000000000000000000000000000001";
const TOKEN_NAME = process.env.TOKEN_NAME ?? "OZ Test Token";
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL ?? "OZT";
const MINT_AMOUNT = BigInt(process.env.MINT_AMOUNT ?? "1000000");
const BURN_AMOUNT = BigInt(process.env.BURN_AMOUNT ?? "400000");
const HIDDEN_BURN_AMOUNT = BigInt(process.env.HIDDEN_BURN_AMOUNT ?? "200000");
// Soft by default: collect FAILs into the report rather than aborting the run.
const SOFT_ASSERT = process.env.SOFT_ASSERT !== "0";
const SYNC_TIMEOUT_MS = 180_000;

const BURN_COIN_PUBLIC_KEY_HEX = "00".repeat(32);

const logger = pino({
	level: process.env.DEBUG_LEVEL ?? "info",
	transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
});

const hexOf = (u8: Uint8Array): string => Buffer.from(u8).toString("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Render a ledger TokenType map key (object / Uint8Array / string) as a string. */
const tokenKeyStr = (k: unknown): string => {
	if (k instanceof Uint8Array) return Buffer.from(k).toString("hex");
	if (k && typeof k === "object") {
		const raw = (k as { raw?: unknown }).raw;
		if (typeof raw === "string") return raw;
		try {
			return JSON.stringify(k);
		} catch {
			return String(k);
		}
	}
	return String(k);
};

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

/** Decode all captured txs (in submission order) into the fold's input shape. */
const decodeCaptured = (wp: MidnightWalletProvider): OrderedTx[] =>
	wp.submittedTxs.map((t) => ({ index: t.index, kind: t.kind, tx: decodeTx(t.hex) }));

interface SpendableView {
	availableCoins: readonly { coin: { type: string; value: bigint } }[];
}

/** Values of the SPENDABLE coins of `colorHex` (available, owned, unspent). */
const spendableCoinValues = (sh: SpendableView, colorHex: string): bigint[] =>
	sh.availableCoins.filter((c) => c.coin.type === colorHex).map((c) => c.coin.value);

/**
 * Wait until a spendable coin of EXACTLY `changeValue` exists for `colorHex` —
 * the signal that the change from the previous spend has synced and is ready to
 * spend again.
 *
 * Why match a single coin's value, not the total spendable balance: a hidden
 * burn reuses our encryption key for the burn output, so the wallet detects
 * that coin and lists it among `availableCoins` even though its zero coin key
 * makes it unspendable in practice. That inflates the spendable *sum*, so we
 * key on the change coin's exact value instead, which is unaffected.
 *
 * Polls `shielded.state` snapshots and logs the observed coin values so a
 * mismatch is visible in the report log.
 */
const waitForChangeCoin = async (
	wallet: WalletFacade,
	colorHex: string,
	changeValue: bigint,
	timeoutMs = SYNC_TIMEOUT_MS,
): Promise<void> => {
	logger.info(`Waiting for a spendable ${colorHex} coin == ${changeValue}...`);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const sh = (await Rx.firstValueFrom(wallet.shielded.state)) as unknown as SpendableView;
		const values = spendableCoinValues(sh, colorHex);
		logger.debug(`spendable ${colorHex} coins: [${values.join(", ")}] (want ${changeValue})`);
		if (values.includes(changeValue)) {
			logger.info(`Change coin ready: ${colorHex} has a ${changeValue} coin.`);
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`Timeout waiting for a spendable ${colorHex} coin == ${changeValue}; saw [${values.join(", ")}]`,
			);
		}
		await sleep(3_000);
	}
};

/**
 * Read the contract counter, polling until it reaches `expected` (or a short
 * timeout) to absorb indexer lag. Returns the last value read either way, so a
 * genuine mismatch still surfaces in the report.
 */
const readTotalSupplyStable = async (
	token: ShieldedFungibleToken,
	expected: bigint,
	timeoutMs = 30_000,
): Promise<bigint> => {
	const deadline = Date.now() + timeoutMs;
	let last = 0n;
	for (;;) {
		try {
			last = await token.totalSupply();
		} catch (e) {
			logger.warn(`totalSupply read failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (last === expected || Date.now() > deadline) return last;
		await sleep(2_000);
	}
};

// ---------------------------------------------------------------------------
// Burn constructions
// ---------------------------------------------------------------------------

/**
 * Hidden burn: a direct wallet transfer of `amount` to the zero coin key, with
 * NO contract call. Submitted through `walletProvider.submitTx` so the bytes
 * are captured. Returns the submitted tx id.
 *
 * (Logic mirrors hidden-burn.ts:189-222; kept here so that script stays a
 * standalone single-burn demo.)
 */
const hiddenBurn = async (
	wp: MidnightWalletProvider,
	colorHex: string,
	amount: bigint,
): Promise<string> => {
	const sh = await Rx.firstValueFrom(wp.wallet.shielded.state);
	const burnAddress = new ShieldedAddress(
		ShieldedCoinPublicKey.fromHexString(BURN_COIN_PUBLIC_KEY_HEX),
		sh.address.encryptionPublicKey,
	);
	logger.info(`Hidden burn: transferring ${amount} of ${colorHex} to the zero coin key...`);
	const recipe = await wp.wallet.transferTransaction(
		[
			{
				type: "shielded",
				outputs: [{ type: colorHex as never, receiverAddress: burnAddress, amount }],
			},
		],
		{ shieldedSecretKeys: wp.zswapSecretKeys, dustSecretKey: wp.dustSecretKey },
		{ ttl: ttlOneHour(), payFees: true },
	);
	const finalized = await wp.wallet.finalizeRecipe(recipe as never);
	const txId = await wp.submitTx(finalized);
	relabelLast(wp, "hidden-burn");
	return txId;
};

export interface ProtocolBurnResult {
	value: bigint;
	txId?: string;
	error?: string;
	preBalanceImbalance?: string;
}

/**
 * Protocol burn: spend a full coin into a one-input / zero-output zswap offer
 * (a positive imbalance), balancing ONLY dust for fees so the shielded balancer
 * does not absorb the surplus. The node destroying that surplus — and exposing
 * it as plaintext `deltas[tt] = +value` — is THE experiment; if it is rejected,
 * the error is captured as a negative finding instead of aborting.
 */
const protocolBurn = async (
	wp: MidnightWalletProvider,
	providers: Providers,
	colorHex: string,
): Promise<ProtocolBurnResult> => {
	const sh = await Rx.firstValueFrom(wp.wallet.shielded.state);
	const localState = (sh as { state: { state: unknown; networkId: string } }).state.state as {
		spend: (keys: unknown, coin: unknown, segment: number | undefined) => [unknown, unknown];
	};
	const networkId = (sh as { state: { networkId: string } }).state.networkId;
	// Pick the largest spendable coin of this type (deterministic; in this
	// scenario there is exactly one — the change from the hidden burn).
	const candidates = sh.availableCoins.filter(
		(c) => (c.coin as { type: string }).type === colorHex,
	);
	const found = candidates.reduce<(typeof candidates)[number] | undefined>(
		(best, c) =>
			!best || (c.coin as { value: bigint }).value > (best.coin as { value: bigint }).value
				? c
				: best,
		undefined,
	);
	if (!found) {
		return { value: 0n, error: `No spendable coin of type ${colorHex} for protocol burn` };
	}
	const coin = found.coin;
	const value = (coin as { value: bigint }).value;
	logger.info(`Protocol burn: spending the full ${value} coin into a 1-input/0-output offer...`);

	// Everything from here is "the experiment": building the positive-imbalance
	// offer, the node accepting it, and the surplus being destroyed. Any failure
	// (construction OR node rejection) is captured as a finding so the report is
	// still written — never aborts the run.
	let preBalanceImbalance: string | undefined;
	try {
		const [, input] = localState.spend(wp.zswapSecretKeys, coin, 0);
		const offer = ZswapOffer.fromInput(input as never);
		const unproven = Transaction.fromParts(networkId, offer as never);

		try {
			const imb = (unproven as { imbalances: (seg: number) => Map<unknown, bigint> }).imbalances(
				0,
			);
			preBalanceImbalance = JSON.stringify(
				Array.from(imb.entries()).map(([k, v]) => [tokenKeyStr(k), v.toString()]),
			);
			logger.info(`Protocol burn pre-balance imbalances(0): ${preBalanceImbalance}`);
		} catch (e) {
			logger.warn(`imbalances(0) failed: ${e instanceof Error ? e.message : String(e)}`);
		}

		const recipe = await wp.wallet.balanceUnprovenTransaction(
			unproven as never,
			{ shieldedSecretKeys: wp.zswapSecretKeys, dustSecretKey: wp.dustSecretKey },
			{ ttl: ttlOneHour(), tokenKindsToBalance: ["dust"] } as never,
		);
		const finalized = await wp.wallet.finalizeRecipe(recipe as never);
		const txId = await wp.submitTx(finalized);
		relabelLast(wp, "protocol-burn");
		await providers.publicDataProvider.watchForTxData(txId);
		return { value, txId, preBalanceImbalance };
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		logger.warn(`Protocol burn failed (captured as a negative finding): ${error}`);
		return { value, error, preBalanceImbalance };
	}
};

/** Relabel the kind of the most recently captured tx (pure-zswap submits infer "tx"). */
const relabelLast = (wp: MidnightWalletProvider, kind: string): void => {
	const last = wp.submittedTxs.at(-1);
	if (last) last.kind = kind;
};

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

interface Expected {
	delta: bigint;
	fold: bigint;
	total: bigint;
	circ: bigint;
}

interface MatrixRow {
	label: string;
	txIndex: number | null;
	measuredDelta: bigint;
	measuredFold: bigint;
	measuredTotal: bigint;
	runningMints: bigint;
	expected: Expected;
}

const cellPass = (m: bigint, e: bigint): string => (m === e ? "PASS" : "FAIL");
const rowPass = (r: MatrixRow): boolean =>
	r.measuredDelta === r.expected.delta &&
	r.measuredFold === r.expected.fold &&
	r.measuredTotal === r.expected.total;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface ReportArgs {
	contractAddress: string;
	colorHex: string;
	mintTypeHex: string;
	rawTokenTypeHex: string | null;
	matchesColor: boolean | null;
	matchesMint: boolean | null;
	amounts: { M: bigint; B: bigint; H: bigint; P: bigint };
	rows: MatrixRow[];
	fold: ReturnType<typeof foldSupply>;
	protocol: ProtocolBurnResult;
	protocolShape: { inputs: number; outputs: number; contractCalls: number; delta: bigint } | null;
}

const writeReport = (a: ReportArgs): string => {
	const L: string[] = [];
	const allPass = a.rows.every(rowPass);

	L.push("# Shielded-token supply auditability — verification (auto-generated)");
	L.push("");
	L.push("Generated by `pnpm verify-supply`. One local v8 stack run executed the");
	L.push("scenario below and, after each step, compared the contract counter, the");
	L.push("indexer-recomputable delta-fold, and the true circulating supply.");
	L.push("");
	L.push("## Run parameters");
	L.push("");
	L.push("```");
	L.push(`Token             : ${TOKEN_NAME} (${TOKEN_SYMBOL})`);
	L.push(`Contract address  : ${a.contractAddress}`);
	L.push(`Token color (tt)  : ${a.colorHex}    <- zswap delta key`);
	L.push(`shieldedMints type: ${a.mintTypeHex}    <- mint-effect key`);
	if (a.rawTokenTypeHex !== null) {
		L.push(
			`rawTokenType(dom) : ${a.rawTokenTypeHex}  (== color: ${a.matchesColor}, == mint type: ${a.matchesMint})`,
		);
	}
	L.push(`M (mint)          : ${a.amounts.M}`);
	L.push(`B (contract burn) : ${a.amounts.B}`);
	L.push(`H (hidden burn)   : ${a.amounts.H}`);
	L.push(`P (protocol burn) : ${a.amounts.P}  (= M-B-H, the full remaining coin)`);
	L.push("```");
	L.push("");

	L.push("## PASS/FAIL matrix");
	L.push("");
	L.push(
		"Measured value `m` is shown with its expected `e` as `m (e)` and a per-row verdict.",
	);
	L.push("`true circulating` is a reference value derived from the scenario (not measured).");
	L.push("");
	L.push(
		"| Step | tx `delta[tt]` | fold `-Σδ` | contract `totalSupply()` | true circulating | Result |",
	);
	L.push("|---|---|---|---|---|---|");
	for (const r of a.rows) {
		const verdict = rowPass(r)
			? "✅ PASS"
			: r.label.startsWith("protocol")
				? "⚠️ FINDING"
				: "❌ FAIL";
		L.push(
			`| ${r.label} | ${r.measuredDelta} (${r.expected.delta}) ${cellPass(r.measuredDelta, r.expected.delta)} ` +
				`| ${r.measuredFold} (${r.expected.fold}) ${cellPass(r.measuredFold, r.expected.fold)} ` +
				`| ${r.measuredTotal} (${r.expected.total}) ${cellPass(r.measuredTotal, r.expected.total)} ` +
				`| ${r.expected.circ} | ${verdict} |`,
		);
	}
	L.push("");
	L.push(`Σ shieldedMints throughout: ${a.rows.at(-1)?.runningMints ?? 0n} (expected ${a.amounts.M}).`);
	L.push("");

	L.push("## Per-tx delta fold (what the indexer recomputes)");
	L.push("");
	L.push("| # | kind | delta[tt] | shieldedMints | running supply | running minted |");
	L.push("|---|---|---|---|---|---|");
	for (const r of a.fold.rows) {
		L.push(
			`| ${r.index} | ${r.kind} | ${r.delta} | ${r.mints} | ${r.runningSupply} | ${r.runningMints} |`,
		);
	}
	L.push("");

	L.push("## Protocol burn (the novel claim)");
	L.push("");
	if (a.protocol.error) {
		L.push("**Result: REJECTED / errored.** Captured as a negative finding:");
		L.push("");
		L.push("```");
		L.push(a.protocol.error);
		L.push("```");
	} else {
		L.push(`**Result: ACCEPTED.** Submitted tx id \`${a.protocol.txId}\`, value ${a.protocol.value}.`);
	}
	if (a.protocol.preBalanceImbalance) {
		L.push("");
		L.push(`Pre-balance \`imbalances(0)\`: \`${a.protocol.preBalanceImbalance}\``);
	}
	if (a.protocolShape) {
		L.push("");
		L.push("Decoded protocol-burn tx shape:");
		L.push("");
		L.push("```");
		L.push(`inputs        : ${a.protocolShape.inputs}   (expected 1)`);
		L.push(`outputs       : ${a.protocolShape.outputs}   (expected 0)`);
		L.push(`ContractCalls : ${a.protocolShape.contractCalls}   (expected 0)`);
		L.push(`delta[tt]     : ${a.protocolShape.delta}   (expected +${a.amounts.P})`);
		L.push("```");
	}
	L.push("");

	L.push("## Claims");
	L.push("");
	const mintRow = a.rows.find((r) => r.label.startsWith("mint"));
	const cBurnRow = a.rows.find((r) => r.label.startsWith("contract burn"));
	const hBurnRow = a.rows.find((r) => r.label.startsWith("hidden burn"));
	const c1 = mintRow ? mintRow.measuredFold === a.amounts.M : false;
	L.push(
		`1. **Supply = -Σ deltas[tt].** ${c1 ? "CONFIRMED" : "NOT CONFIRMED"} — after mint the fold equals the minted amount (${mintRow?.measuredFold ?? "n/a"}).`,
	);
	const c2 = !a.protocol.error && a.protocolShape
		? a.protocolShape.inputs === 1 &&
			a.protocolShape.outputs === 0 &&
			a.protocolShape.contractCalls === 0 &&
			a.protocolShape.delta === a.amounts.P
		: false;
	L.push(
		`2. **Protocol burn is public.** ${c2 ? "CONFIRMED" : a.protocol.error ? "NOT CONFIRMED (node rejected, see above)" : "NOT CONFIRMED"} — a positive-imbalance offer with plaintext \`delta[tt] = +P\`.`,
	);
	const c3 =
		cBurnRow != null &&
		hBurnRow != null &&
		cBurnRow.measuredFold === a.amounts.M &&
		hBurnRow.measuredFold === a.amounts.M &&
		cBurnRow.measuredTotal === a.amounts.M - a.amounts.B &&
		hBurnRow.measuredTotal === a.amounts.M - a.amounts.B;
	L.push(
		`3. **Dead-coin burns are invisible to the fold.** ${c3 ? "CONFIRMED" : "NOT CONFIRMED"} — across the contract burn and hidden burn the fold stays at ${a.amounts.M} while the contract counter and true circulating diverge.`,
	);
	L.push("");
	L.push(
		`Overall measured-cell matrix: ${allPass ? "ALL PASS" : "has failures"} (the protocol-burn row may legitimately be a negative finding).`,
	);
	L.push("");

	const reportPath = resolve(OUT_DIR, "SUPPLY-AUDIT.md");
	writeFileSync(reportPath, L.join("\n"));
	return reportPath;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	mkdirSync(OUT_DIR, { recursive: true });
	logger.info(`zkConfigPath: ${ZK_CONFIG_PATH}`);
	logger.info(
		`Amounts: M=${MINT_AMOUNT} B=${BURN_AMOUNT} H=${HIDDEN_BURN_AMOUNT} (soft=${SOFT_ASSERT})`,
	);

	const M = MINT_AMOUNT;
	const B = BURN_AMOUNT;
	const H = HIDDEN_BURN_AMOUNT;

	// If HB_*_PORT are set, an externally-managed stack is already up (see
	// scripts/run-verify-supply.sh). Skip testkit's container management — its
	// testcontainers log-wait is flaky here — and point straight at the ports.
	const injected =
		process.env.HB_INDEXER_PORT && process.env.HB_NODE_PORT && process.env.HB_PS_PORT;
	const testEnv = injected ? undefined : getTestEnvironment(logger);
	const providersToStop: MidnightWalletProvider[] = [];
	const rows: MatrixRow[] = [];
	let colorHex = "";
	let mintTypeHex = "";
	let protocol: ProtocolBurnResult = { value: 0n };

	try {
		let envConfig: Parameters<typeof MidnightWalletProvider.build>[1];
		if (injected) {
			setNetworkId("undeployed");
			envConfig = new LocalTestConfiguration({
				indexer: Number(process.env.HB_INDEXER_PORT),
				node: Number(process.env.HB_NODE_PORT),
				proofServer: Number(process.env.HB_PS_PORT),
			} as never) as never;
			logger.info(`Using injected stack: ${JSON.stringify(envConfig)}`);
		} else {
			logger.info("Starting local test environment (node + indexer + proof-server)...");
			envConfig = await testEnv!.start();
			logger.info(`Environment up: ${JSON.stringify(envConfig)}`);
		}

		const walletProvider = await MidnightWalletProvider.build(logger, envConfig, GENESIS_SEED);
		providersToStop.push(walletProvider);
		await walletProvider.start();
		await waitForUnshieldedFunds(logger, walletProvider.wallet, unshieldedToken());

		const providers = configureProviders(walletProvider, ZK_CONFIG_PATH);

		// 1) deploy
		const token = await ShieldedFungibleToken.deploy(
			providers,
			TOKEN_NAME,
			TOKEN_SYMBOL,
			ZK_CONFIG_PATH,
			logger,
		);

		/** Snapshot the three counters after a step and record a matrix row. */
		const checkpoint = async (label: string, expected: Expected): Promise<void> => {
			const ordered = decodeCaptured(walletProvider);
			const lastTx = ordered.at(-1);
			const fold = foldSupply(ordered, colorHex || " ", mintTypeHex || undefined);
			const measuredDelta = lastTx ? deltaForType(lastTx.tx, colorHex || " ") : 0n;
			const measuredTotal = await readTotalSupplyStable(token, expected.total);
			const row: MatrixRow = {
				label,
				txIndex: lastTx?.index ?? null,
				measuredDelta,
				measuredFold: fold.supply,
				measuredTotal,
				runningMints: fold.totalMinted,
				expected,
			};
			rows.push(row);
			logger.info(
				`[${label}] delta=${measuredDelta} fold=${fold.supply} total=${measuredTotal} ` +
					`(expected delta=${expected.delta} fold=${expected.fold} total=${expected.total}) ` +
					`-> ${rowPass(row) ? "PASS" : "FAIL"}`,
			);
		};

		await checkpoint("deploy", { delta: 0n, fold: 0n, total: 0n, circ: 0n });

		// 2) mint M
		const minted = await token.mint(walletProvider.getCoinPublicKey(), M);
		colorHex = hexOf(minted.color);
		await waitForShieldedToken(logger, walletProvider.wallet, colorHex, M);
		// The mint-effect token type is rawTokenType(domain, address); read the
		// observed key from the mint tx and cross-check against rawTokenType.
		mintTypeHex = observedMintType(decodeCaptured(walletProvider)) ?? "";
		await checkpoint("mint M", { delta: -M, fold: M, total: M, circ: M });

		// 3) contract burn B (change coin = M-B comes back to us)
		await token.burn(minted, B);
		await waitForChangeCoin(walletProvider.wallet, colorHex, M - B);
		await checkpoint("contract burn B", { delta: 0n, fold: M, total: M - B, circ: M - B });

		// 4) hidden burn H (direct transfer to the zero coin key; change = M-B-H)
		await hiddenBurn(walletProvider, colorHex, H);
		await waitForChangeCoin(walletProvider.wallet, colorHex, M - B - H);
		await checkpoint("hidden burn H", { delta: 0n, fold: M, total: M - B, circ: M - B - H });

		// 5) protocol burn P (spend the full remaining coin). Key the expectation
		// on whether the tx actually reached the capture set, so a failure that
		// happens only after submission (e.g. the post-submit watch) does not
		// flip the row to a spurious delta/fold mismatch.
		protocol = await protocolBurn(walletProvider, providers, colorHex);
		const P = protocol.value;
		const protocolLanded = walletProvider.submittedTxs.some((t) => t.kind === "protocol-burn");
		await checkpoint("protocol burn P", {
			delta: protocolLanded ? P : 0n,
			fold: protocolLanded ? M - P : M,
			total: M - B,
			circ: M - B - H - P,
		});

		// rawTokenType cross-check (best-effort; encoding may differ from stdlib).
		const { rawTokenTypeHex, matchesColor, matchesMint } = await computeRawTokenType(
			providers,
			token.addressHex,
			colorHex,
			mintTypeHex,
		);

		// Write artifacts + report
		const decoded = decodeCaptured(walletProvider);
		for (const t of walletProvider.submittedTxs) {
			const d: DecodedTx = decodeTx(t.hex);
			writeFileSync(resolve(OUT_DIR, `${t.index}-${t.kind}.hex`), t.hex);
			writeFileSync(resolve(OUT_DIR, `${t.index}-${t.kind}.decode.txt`), formatDecode(d));
		}
		const protocolTx = decoded.find((o) => o.kind === "protocol-burn");
		const protocolShape = protocolTx
			? {
					inputs: protocolTx.tx.guaranteedOffer?.inputs.length ?? 0,
					outputs: protocolTx.tx.guaranteedOffer?.outputs.length ?? 0,
					contractCalls: protocolTx.tx.intents
						.flatMap((i) => i.actions)
						.filter((act) => act.kind === "ContractCall").length,
					delta: deltaForType(protocolTx.tx, colorHex),
				}
			: null;

		const reportPath = writeReport({
			contractAddress: token.addressHex,
			colorHex,
			mintTypeHex,
			rawTokenTypeHex,
			matchesColor,
			matchesMint,
			amounts: { M, B, H, P },
			rows,
			fold: foldSupply(decoded, colorHex, mintTypeHex || undefined),
			protocol,
			protocolShape,
		});

		logger.info("==================================================================");
		logger.info("DONE (supply audit). Summary:");
		logger.info(`  contract : ${token.addressHex}`);
		for (const r of rows) {
			logger.info(
				`  ${r.label.padEnd(18)} delta=${r.measuredDelta} fold=${r.measuredFold} total=${r.measuredTotal} ${rowPass(r) ? "PASS" : "FAIL"}`,
			);
		}
		logger.info(`  report : ${reportPath}`);
		logger.info("==================================================================");
	} catch (e) {
		logger.error(`Supply audit failed: ${e instanceof Error ? e.message : String(e)}`);
		if (e instanceof Error && e.stack) logger.error(e.stack);
		throw e;
	} finally {
		for (const p of providersToStop) {
			try {
				await p.stop();
			} catch (e) {
				logger.warn(`stop wallet: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		try {
			if (testEnv) await testEnv.shutdown();
		} catch (e) {
			logger.warn(`shutdown: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// In strict mode, fail the process on any non-protocol-burn measured-cell miss.
	const hardFailures = rows.filter((r) => !r.label.startsWith("protocol") && !rowPass(r));
	if (!SOFT_ASSERT && hardFailures.length > 0) {
		throw new Error(`${hardFailures.length} measured-cell assertion(s) failed (strict mode)`);
	}
}

/** First shieldedMints key observed across captured txs (the mint-effect type). */
const observedMintType = (txs: OrderedTx[]): string | undefined => {
	for (const { tx } of txs) {
		for (const intent of tx.intents) {
			for (const action of intent.actions) {
				if (action.kind !== "ContractCall") continue;
				for (const t of [action.guaranteedTranscript, action.fallibleTranscript]) {
					const keys = t ? Object.keys(t.effects.shieldedMints) : [];
					if (keys.length > 0) return keys[0];
				}
			}
		}
	}
	return undefined;
};

/**
 * Best-effort rawTokenType(domain, address) cross-check against the observed
 * mint-effect type. `ledger()` exposes the sealed `_domain`; we recompute the
 * raw token type from it and compare. Wrapped in try/catch because the stdlib's
 * exact derivation may not match `rawTokenType` — a mismatch is reported, not
 * fatal.
 */
const computeRawTokenType = async (
	providers: Providers,
	addressHex: string,
	colorHex: string,
	mintTypeHex: string,
): Promise<{
	rawTokenTypeHex: string | null;
	matchesColor: boolean | null;
	matchesMint: boolean | null;
}> => {
	try {
		const cs = await providers.publicDataProvider.queryContractState(addressHex);
		if (!cs) return { rawTokenTypeHex: null, matchesColor: null, matchesMint: null };
		const domain = (ledger(cs.data as never) as { ShieldedFungibleToken__domain: Uint8Array })
			.ShieldedFungibleToken__domain;
		const raw = rawTokenType(domain, addressHex);
		return { rawTokenTypeHex: raw, matchesColor: raw === colorHex, matchesMint: raw === mintTypeHex };
	} catch (e) {
		logger.warn(`rawTokenType cross-check skipped: ${e instanceof Error ? e.message : String(e)}`);
		return { rawTokenTypeHex: null, matchesColor: null, matchesMint: null };
	}
};

main().then(
	() => process.exit(0),
	() => process.exit(1),
);
