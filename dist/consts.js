"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RPCS = void 0;
// Central RPC configuration shared by frontend (public/const.js) and backend.
exports.RPCS = [
    { label: 'Ethereum', id: 1, rpc: 'https://ethereum-rpc.publicnode.com' },
    { label: 'Base', id: 8453, rpc: 'https://mainnet.base.org' },
    { label: 'Robinhood', id: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com' },
];
exports.default = exports.RPCS;
//# sourceMappingURL=consts.js.map