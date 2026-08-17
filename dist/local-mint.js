"use strict";
// Public-mint execution with no OpenSea in the loop.
//
// Because the calldata is known ahead of time (see seadrop-public.ts), every
// transaction can be signed and serialised *before* the stage opens. At T-0 the
// only work left is writing bytes to sockets — no API poll, no signing, no
// encoding. That is strictly faster than the OpenSea path, which cannot sign
// until the API hands over calldata roughly a second after the stage starts.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.localPublicSnipe = localPublicSnipe;
const chalk_1 = __importDefault(require("chalk"));
const perf_hooks_1 = require("perf_hooks");
const ethers_1 = require("ethers");
const rpc_blast_1 = require("./rpc-blast");
const connection_warmer_1 = require("./connection-warmer");
const timer_1 = require("./timer");
const chains_1 = require("./chains");
async function localPublicSnipe(opts) {
    const { nftContract, quantity, walletKeys, rpcUrls, maxFeePerGas, maxPriorityFee, gasLimit, targetStart, plan, } = opts;
    const provider = new ethers_1.JsonRpcProvider(rpcUrls[0]);
    const endpoints = (0, rpc_blast_1.parseRpcEndpoints)(rpcUrls);
    const wallets = walletKeys.map((k) => new ethers_1.Wallet(k, provider));
    console.log(chalk_1.default.bold.magenta("\n── LOCAL PUBLIC MINT (no OpenSea) ──"));
    console.log(chalk_1.default.gray(`  SeaDrop:       ${plan.to}`));
    console.log(chalk_1.default.gray(`  NFT:           ${nftContract}`));
    console.log(chalk_1.default.gray(`  Fee recipient: ${plan.feeRecipient}`));
    console.log(chalk_1.default.gray(`  Price:         ${(0, ethers_1.formatEther)(plan.drop.mintPrice)} × ${quantity} = ${(0, ethers_1.formatEther)(plan.value)} per wallet`));
    console.log(chalk_1.default.gray(`  Calldata:      ${(plan.data.length - 2) / 2} bytes (identical for every wallet)`));
    // ── Warm sockets and pre-fetch everything the signature depends on ──
    await (0, connection_warmer_1.warmConnections)(rpcUrls);
    const [nonces, network] = await Promise.all([
        Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending"))),
        provider.getNetwork(),
    ]);
    const chainId = network.chainId;
    console.log(chalk_1.default.gray(`  Nonces: [${nonces.join(", ")}] | chainId: ${chainId}`));
    // ── Sign everything now, well before the stage opens ──
    const signStart = perf_hooks_1.performance.now();
    const prepared = [];
    for (let i = 0; i < wallets.length; i++) {
        const rawTx = await wallets[i].signTransaction({
            to: plan.to,
            data: plan.data,
            value: plan.value,
            nonce: nonces[i],
            maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFee,
            gasLimit: gasLimit || 250_000,
            type: 2,
            chainId,
        });
        prepared.push({ idx: i, address: wallets[i].address, blast: (0, rpc_blast_1.prepareBlast)(rawTx) });
    }
    console.log(chalk_1.default.green(`  ✓ ${prepared.length} tx(s) signed and serialised in ${(perf_hooks_1.performance.now() - signStart).toFixed(1)}ms — nothing left to compute at fire time`));
    // ── Wait for the stage, then blast pre-built bytes ──
    if (targetStart) {
        await (0, timer_1.waitForMintTime)(targetStart, 0);
    }
    else {
        console.log(chalk_1.default.bold.yellow("\n  🚀 Firing immediately..."));
    }
    const stageStartMs = targetStart ? targetStart.getTime() : Date.now();
    const dispatchStart = perf_hooks_1.performance.now();
    const fired = prepared.map(({ idx, address, blast }) => {
        const { txHash, responsePromise } = (0, rpc_blast_1.blastToAll)(blast, endpoints);
        return { idx, address, txHash, responsePromise };
    });
    const dispatchMs = (perf_hooks_1.performance.now() - dispatchStart).toFixed(2);
    const sinceStage = Math.max(0, Date.now() - stageStartMs);
    console.log(chalk_1.default.bold.green(`  DISPATCHED ${fired.length} tx(s) (${dispatchMs}ms, +${sinceStage}ms after stage)`));
    for (const f of fired) {
        console.log(chalk_1.default.gray(`    [W${f.idx}] ${f.txHash}`));
    }
    // Dispatch only means "bytes written". Find out whether any endpoint actually
    // took the transaction before promising a receipt that may never exist.
    const settled = await Promise.all(fired.map(async (f) => ({ ...f, results: await f.responsePromise })));
    const accepted = settled.filter(({ results }) => results.some((r) => r.txHash !== null || (r.error ?? "").includes("already known")));
    const rejected = settled.filter((s) => !accepted.includes(s));
    for (const { idx, results } of rejected) {
        const reasons = [...new Set(results.map((r) => r.error).filter(Boolean))];
        console.log(chalk_1.default.bold.red(`\n  ✗ [W${idx}] REJECTED by every RPC — never broadcast.`));
        for (const reason of reasons)
            console.log(chalk_1.default.red(`      ${reason}`));
        if (reasons.some((r) => (r ?? "").includes("less than block base fee"))) {
            console.log(chalk_1.default.yellow("      → Your max fee is under the chain's base fee. Raise it and re-run."));
        }
    }
    if (accepted.length === 0) {
        console.log(chalk_1.default.bold.red("\n===== NOTHING WAS BROADCAST — no receipts to wait for =====\n"));
        return;
    }
    // ── Receipts (only for txs an endpoint actually accepted) ──
    console.log(chalk_1.default.gray("\n  Waiting for receipts..."));
    const receiptResults = await Promise.all(accepted.map(async ({ idx, txHash }) => {
        const receipt = await (0, rpc_blast_1.waitForReceipt)(txHash, rpcUrls[0], 60_000);
        if (!receipt) {
            console.log(chalk_1.default.yellow(`  [W${idx}] TIMEOUT — check: ${(0, chains_1.explorerTx)(chainId, txHash)}`));
            return { ok: false, reason: `Timed out waiting for receipt: ${txHash}` };
        }
        const color = receipt.status === "SUCCESS" ? chalk_1.default.bold.green : chalk_1.default.bold.red;
        console.log(color(`  [W${idx}] Block: ${receipt.block} | Pos: ${receipt.position} | ${receipt.status} | Gas: ${receipt.gasUsed}`));
        console.log(chalk_1.default.gray(`  [W${idx}] Track: ${(0, chains_1.explorerTx)(chainId, txHash)}`));
        return {
            ok: receipt.status === "SUCCESS",
            reason: receipt.status === "SUCCESS" ? null : `Transaction reverted: ${txHash}`,
        };
    }));
    const failedReceipt = receiptResults.find((result) => !result.ok);
    if (failedReceipt) {
        throw new Error(failedReceipt.reason || "Mint transaction failed");
    }
    console.log(chalk_1.default.bold.white("\n===== LOCAL PUBLIC MINT COMPLETE ====="));
}
//# sourceMappingURL=local-mint.js.map