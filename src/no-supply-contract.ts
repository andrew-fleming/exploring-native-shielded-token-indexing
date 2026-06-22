// Thin deploy/mint/burn wrapper around the counter-free NoSupplyToken contract
// (build/NoSupplyToken). Mirrors src/contract.ts but: constructor takes only
// (nonce, domain) — there is no _totalSupply field and no totalSupply() read.
import { randomBytes } from "node:crypto";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { type CoinPublicKey, encodeCoinPublicKey } from "@midnight-ntwrk/ledger-v8";
// Compiler-generated, counter-free contract.
import { Contract } from "../build/NoSupplyToken/contract/index.js";
import type { Providers } from "./providers.js";

export type ShieldedCoinInfo = { nonce: Uint8Array; color: Uint8Array; value: bigint };
export type ShieldedSendResult = {
	change: { is_some: boolean; value: ShieldedCoinInfo };
	sent: ShieldedCoinInfo;
};

export const PRIVATE_STATE_ID = "noSupplyTokenPrivateState";

const createCompiledContract = (zkConfigPath: string) => {
	const base = CompiledContract.make("NoSupplyToken", Contract as never);
	const withWit = CompiledContract.withWitnesses(base, {} as never);
	return CompiledContract.withCompiledFileAssets(withWit, zkConfigPath);
};

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const recipientForCoinPublicKey = (coinPublicKey: CoinPublicKey) => ({
	is_left: true,
	left: { bytes: encodeCoinPublicKey(coinPublicKey) },
	right: { bytes: new Uint8Array(32) },
});

export class NoSupplyToken {
	private constructor(
		private readonly deployedContract: any,
		private readonly logger: { info: (m: string) => void },
	) {}

	get addressHex(): string {
		return this.deployedContract.deployTxData.public.contractAddress;
	}

	static async deploy(
		providers: Providers,
		zkConfigPath: string,
		logger: { info: (m: string) => void },
	): Promise<NoSupplyToken> {
		logger.info("Deploying NoSupplyToken (counter-free)...");
		const nonce = randomBytes(32);
		const domain = randomBytes(32);
		const deployedContract = await deployContract(providers as never, {
			compiledContract: createCompiledContract(zkConfigPath),
			privateStateId: PRIVATE_STATE_ID,
			initialPrivateState: {},
			args: [nonce, domain],
		} as never);
		const token = new NoSupplyToken(deployedContract, logger);
		logger.info(`Deployed at contract address: ${token.addressHex}`);
		return token;
	}

	async mint(coinPublicKey: CoinPublicKey, amount: bigint): Promise<ShieldedCoinInfo> {
		this.logger.info(`Minting ${amount}...`);
		const txData = await this.deployedContract.callTx.mint(
			recipientForCoinPublicKey(coinPublicKey),
			amount,
		);
		const coin: ShieldedCoinInfo = txData.private.result;
		this.logger.info(
			`Minted: color=${bytesToHex(coin.color)} value=${coin.value} (tx ${txData.public.txHash})`,
		);
		return coin;
	}

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
