import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
} from "ethers";
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

function parsePrivateKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const key = raw.trim();
    if (!key) continue;
    const normalized = key.startsWith("0x") ? key : `0x${key}`;
    try {
      keys.push(new Wallet(normalized).privateKey);
    } catch {
      throw new Error("Private key file contains an invalid key.");
    }
  }
  return [...new Set(keys)];
}

function walletsFromKeys(keys: string[]): Wallet[] {
  return keys.map((key) => new Wallet(key));
}

function rpcById(id: unknown): RpcEntry | null {
  if (id === null || id === undefined || id === "") return null;
  return RPCS.find((rpc) => String(rpc.id) === String(id)) ?? null;
}

const TOKEN_BUY_CHAINS = [
  {
    key: "ethereum",
    label: "Ethereum",
    chainId: 1,
    rpc: "https://ethereum-rpc.publicnode.com",
    nativeSymbol: "ETH",
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    defaultRouter: process.env.ETHEREUM_ROUTER || "",
  },
  {
    key: "base",
    label: "Base",
    chainId: 8453,
    rpc: "https://mainnet.base.org",
    nativeSymbol: "ETH",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    defaultRouter: process.env.BASE_ROUTER || "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  },
  {
    key: "robinhood",
    label: "Robinhood",
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    nativeSymbol: "ETH",
    wrappedNative: process.env.ROBINHOOD_WRAPPED_NATIVE || "",
    defaultRouter: process.env.ROBINHOOD_ROUTER || "",
  },
  {
    key: "bsc",
    label: "BSC",
    chainId: 56,
    rpc: "https://bsc-rpc.publicnode.com",
    nativeSymbol: "BNB",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    defaultRouter: process.env.BSC_ROUTER || "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  },
] as const;

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

function tokenBuyChainById(chainId: unknown): (typeof TOKEN_BUY_CHAINS)[number] | null {
  if (chainId === null || chainId === undefined || chainId === "") return null;
  const normalized = Number(chainId);
  return TOKEN_BUY_CHAINS.find((chain) => chain.chainId === normalized) ?? null;
}

function getTokenBuyRpc(chainId: number): string {
  return tokenBuyChainById(chainId)?.rpc ?? "https://ethereum-rpc.publicnode.com";
}

async function getTokenMetadata(provider: JsonRpcProvider, tokenAddress: string) {
  const token = new Contract(tokenAddress, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => "TOKEN"),
    token.decimals().catch(() => 18),
  ]);
  return { symbol, decimals: Number(decimals) };
}

async function quoteTokenBuy({ chainId, tokenAddress, buyAmount }: {
  chainId: number;
  tokenAddress: string;
  buyAmount: string;
}) {
  const chain = tokenBuyChainById(chainId);
  if (!chain) throw new Error("Unsupported chain selected.");

  const cleanedToken = tokenAddress.trim();
  const cleanedRouter = chain.defaultRouter.trim();
  if (!cleanedRouter) throw new Error(`No router configured for ${chain.label}. Set ${chain.key.toUpperCase()}_ROUTER in .env.`);
  if (!chain.wrappedNative) throw new Error(`No wrapped native token configured for ${chain.label}. Set ${chain.key.toUpperCase()}_WRAPPED_NATIVE in .env.`);

  const provider = new JsonRpcProvider(chain.rpc);
  const tokenMeta = await getTokenMetadata(provider, cleanedToken);
  const adjustedAmount = parseUnits(buyAmount, tokenMeta.decimals);
  const router = new Contract(cleanedRouter, ROUTER_ABI, provider);

  const path = [chain.wrappedNative, cleanedToken];
  const amountsIn = await router.getAmountsIn(adjustedAmount, path);
  const requiredNative = amountsIn[0];
  const requiredNativeEth = formatEther(requiredNative);

  return {
    ok: true,
    chainId: chain.chainId,
    tokenAddress: cleanedToken,
    tokenSymbol: tokenMeta.symbol,
    tokenDecimals: tokenMeta.decimals,
    buyAmount: buyAmount,
    nativeSymbol: chain.nativeSymbol,
    requiredNative: requiredNativeEth,
    routerAddress: cleanedRouter,
    estimatedCostUsd: "N/A",
  };
}

