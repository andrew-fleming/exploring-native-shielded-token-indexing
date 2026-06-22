// Counter-free burn experiment orchestrator.
//
// Same local v8 stack + same coin-op burn as src/reproduce.ts, but against the
// NoSupplyToken contract (build/NoSupplyToken): a contract-mediated burn whose
// coin ops keep their compiler-required `disclose` wrappers, yet there is NO
// `_totalSupply` ledger write of `amount`. We deploy -> mint -> burn and decode
// every tx so we can search the raw bytes for the burned amount.
//
// Run: tsx src/no-supply-burn.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { getTestEnvironment, LocalTestConfiguration } from "@midnight-ntwrk/testkit-js";
import { pino } from "pino";
import { WebSocket } from "ws";
import { type DecodedTx, decodeTx, formatDecode } from "./decode.js";
import { NoSupplyToken } from "./no-supply-contract.js";
import { configureProviders } from "./providers.js";
import { MidnightWalletProvider } from "./wallet-provider.js";
import { waitForShieldedToken, waitForUnshieldedFunds } from "./wallet-utils.js";

(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const ZK_CONFIG_PATH = resolve(PKG_ROOT, "build", "NoSupplyToken");
const OUT_DIR = resolve(PKG_ROOT, "out");

const GENESIS_SEED = "0000000000000000000000000000000000000000000000000000000000000001";
const MINT_AMOUNT = BigInt(process.env.MINT_AMOUNT ?? "1000000");
const BURN_AMOUNT = BigInt(process.env.BURN_AMOUNT ?? "400000");

const logger = pino({
	level: process.env.DEBUG_LEVEL ?? "info",
	transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
});

const hexOf = (u8: Uint8Array): string => Buffer.from(u8).toString("hex");

async function main(): Promise<void> {
	mkdirSync(OUT_DIR, { recursive: true });
	logger.info(`zkConfigPath: ${ZK_CONFIG_PATH}`);

	// If HB_*_PORT are set, an externally-managed stack is already up (see
	// scripts/run-no-supply-burn.sh) — skip testkit's flaky log-wait.
	const injected =
		process.env.HB_INDEXER_PORT && process.env.HB_NODE_PORT && process.env.HB_PS_PORT;
	const testEnv = injected ? undefined : getTestEnvironment(logger);
	const providersToStop: MidnightWalletProvider[] = [];
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

		const unshielded = await waitForUnshieldedFunds(logger, walletProvider.wallet, unshieldedToken());
		logger.info(`NIGHT balance: ${unshielded.balances[unshieldedToken().raw]}`);

		const providers = configureProviders(walletProvider, ZK_CONFIG_PATH);

		const token = await NoSupplyToken.deploy(providers, ZK_CONFIG_PATH, logger);
		const minted = await token.mint(walletProvider.getCoinPublicKey(), MINT_AMOUNT);
		const colorHex = hexOf(minted.color);

		await waitForShieldedToken(logger, walletProvider.wallet, colorHex, minted.value);
		const burnResult = await token.burn(minted, BURN_AMOUNT);
		const changeAmount = burnResult.change.is_some ? burnResult.change.value.value : 0n;

		const decoded: (DecodedTx & { index: number; kind: string })[] = [];
		for (const tx of walletProvider.submittedTxs) {
			const d = { index: tx.index, kind: tx.kind, ...decodeTx(tx.hex) };
			decoded.push(d);
			writeFileSync(resolve(OUT_DIR, `ns-${tx.index}-${tx.kind}.hex`), tx.hex);
			writeFileSync(resolve(OUT_DIR, `ns-${tx.index}-${tx.kind}.decode.txt`), formatDecode(d));
		}

		logger.info("==================================================================");
		logger.info("DONE (counter-free). Summary:");
		logger.info(`  contract : ${token.addressHex}`);
		logger.info(`  color    : ${colorHex}`);
		for (const tx of walletProvider.submittedTxs) {
			logger.info(`  tx #${tx.index} ${tx.kind.padEnd(6)} ${tx.byteLength} bytes  ${tx.transactionHash}`);
		}
		logger.info(`  minted ${MINT_AMOUNT}, burned ${BURN_AMOUNT}, change ${changeAmount}`);
		logger.info(`  raw hex + decodes (ns-*) in: ${OUT_DIR}`);
		logger.info("==================================================================");
	} catch (e) {
		logger.error(`Counter-free run failed: ${e instanceof Error ? e.message : String(e)}`);
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
}

main().then(
	() => process.exit(0),
	() => process.exit(1),
);
