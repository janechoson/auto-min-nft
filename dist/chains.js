"use strict";
// Chain registry used for explorer links and native currency labels.
// RPC choices for the web UI live in public/const.js and src/consts.ts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAINS = void 0;
exports.resolveChain = resolveChain;
exports.explorerTx = explorerTx;
exports.CHAINS = [
    {
        key: "ethereum",
        chainId: 1,
        name: "Ethereum",
        explorer: "https://etherscan.io",
        nativeSymbol: "ETH",
        rpc: {
            alchemyHost: "eth-mainnet.g.alchemy.com",
            public: [
                "https://ethereum-rpc.publicnode.com",
                "https://eth.merkle.io",
                "https://cloudflare-eth.com",
            ],
        },
    },
    {
        key: "base",
        chainId: 8453,
        name: "Base",
        explorer: "https://basescan.org",
        nativeSymbol: "ETH",
        rpc: {
            alchemyHost: "base-mainnet.g.alchemy.com",
            public: [
                "https://mainnet.base.org",
                "https://base-rpc.publicnode.com",
                // Send-only (rejects eth_chainId/eth_call) but the fastest inclusion
                // path — planRpcs keeps it for blasting and never reads from it.
                "https://mainnet-sequencer.base.org",
            ],
        },
    },
    {
        key: "robinhood",
        chainId: 4663,
        name: "Robinhood Chain",
        explorer: "https://robinhoodchain.blockscout.com",
        nativeSymbol: "ETH",
        rpc: {
            alchemyHost: "robinhood-mainnet.g.alchemy.com",
            public: [
                "https://rpc.mainnet.chain.robinhood.com",
                "https://sequencer.mainnet.chain.robinhood.com",
            ],
        },
    },
    {
        key: "bsc",
        chainId: 56,
        name: "BNB Smart Chain",
        explorer: "https://bscscan.com",
        nativeSymbol: "BNB",
        rpc: {
            public: [
                "https://binance.llamarpc.com",
                "https://bsc-dataseed.binance.org",
            ],
        },
    },
];
const DEFAULT_EXPLORER = "https://basescan.org";
// Resolve a chain by its numeric chainId (from the live network) or by app key.
function resolveChain(idOrKey) {
    if (idOrKey === null || idOrKey === undefined)
        return undefined;
    if (typeof idOrKey === "string") {
        const key = idOrKey.trim().toLowerCase();
        return exports.CHAINS.find((c) => c.key === key);
    }
    const id = Number(idOrKey);
    return exports.CHAINS.find((c) => c.chainId === id);
}
// Build a block-explorer tx URL for whatever chain we're on. Accepts either the
// numeric chainId (preferred — it's authoritative) or the chain key. Falls back
// to Basescan for unknown chains so links are never broken silently.
function explorerTx(idOrKey, txHash) {
    const profile = resolveChain(idOrKey);
    const base = profile?.explorer ?? DEFAULT_EXPLORER;
    return `${base}/tx/${txHash}`;
}
//# sourceMappingURL=chains.js.map