async function executeTokenBuy({ chainId, tokenAddress, buyAmount, routerAddress, slippageBps, privateKeys }: {
  chainId: number;
  tokenAddress: string;
  buyAmount: string;
  routerAddress?: string;
  slippageBps: number;
  privateKeys: string[];
}) {
  const wallets = walletsFromKeys(privateKeys);
  if (wallets.length === 0) throw new Error("Upload a .txt file with at least one private key.");

  const chain = tokenBuyChainById(chainId);
  if (!chain) throw new Error("Unsupported chain selected.");
  const cleanedRouter = (routerAddress || chain.defaultRouter || "").trim();
  if (!cleanedRouter) throw new Error(`No router configured for ${chain.label}. Set ${chain.key.toUpperCase()}_ROUTER in .env.`);
  if (!chain.wrappedNative) throw new Error(`No wrapped native token configured for ${chain.label}. Set ${chain.key.toUpperCase()}_WRAPPED_NATIVE in .env.`);

  const provider = new JsonRpcProvider(chain.rpc);
  const results = await Promise.all(wallets.map(async (wallet) => {
  const signer = wallet.connect(provider);
  const tokenMeta = await getTokenMetadata(provider, tokenAddress.trim());
  const tokenAmount = parseUnits(buyAmount, tokenMeta.decimals);
  const router = new Contract(cleanedRouter, ROUTER_ABI, signer);

  const path = [chain.wrappedNative, tokenAddress.trim()];
  const amountsIn = await router.getAmountsIn(tokenAmount, path);
  const requiredNative = amountsIn[0];
  const slippageFactor = BigInt(10000 - slippageBps);

  const deadline = Math.floor(Date.now() / 1000) + 600;
  const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
    0n,
    path,
    signer.address,
    deadline,
    { value: requiredNative }
  );

  const receipt = await tx.wait();

  return {
    ok: true,
    chainId: chain.chainId,
    tokenAddress: tokenAddress.trim(),
    tokenSymbol: tokenMeta.symbol,
    tokenDecimals: tokenMeta.decimals,
    buyAmount,
    nativeSymbol: chain.nativeSymbol,
    requiredNative: formatEther(requiredNative),
    routerAddress: cleanedRouter,
    approved: false,
    hash: receipt?.hash ?? tx.hash,
    walletAddress: signer.address,
  };
  }));
  return { ok: true, chainId: chain.chainId, tokenAddress: tokenAddress.trim(), buyAmount, nativeSymbol: chain.nativeSymbol, routerAddress: cleanedRouter, approved: false, results };
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
    const privateKeys = parsePrivateKeys(body.privateKeys);
    if (privateKeys.length === 0) return res.status(400).json({ error: "Upload a .txt file with at least one private key." });
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

    const wallets = walletsFromKeys(privateKeys);
    const preflights = await Promise.all(wallets.map((wallet) => preflightMint(rpc.rpc, nftContract, wallet.address, plan!, quantity)));
    const preflight = preflights.find((item) => !item.ok) || preflights[0];
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
        walletKeys: privateKeys,
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
      const privateKeys = parsePrivateKeys(body.privateKeys);
      const wallet = privateKeys[0] ? new Wallet(privateKeys[0]) : null;
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

app.get("/api/token-buy/chains", (_req, res) => {
  res.json(
    TOKEN_BUY_CHAINS.map((chain) => ({
      key: chain.key,
      label: chain.label,
      chainId: chain.chainId,
      rpc: chain.rpc,
      nativeSymbol: chain.nativeSymbol,
      wrappedNative: chain.wrappedNative,
      defaultRouter: chain.defaultRouter,
    }))
  );
});

app.post("/api/token-buy/quote", async (req, res) => {
  try {
    const body = req.body as any;
    const chainId = Number(body.chainId ?? 1);
    const tokenAddress = String(body.tokenAddress || "").trim();
    const buyAmount = String(body.buyAmount || "0");

    if (!tokenAddress) {
      return res.status(400).json({ ok: false, error: "Missing tokenAddress" });
    }
    if (!buyAmount || Number(buyAmount) <= 0) {
      return res.status(400).json({ ok: false, error: "buyAmount must be > 0" });
    }

    const result = await quoteTokenBuy({ chainId, tokenAddress, buyAmount });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err) });
  }
});

app.post("/api/token-buy", async (req, res) => {
  try {
    const body = req.body as any;
    const chainId = Number(body.chainId ?? 1);
    const tokenAddress = String(body.tokenAddress || "").trim();
    const buyAmount = String(body.buyAmount || "0");
    const slippageBps = Number(body.slippageBps ?? 200);
    const privateKeys = parsePrivateKeys(body.privateKeys);

    if (!tokenAddress) {
      return res.status(400).json({ ok: false, error: "Missing tokenAddress" });
    }
    if (!buyAmount || Number(buyAmount) <= 0) {
      return res.status(400).json({ ok: false, error: "buyAmount must be > 0" });
    }

    const result = await executeTokenBuy({ chainId, tokenAddress, buyAmount, slippageBps, privateKeys });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err) });
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
