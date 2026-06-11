// Wallet sync / balance helpers (local stack, no faucet — the genesis seed is
// prefunded on the dev preset).
import type { UnshieldedTokenType } from "@midnight-ntwrk/ledger-v8";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
	type FacadeState,
	UnshieldedAddress,
	type UnshieldedWalletAPI,
	type UnshieldedWalletState,
	type WalletFacade,
} from "@midnight-ntwrk/wallet-sdk";
import type { Logger } from "pino";
import * as Rx from "rxjs";

const DEFAULT_SYNC_TIMEOUT_MS = 180_000;

export const getInitialUnshieldedState = (
	logger: Logger,
	wallet: UnshieldedWalletAPI,
): Promise<UnshieldedWalletState> => {
	logger.info("Getting initial unshielded wallet state...");
	return Rx.firstValueFrom(wallet.state);
};

/** Resolves once the wallet reports isSynced; logs balances on the way. */
export const syncWallet = (
	logger: Logger,
	wallet: WalletFacade,
	throttleTime = 2_000,
	timeout = DEFAULT_SYNC_TIMEOUT_MS,
): Promise<FacadeState> =>
	Rx.firstValueFrom(
		wallet.state().pipe(
			Rx.throttleTime(throttleTime),
			Rx.filter((state: FacadeState) => state.isSynced),
			Rx.tap((state: FacadeState) => {
				const shielded = state.shielded.balances || {};
				const unshielded = state.unshielded.balances || {};
				const dust = state.dust.balance(new Date(Date.now())) || 0n;
				logger.info(
					`Synced. Balances - Shielded: ${JSON.stringify(shielded)}, Unshielded: ${JSON.stringify(unshielded)}, Dust: ${dust}`,
				);
			}),
			Rx.timeout({
				each: timeout,
				with: () =>
					Rx.throwError(() => new Error(`Wallet sync timeout after ${timeout}ms`)),
			}),
		),
	);

/** Wait until the wallet holds the given (unshielded) token; returns its state. */
export const waitForUnshieldedFunds = async (
	logger: Logger,
	wallet: WalletFacade,
	tokenType: UnshieldedTokenType,
): Promise<UnshieldedWalletState> => {
	const initialState = await getInitialUnshieldedState(logger, wallet.unshielded);
	const address = UnshieldedAddress.codec.encode(getNetworkId(), initialState.address);
	logger.info(`Unshielded address: ${address.toString()} (waiting for funds)`);
	const initialBalance = initialState.balances[tokenType.raw];
	if (initialBalance === undefined || initialBalance === 0n) {
		logger.info("Initial NIGHT balance is 0; waiting for sync...");
		const facadeState = await syncWallet(logger, wallet);
		return facadeState.unshielded;
	}
	return initialState;
};

/**
 * Poll the wallet's shielded state until it holds at least `minAmount` of the
 * given token type (hex `RawTokenType`). A coin minted to this wallet only
 * becomes spendable once it has synced from the chain; burning before then
 * fails coin selection. Returns the observed balance.
 */
export const waitForShieldedToken = async (
	logger: Logger,
	wallet: WalletFacade,
	tokenTypeHex: string,
	minAmount: bigint,
	timeout = DEFAULT_SYNC_TIMEOUT_MS,
): Promise<bigint> => {
	logger.info(
		`Waiting for shielded balance of ${tokenTypeHex} >= ${minAmount} (timeout: ${timeout}ms)...`,
	);
	const state = await Rx.firstValueFrom(
		wallet.state().pipe(
			Rx.tap((s: FacadeState) => {
				const bal = s.shielded.balances?.[tokenTypeHex] ?? 0n;
				logger.debug(`shielded ${tokenTypeHex}=${bal} (synced=${s.isSynced})`);
			}),
			Rx.filter(
				(s: FacadeState) => (s.shielded.balances?.[tokenTypeHex] ?? 0n) >= minAmount,
			),
			Rx.timeout({
				each: timeout,
				with: () =>
					Rx.throwError(
						() =>
							new Error(
								`Timeout waiting for shielded token ${tokenTypeHex} >= ${minAmount}`,
							),
					),
			}),
		),
	);
	const bal = state.shielded.balances?.[tokenTypeHex] ?? 0n;
	logger.info(`Shielded balance ready: ${tokenTypeHex}=${bal}`);
	return bal;
};
