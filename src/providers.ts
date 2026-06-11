// Assemble the midnight-js providers the contract calls need.
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { MidnightWalletProvider } from "./wallet-provider.js";

export const PRIVATE_STATE_STORE_NAME = "shielded-token-private-state";

export const configureProviders = (
	walletProvider: MidnightWalletProvider,
	zkConfigPath: string,
) => {
	const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
	const env = walletProvider.env;

	const privateStateConfig = {
		privateStateStoreName: PRIVATE_STATE_STORE_NAME,
		accountId: walletProvider.getCoinPublicKey(),
		// Provider requires a password with >=3 character classes.
		privateStoragePasswordProvider: () =>
			`${walletProvider.getEncryptionPublicKey() as unknown as string}A!`,
	} as Parameters<typeof levelPrivateStateProvider>[0];

	return {
		privateStateProvider: levelPrivateStateProvider(privateStateConfig),
		publicDataProvider: indexerPublicDataProvider(env.indexer, env.indexerWS),
		zkConfigProvider,
		proofProvider: httpClientProofProvider(env.proofServer, zkConfigProvider),
		walletProvider,
		midnightProvider: walletProvider,
	};
};

export type Providers = ReturnType<typeof configureProviders>;
