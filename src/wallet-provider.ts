// Wallet provider: implements the midnight-js WalletProvider + MidnightProvider
// interfaces (balanceTx / submitTx). On every submit it captures the exact
// serialized bytes the node/indexer receives, so they can be decoded afterwards.
import {
	type CoinPublicKey,
	DustSecretKey,
	type EncPublicKey,
	encodeCoinPublicKey,
	type FinalizedTransaction,
	LedgerParameters,
	ZswapSecretKeys,
} from "@midnight-ntwrk/ledger-v8";
import type {
	MidnightProvider,
	UnboundTransaction,
	WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";
import { ttlOneHour } from "@midnight-ntwrk/midnight-js-utils";
import {
	type DustWalletOptions,
	type EnvironmentConfiguration,
	FluentWalletBuilder,
} from "@midnight-ntwrk/testkit-js";
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk";
import type { Logger } from "pino";
import * as Rx from "rxjs";

export interface CapturedTx {
	index: number;
	kind: string;
	byteLength: number;
	transactionHash: string | undefined;
	hex: string;
}

const hx = (v: unknown): string => {
	try {
		if (v === null || v === undefined) return String(v);
		if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
		return String(v);
	} catch {
		return "<unprintable>";
	}
};

/** Infer whether a submitted tx is a deploy or a specific contract-circuit call. */
const inferKind = (tx: any): string => {
	try {
		if (tx.intents) {
			for (const [, intent] of tx.intents as Iterable<[unknown, any]>) {
				for (const a of intent.actions ?? []) {
					if (a.entryPoint !== undefined) {
						return typeof a.entryPoint === "string" ? a.entryPoint : hx(a.entryPoint);
					}
					if (a.address !== undefined) return "deploy";
				}
			}
		}
	} catch {}
	return "tx";
};

export class MidnightWalletProvider implements MidnightProvider, WalletProvider {
	/** Captured submitted transactions, in submission order. */
	readonly submittedTxs: CapturedTx[] = [];

	private constructor(
		readonly logger: Logger,
		readonly env: EnvironmentConfiguration,
		readonly wallet: WalletFacade,
		readonly zswapSecretKeys: ZswapSecretKeys,
		readonly dustSecretKey: DustSecretKey,
	) {}

	getCoinPublicKey(): CoinPublicKey {
		return this.zswapSecretKeys.coinPublicKey;
	}

	getCoinPublicKeyBytes(): Uint8Array {
		return encodeCoinPublicKey(String(this.zswapSecretKeys.coinPublicKey));
	}

	getEncryptionPublicKey(): EncPublicKey {
		return this.zswapSecretKeys.encryptionPublicKey;
	}

	async balanceTx(
		tx: UnboundTransaction,
		ttl: Date = ttlOneHour(),
	): Promise<FinalizedTransaction> {
		const recipe = await this.wallet.balanceUnboundTransaction(
			tx,
			{ shieldedSecretKeys: this.zswapSecretKeys, dustSecretKey: this.dustSecretKey },
			{ ttl },
		);
		return await this.wallet.finalizeRecipe(recipe);
	}

	async submitTx(tx: FinalizedTransaction): Promise<string> {
		this.captureTx(tx);
		const txId = await this.wallet.submitTransaction(tx);
		this.logger.info(`Submitted tx, wallet returned id: ${txId}`);
		return txId;
	}

	/** Serialize + record the on-chain bytes; never blocks submission. */
	private captureTx(tx: FinalizedTransaction): void {
		try {
			const raw = tx.serialize();
			const record: CapturedTx = {
				index: this.submittedTxs.length + 1,
				kind: inferKind(tx),
				byteLength: raw.length,
				transactionHash: (() => {
					try {
						return hx(tx.transactionHash());
					} catch {
						return undefined;
					}
				})(),
				hex: Buffer.from(raw).toString("hex"),
			};
			this.submittedTxs.push(record);
			this.logger.info(
				`=== SUBMIT TX #${record.index} (${record.kind}): ${record.byteLength} bytes, hash=${record.transactionHash} ===`,
			);
		} catch (e) {
			this.logger.warn(`Failed to capture tx: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async start(): Promise<void> {
		this.logger.info("Starting wallet...");
		await this.wallet.start(this.zswapSecretKeys, this.dustSecretKey);
	}

	async stop(): Promise<void> {
		return this.wallet.stop();
	}

	static async build(
		logger: Logger,
		env: EnvironmentConfiguration,
		seed: string,
	): Promise<MidnightWalletProvider> {
		const dustOptions: DustWalletOptions = {
			ledgerParams: LedgerParameters.initialParameters(),
			additionalFeeOverhead: 1_000n,
			feeBlocksMargin: 5,
		};
		// The dev-preset local chain needs a larger Dust fee overhead.
		if (env.walletNetworkId === "undeployed") {
			dustOptions.additionalFeeOverhead = 500_000_000_000_000_000n;
		}
		const builder = FluentWalletBuilder.forEnvironment(env).withDustOptions(dustOptions);
		const buildResult = (await builder.withSeed(seed).buildWithoutStarting()) as unknown as {
			wallet: WalletFacade;
			seeds: { masterSeed: string; shielded: Uint8Array; dust: Uint8Array };
		};
		const { wallet, seeds } = buildResult;

		const initialState = await Rx.firstValueFrom(wallet.shielded.state);
		logger.info(
			`Wallet seed: ${seeds.masterSeed}; coin public key: ${initialState.address.coinPublicKeyString()}`,
		);

		return new MidnightWalletProvider(
			logger,
			env,
			wallet,
			ZswapSecretKeys.fromSeed(seeds.shielded),
			DustSecretKey.fromSeed(seeds.dust),
		);
	}
}
