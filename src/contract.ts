// Thin wrapper around the generated ShieldedFungibleToken contract: deploy,
// join, mint, burn. Mirrors @openzeppelin/midnight-apps-shielded-token-api but
// imports the vendored compiled contract directly (no workspace dependency).
import { randomBytes } from "node:crypto";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import {
	deployContract,
	findDeployedContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import { type CoinPublicKey, encodeCoinPublicKey } from "@midnight-ntwrk/ledger-v8";
// Vendored, compiler-generated contract module. Only depends on
// @midnight-ntwrk/compact-runtime at runtime; types come from its index.d.ts.
import {
	Contract,
	type ShieldedCoinInfo,
	type ShieldedSendResult,
} from "../artifacts/shielded-token/ShieldedFungibleToken/contract/index.js";
import type { Providers } from "./providers.js";

export const PRIVATE_STATE_ID = "shieldedFungibleTokenPrivateState";

const createCompiledContract = (zkConfigPath: string) => {
	const base = CompiledContract.make("ShieldedFungibleToken", Contract as never);
	// The contract declares no witnesses.
	const withWit = CompiledContract.withWitnesses(base, {} as never);
	return CompiledContract.withCompiledFileAssets(withWit, zkConfigPath);
};

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Build the Either<ZswapCoinPublicKey, ContractAddress> recipient for a coin pk. */
const recipientForCoinPublicKey = (coinPublicKey: CoinPublicKey) => ({
	is_left: true,
	left: { bytes: encodeCoinPublicKey(coinPublicKey) },
	right: { bytes: new Uint8Array(32) },
});

export class ShieldedFungibleToken {
	private constructor(
		private readonly deployedContract: any,
		private readonly providers: Providers,
		private readonly logger: { info: (m: string) => void },
	) {}

	get addressHex(): string {
		return this.deployedContract.deployTxData.public.contractAddress;
	}

	static async deploy(
		providers: Providers,
		name: string,
		symbol: string,
		zkConfigPath: string,
		logger: { info: (m: string) => void },
	): Promise<ShieldedFungibleToken> {
		logger.info(`Deploying ShieldedFungibleToken "${name}" (${symbol})...`);
		const nonce = randomBytes(32);
		const domain = randomBytes(32);
		const deployedContract = await deployContract(providers as never, {
			compiledContract: createCompiledContract(zkConfigPath),
			privateStateId: PRIVATE_STATE_ID,
			initialPrivateState: {},
			args: [nonce, name, symbol, domain],
		} as never);
		const token = new ShieldedFungibleToken(deployedContract, providers, logger);
		logger.info(`Deployed at contract address: ${token.addressHex}`);
		return token;
	}

	static async join(
		providers: Providers,
		contractAddressHex: string,
		zkConfigPath: string,
		logger: { info: (m: string) => void },
	): Promise<ShieldedFungibleToken> {
		logger.info(`Joining ShieldedFungibleToken at ${contractAddressHex}...`);
		const deployedContract = await findDeployedContract(providers as never, {
			contractAddress: contractAddressHex.replace(/^0x/, ""),
			compiledContract: createCompiledContract(zkConfigPath),
			privateStateId: PRIVATE_STATE_ID,
			initialPrivateState: {},
		} as never);
		return new ShieldedFungibleToken(deployedContract, providers, logger);
	}

	/** Mint `amount` to a coin public key; returns the minted ShieldedCoinInfo. */
	async mint(coinPublicKey: CoinPublicKey, amount: bigint): Promise<ShieldedCoinInfo> {
		this.logger.info(`Minting ${amount}...`);
		const txData = await this.deployedContract.callTx.mint(
			recipientForCoinPublicKey(coinPublicKey),
			amount,
		);
		const coin: ShieldedCoinInfo = txData.private.result; // { nonce, color, value }
		this.logger.info(
			`Minted: color=${bytesToHex(coin.color)} value=${coin.value} (tx ${txData.public.txHash})`,
		);
		return coin;
	}

	/** Burn `amount` of an owned coin; returns the ShieldedSendResult (incl. change). */
	async burn(coin: ShieldedCoinInfo, amount: bigint): Promise<ShieldedSendResult> {
		this.logger.info(`Burning ${amount} of coin value=${coin.value}...`);
		const txData = await this.deployedContract.callTx.burn(coin, amount);
		const result: ShieldedSendResult = txData.private.result;
		const change = result.change.is_some ? result.change.value.value : 0n;
		this.logger.info(
			`Burned: sent=${result.sent.value} change=${change} (tx ${txData.public.txHash})`,
		);
		return result;
	}
}
