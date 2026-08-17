"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.warmConnections = warmConnections;
const chalk_1 = __importDefault(require("chalk"));
// Pre-establish TCP/TLS to every RPC so the first real request doesn't pay for
// a handshake. Some endpoints (Base's sequencer, for one) only accept send
// methods, so we warm with eth_sendRawTransaction and ignore the error — the
// handshake is the point, not the response.
async function warmConnections(rpcUrls) {
    console.log(chalk_1.default.gray("  Warming connections..."));
    await Promise.all(rpcUrls.map((url) => fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_sendRawTransaction",
            params: ["0x00"],
            id: 1,
        }),
    })
        .then(() => { })
        .catch(() => { })));
    console.log(chalk_1.default.green("  Connections hot."));
}
//# sourceMappingURL=connection-warmer.js.map