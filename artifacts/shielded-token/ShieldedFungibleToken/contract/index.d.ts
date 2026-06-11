import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ShieldedCoinInfo = { nonce: Uint8Array;
                                 color: Uint8Array;
                                 value: bigint
                               };

export type ShieldedSendResult = { change: { is_some: boolean,
                                             value: ShieldedCoinInfo
                                           };
                                   sent: ShieldedCoinInfo
                                 };

export type ZswapCoinPublicKey = { bytes: Uint8Array };

export type ContractAddress = { bytes: Uint8Array };

export type Either<A, B> = { is_left: boolean; left: A; right: B };

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  symbol(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  decimals(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  color(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Uint8Array>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: Either<ZswapCoinPublicKey, ContractAddress>,
       amount_0: bigint): __compactRuntime.CircuitResults<PS, ShieldedCoinInfo>;
  burn(context: __compactRuntime.CircuitContext<PS>,
       coin_0: ShieldedCoinInfo,
       amount_0: bigint): __compactRuntime.CircuitResults<PS, ShieldedSendResult>;
}

export type ProvableCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  symbol(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  decimals(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  color(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Uint8Array>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: Either<ZswapCoinPublicKey, ContractAddress>,
       amount_0: bigint): __compactRuntime.CircuitResults<PS, ShieldedCoinInfo>;
  burn(context: __compactRuntime.CircuitContext<PS>,
       coin_0: ShieldedCoinInfo,
       amount_0: bigint): __compactRuntime.CircuitResults<PS, ShieldedSendResult>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  symbol(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, string>;
  decimals(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  color(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Uint8Array>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       recipient_0: Either<ZswapCoinPublicKey, ContractAddress>,
       amount_0: bigint): __compactRuntime.CircuitResults<PS, ShieldedCoinInfo>;
  burn(context: __compactRuntime.CircuitContext<PS>,
       coin_0: ShieldedCoinInfo,
       amount_0: bigint): __compactRuntime.CircuitResults<PS, ShieldedSendResult>;
}

export type Ledger = {
  readonly ShieldedFungibleToken__nonce: Uint8Array;
  readonly ShieldedFungibleToken__domain: Uint8Array;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               nonce__0: Uint8Array,
               name__0: string,
               symbol__0: string,
               domain__0: Uint8Array): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
