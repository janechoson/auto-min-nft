"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRpcEndpoints = parseRpcEndpoints;
exports.prepareBlast = prepareBlast;
exports.blastToAll = blastToAll;
exports.waitForReceipt = waitForReceipt;
const chalk_1 = __importDefault(require("chalk"));
const ethers_1 = require("ethers");
// Parse RPC URLs and assign labels
function parseRpcEndpoints(rpcUrls) {
    return rpcUrls.map((url, i) => ({
        url,
        label: labelFromUrl(url, i),
    }));
}
function labelFromUrl(url, index) {
    const lower = url.toLowerCase();
    if (lower.includes("sequencer.base.org"))
        return "mainnet-sequencer.base.org";
    if (lower.includes("sequencer.mainnet.chain.robinhood.com"))
        return "robinhood-sequencer";
    if (lower.includes("rpc.mainnet.chain.robinhood.com"))
        return "robinhood-public";
    if (lower.includes("alchemy"))
        return "ALCHEMY";
    if (lower.includes("flashbots"))
        return "FLASHBOTS-PROTECT";
    if (lower.includes("llamarpc")) {
        // llamarpc serves several networks — keep the host so the label stays honest
        try {
            return new URL(url).hostname;
        }
        catch {
            return "llamarpc";
        }
    }
    if (lower.includes("quicknode"))
        return "QUICKNODE";
    if (lower.includes("infura"))
        return "INFURA";
    if (lower.includes("ankr"))
        return "ANKR";
    if (lower.includes("publicnode"))
        return "PUBLICNODE";
    if (lower.includes("cloudflare"))
        return "CLOUDFLARE";
    try {
        const hostname = new URL(url).hostname;
        return hostname;
    }
    catch {
        return `RPC[${index}]`;
    }
}
// Call this BEFORE the fire moment (after signing) — does all compute work upfront
function prepareBlast(rawTx) {
    return {
        txHash: (0, ethers_1.keccak256)(rawTx),
        body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_sendRawTransaction",
            params: [rawTx],
            id: 1,
        }),
    };
}
// Blast a raw signed tx to all RPC endpoints simultaneously — FIRE AND FORGET
// Returns immediately after initiating fetch calls (sub-ms dispatch)
// Responses are collected via the returned promise for logging later
function blastToAll(rawTxOrPrepared, endpoints) {
    const prepared = typeof rawTxOrPrepared === "string"
        ? prepareBlast(rawTxOrPrepared)
        : rawTxOrPrepared;
    const { txHash, body } = prepared;
    // Fire ALL requests — these are initiated immediately (non-blocking)
    const firePromises = endpoints.map((ep) => fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
    }));
    // Collect responses asynchronously — caller awaits this AFTER printing dispatch time
    const responsePromise = Promise.allSettled(firePromises).then(async (settled) => {
        const results = [];
        for (let i = 0; i < settled.length; i++) {
            const ep = endpoints[i];
            const s = settled[i];
            if (s.status === "fulfilled") {
                try {
                    const json = (await s.value.json());
                    if (json.result) {
                        console.log(chalk_1.default.green(`  [${i}] ${ep.label}  TX: ${json.result}`));
                        results.push({ label: ep.label, txHash: json.result, error: null });
                    }
                    else if (json.error) {
                        const errMsg = json.error.message || JSON.stringify(json.error);
                        if (errMsg.includes("already known") || errMsg.includes("already exists")) {
                            console.log(chalk_1.default.yellow(`  [${i}] ${ep.label}  ERR: already known`));
                        }
                        else {
                            console.log(chalk_1.default.red(`  [${i}] ${ep.label}  ERR: ${errMsg}`));
                        }
                        results.push({ label: ep.label, txHash: null, error: errMsg });
                    }
                }
                catch (err) {
                    console.log(chalk_1.default.red(`  [${i}] ${ep.label}  ERR: ${err.message}`));
                    results.push({ label: ep.label, txHash: null, error: err.message });
                }
            }
            else {
                console.log(chalk_1.default.red(`  [${i}] ${ep.label}  ERR: ${s.reason?.message || s.reason}`));
                results.push({ label: ep.label, txHash: null, error: s.reason?.message || String(s.reason) });
            }
        }
        return results;
    });
    // Return IMMEDIATELY — txHash computed locally, fetches already in flight
    return { txHash, responsePromise };
}
// Wait for tx receipt and return block info
async function waitForReceipt(txHash, rpcUrl, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(rpcUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    method: "eth_getTransactionReceipt",
                    params: [txHash],
                    id: 1,
                }),
            });
            const json = (await res.json());
            const receipt = json.result;
            if (receipt) {
                return {
                    block: parseInt(receipt.blockNumber, 16),
                    position: parseInt(receipt.transactionIndex, 16),
                    gasUsed: parseInt(receipt.gasUsed, 16),
                    status: receipt.status === "0x1" ? "SUCCESS" : "REVERTED",
                };
            }
        }
        catch { }
        await new Promise((r) => setTimeout(r, 500));
    }
    return null;
}
//# sourceMappingURL=rpc-blast.js.map