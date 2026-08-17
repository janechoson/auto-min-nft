"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ethers_1 = require("ethers");
const seadrop_public_1 = require("./seadrop-public");
const local_mint_1 = require("./local-mint");
const consts_1 = require("./consts");
dotenv_1.default.config({ path: path_1.default.resolve(process.cwd(), ".env") });
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT || 3003);
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const builtUiRoot = path_1.default.resolve(process.cwd(), "dist-web");
const publicRoot = fs_1.default.existsSync(path_1.default.join(builtUiRoot, "index.html"))
    ? builtUiRoot
    : path_1.default.resolve(process.cwd(), "public");
app.use(express_1.default.static(publicRoot));
app.get("/", (_req, res) => {
    res.sendFile(path_1.default.join(publicRoot, "index.html"));
});
function gweiToWei(g) {
    return BigInt(Math.round(g * 1e9));
}
function parseUtcFireTime(value) {
    if (typeof value !== "string")
        return null;
    const raw = value.trim();
    if (!raw)
        return null;
    const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
    const normalized = hasTimezone ? raw : `${raw}Z`;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
        throw new Error("Invalid Fire time. Use UTC, for example 2026-08-17T12:00:00Z");
    }
    return date;
}
let nextJob = 1;
const jobs = {};
function formatLogArgs(args) {
    return args
        .map((arg) => {
        if (typeof arg === "string")
            return arg;
        if (arg instanceof Error)
            return arg.stack || arg.message;
        try {
            return JSON.stringify(arg);
        }
        catch {
            return String(arg);
        }
    })
        .join(" ")
        .replace(/\u001b\[[0-9;]*m/g, "");
}
function updateJob(jobId, patch) {
    const current = jobs[jobId];
    if (!current)
        throw new Error(`Unknown job ${jobId}`);
    jobs[jobId] = { ...current, ...patch, updatedAt: Date.now() };
    return jobs[jobId];
}
function appendJobLog(jobId, ...args) {
    const current = jobs[jobId];
    if (!current)
        return;
    const line = formatLogArgs(args);
    const logs = [...current.logs, ...line.split("\n")].slice(-500);
    updateJob(jobId, { logs });
}
async function captureJobLogs(jobId, run) {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => appendJobLog(jobId, ...args);
    console.error = (...args) => appendJobLog(jobId, ...args);
    try {
        return await run();
    }
    finally {
        console.log = originalLog;
        console.error = originalError;
    }
}
function privateKeyFromEnv() {
    const raw = process.env.PRIVATE_KEY || process.env.PRIVATE_KEY_1 || process.env.PRIVATE_KEY_MAIN;
    if (!raw)
        return null;
    return raw.startsWith("0x") ? raw : `0x${raw}`;
}
function walletFromEnv() {
    const privateKey = privateKeyFromEnv();
    if (!privateKey)
        return null;
    return new ethers_1.Wallet(privateKey);
}
function rpcById(id) {
    if (id === null || id === undefined || id === "")
        return null;
    return consts_1.RPCS.find((rpc) => String(rpc.id) === String(id)) ?? null;
}
app.get("/api/rpcs", (_req, res) => {
    res.json(consts_1.RPCS.map(({ label, id }) => ({ label, id })));
});
app.post("/api/mint", async (req, res) => {
    try {
        const body = req.body;
        const nftContract = body.nftContract;
        const quantity = Number(body.quantity || 1);
        const rpc = rpcById(body.rpcId);
        const maxFeeGwei = body.maxFeeGwei ?? 0;
        const maxPriorityGwei = body.maxPriorityGwei ?? 0;
        const gasLimit = Number(body.gasLimit || 250000);
        const targetStart = parseUtcFireTime(body.targetStart);
        const wallet = walletFromEnv();
        if (!wallet) {
            return res.status(400).json({ error: "Server missing PRIVATE_KEY env variable; configure PRIVATE_KEY in .env" });
        }
        if (!nftContract) {
            return res.status(400).json({ error: "Missing required field: nftContract" });
        }
        if (!rpc) {
            return res.status(400).json({ error: "Missing or unknown rpcId" });
        }
        const rpcUrls = [rpc.rpc];
        let plan = null;
        try {
            plan = await (0, seadrop_public_1.buildLocalMintPlan)(rpc.rpc, nftContract, quantity);
        }
        catch {
            plan = null;
        }
        if (!plan)
            return res.status(400).json({ error: "No public SeaDrop stage readable from selected RPC", rpcId: rpc.id });
        const preflight = await (0, seadrop_public_1.preflightMint)(rpc.rpc, nftContract, wallet.address, plan, quantity);
        if (!preflight.ok) {
            return res.status(400).json({
                error: preflight.reason || "Mint simulation reverted.",
                preflight,
            });
        }
        const jobId = String(nextJob++);
        jobs[jobId] = {
            jobId,
            status: "queued",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            startedAt: null,
            completedAt: null,
            error: null,
            logs: ["Job queued."],
            usedRpc: rpc.rpc,
            rpcId: rpc.id,
            nftContract,
            quantity,
        };
        // Start the snipe asynchronously
        (async () => {
            updateJob(jobId, { status: "running", startedAt: Date.now() });
            const opts = {
                nftContract,
                quantity,
                walletKeys: [wallet.privateKey],
                rpcUrls,
                maxFeePerGas: gweiToWei(Number(maxFeeGwei)),
                maxPriorityFee: gweiToWei(Number(maxPriorityGwei)),
                gasLimit,
                targetStart,
                plan,
            };
            try {
                await captureJobLogs(jobId, () => (0, local_mint_1.localPublicSnipe)(opts));
                updateJob(jobId, { status: "completed", completedAt: Date.now() });
            }
            catch (err) {
                const message = err?.message ?? String(err);
                appendJobLog(jobId, "Job error:", message);
                updateJob(jobId, { status: "failed", completedAt: Date.now(), error: message });
            }
        })();
        return res.status(202).json(jobs[jobId]);
    }
    catch (err) {
        return res.status(500).json({ error: err?.message ?? String(err) });
    }
});
// Diagnostic helper: check the selected RPC for a readable public drop.
app.post('/api/diagnose', async (req, res) => {
    try {
        const body = req.body;
        const nftContract = body.nftContract;
        const rpc = rpcById(body.rpcId);
        if (!nftContract)
            return res.status(400).json({ error: 'Missing nftContract' });
        if (!rpc)
            return res.status(400).json({ error: 'Missing or unknown rpcId' });
        try {
            const drop = await (0, seadrop_public_1.fetchPublicDrop)(rpc.rpc, nftContract);
            let preflight = null;
            const wallet = walletFromEnv();
            if (drop && wallet) {
                const plan = await (0, seadrop_public_1.buildLocalMintPlan)(rpc.rpc, nftContract, Number(body.quantity || 1));
                preflight = plan ? await (0, seadrop_public_1.preflightMint)(rpc.rpc, nftContract, wallet.address, plan, Number(body.quantity || 1)) : null;
            }
            return res.json({
                nftContract,
                result: {
                    label: rpc.label,
                    id: rpc.id,
                    url: rpc.rpc,
                    ok: !!drop,
                    drop: drop ? { startTime: drop.startTime, endTime: drop.endTime, mintPrice: String(drop.mintPrice) } : null,
                    preflight,
                },
            });
        }
        catch (e) {
            return res.json({
                nftContract,
                result: { label: rpc.label, id: rpc.id, url: rpc.rpc, ok: false, error: e?.message ?? String(e) },
            });
        }
    }
    catch (e) {
        res.status(500).json({ error: e?.message ?? String(e) });
    }
});
app.get("/api/jobs/:id", (req, res) => {
    const id = req.params.id;
    const j = jobs[id];
    if (!j)
        return res.status(404).json({ error: "unknown job" });
    res.json(j);
});
app.get("*", (_req, res) => {
    res.sendFile(path_1.default.join(publicRoot, "index.html"));
});
app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Web UI listening on http://localhost:${PORT}`);
});
//# sourceMappingURL=server.js.map