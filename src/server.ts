import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { Wallet } from "ethers";
import { buildLocalMintPlan, LocalMintPlan, fetchPublicDrop, preflightMint } from "./seadrop-public";
import { localPublicSnipe, LocalSnipeOpts } from "./local-mint";
import { RPCS, RpcEntry } from "./consts";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const app = express();
const PORT = Number(process.env.PORT || 3003);

app.use(cors());
app.use(express.json());

const builtUiRoot = path.resolve(process.cwd(), "dist-web");
const publicRoot = fs.existsSync(path.join(builtUiRoot, "index.html"))
  ? builtUiRoot
  : path.resolve(process.cwd(), "public");
app.use(express.static(publicRoot));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicRoot, "index.html"));
});

function gweiToWei(g: number): bigint {
  return BigInt(Math.round(g * 1e9));
}

function parseUtcFireTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = hasTimezone ? raw : `${raw}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid Fire time. Use UTC, for example 2026-08-17T12:00:00Z");
  }
  return date;
}

let nextJob = 1;
type JobStatus = "queued" | "running" | "completed" | "failed";

interface JobRecord {
  jobId: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  logs: string[];
  usedRpc: string;
  rpcId: number;
  nftContract: string;
  quantity: number;
}

const jobs: Record<string, JobRecord> = {};

function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack || arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ")
    .replace(/\u001b\[[0-9;]*m/g, "");
}

function updateJob(jobId: string, patch: Partial<JobRecord>): JobRecord {
  const current = jobs[jobId];
  if (!current) throw new Error(`Unknown job ${jobId}`);
  jobs[jobId] = { ...current, ...patch, updatedAt: Date.now() };
  return jobs[jobId];
}

function appendJobLog(jobId: string, ...args: unknown[]): void {
  const current = jobs[jobId];
  if (!current) return;
  const line = formatLogArgs(args);
  const logs = [...current.logs, ...line.split("\n")].slice(-500);
  updateJob(jobId, { logs });
}

async function captureJobLogs<T>(jobId: string, run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => appendJobLog(jobId, ...args);
  console.error = (...args: unknown[]) => appendJobLog(jobId, ...args);

  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function privateKeyFromEnv(): string | null {
  const raw = process.env.PRIVATE_KEY || process.env.PRIVATE_KEY_1 || process.env.PRIVATE_KEY_MAIN;
  if (!raw) return null;
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function walletFromEnv(): Wallet | null {
  const privateKey = privateKeyFromEnv();
  if (!privateKey) return null;
  return new Wallet(privateKey);
}

function rpcById(id: unknown): RpcEntry | null {
  if (id === null || id === undefined || id === "") return null;
  return RPCS.find((rpc) => String(rpc.id) === String(id)) ?? null;
}

app.get("/api/rpcs", (_req, res) => {
  res.json(RPCS.map(({ label, id }) => ({ label, id })));
});

app.post("/api/mint", async (req, res) => {
  try {
    const body = req.body as any;
    const nftContract: string = body.nftContract;
    const quantity: number = Number(body.quantity || 1);
    const rpc = rpcById(body.rpcId);
    const maxFeeGwei: number = body.maxFeeGwei ?? 0;
    const maxPriorityGwei: number = body.maxPriorityGwei ?? 0;
    const gasLimit: number = Number(body.gasLimit || 250000);
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

    let plan: LocalMintPlan | null = null;
    try {
      plan = await buildLocalMintPlan(rpc.rpc, nftContract, quantity);
    } catch {
      plan = null;
    }
    if (!plan) return res.status(400).json({ error: "No public SeaDrop stage readable from selected RPC", rpcId: rpc.id });

    const preflight = await preflightMint(rpc.rpc, nftContract, wallet.address, plan, quantity);
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
      const opts: LocalSnipeOpts = {
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
        await captureJobLogs(jobId, () => localPublicSnipe(opts));
        updateJob(jobId, { status: "completed", completedAt: Date.now() });
      } catch (err: any) {
        const message = err?.message ?? String(err);
        appendJobLog(jobId, "Job error:", message);
        updateJob(jobId, { status: "failed", completedAt: Date.now(), error: message });
      }
    })();

    return res.status(202).json(jobs[jobId]);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// Diagnostic helper: check the selected RPC for a readable public drop.
app.post('/api/diagnose', async (req, res) => {
  try {
    const body = req.body as any;
    const nftContract: string = body.nftContract;
    const rpc = rpcById(body.rpcId);

    if (!nftContract) return res.status(400).json({ error: 'Missing nftContract' });
    if (!rpc) return res.status(400).json({ error: 'Missing or unknown rpcId' });

    try {
      const drop = await fetchPublicDrop(rpc.rpc, nftContract);
      let preflight = null;
      const wallet = walletFromEnv();
      if (drop && wallet) {
        const plan = await buildLocalMintPlan(rpc.rpc, nftContract, Number(body.quantity || 1));
        preflight = plan ? await preflightMint(rpc.rpc, nftContract, wallet.address, plan, Number(body.quantity || 1)) : null;
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
    } catch (e: any) {
      return res.json({
        nftContract,
        result: { label: rpc.label, id: rpc.id, url: rpc.rpc, ok: false, error: e?.message ?? String(e) },
      });
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const id = req.params.id;
  const j = jobs[id];
  if (!j) return res.status(404).json({ error: "unknown job" });
  res.json(j);
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicRoot, "index.html"));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Web UI listening on http://localhost:${PORT}`);
});

export {};
