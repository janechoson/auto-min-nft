export interface ChainProfile {
    key: string;
    chainId: number;
    name: string;
    explorer: string;
    nativeSymbol: string;
    rpc: {
        alchemyHost?: string;
        public: string[];
    };
}
export declare const CHAINS: ChainProfile[];
export declare function resolveChain(idOrKey: string | number | bigint | null | undefined): ChainProfile | undefined;
export declare function explorerTx(idOrKey: string | number | bigint | null | undefined, txHash: string): string;
