"use strict";
// Interactive public-mint wizard.
//
// Every transaction here is built from on-chain SeaDrop state — price, fee
// recipient and per-wallet cap all come from the contract — so no OpenSea
// account, token or API key is involved in the mint itself.
//
// Nothing is written to disk: pasted keys live in memory for the run only.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWizard = runWizard;
const chalk_1 = __importDefault(require("chalk"));
const ethers_1 = require("ethers");
const chains_1 = require("./chains");
const nft_link_1 = require("./nft-link");
const slug_resolver_1 = require("./slug-resolver");
const rpc_resolver_1 = require("./rpc-resolver");
const rpc_blast_1 = require("./rpc-blast");
const seadrop_public_1 = require("./seadrop-public");
const local_mint_1 = require("./local-mint");
const time_format_1 = require("./time-format");
const prompt_1 = require("./prompt");
async function runWizard() {
    printBanner();
    // ── 1. Private keys ───────────────────────────────────────────────────
    const walletKeys = await promptKeys();
    // ── 2. Chain ──────────────────────────────────────────────────────────
    let chainKey = await (0, prompt_1.askChoice)("Which chain?", chains_1.CHAINS.map((c) => ({ label: c.name, value: c.key, hint: `chain id ${c.chainId}` })), Math.max(0, chains_1.CHAINS.findIndex((c) => c.key === (process.env.CHAIN || "base").toLowerCase())));
    // ── 3. Quantity ───────────────────────────────────────────────────────
    const quantity = await promptQuantity(walletKeys.length);
    // ── 4. NFT link ───────────────────────────────────────────────────────
    const target = await promptTarget(chainKey);
    const nftContract = target.contract;
    chainKey = target.chainKey;
    const chainProfile = (0, chains_1.resolveChain)(chainKey);
    // ── 5. RPC endpoints ──────────────────────────────────────────────────
    const manualRpcs = await promptRpc(chainProfile);
    const { urls: candidateRpcs, source } = (0, rpc_resolver_1.resolveRpcsForChain)(chainKey, manualRpcs);
    console.log(chalk_1.default.gray(`  Source: ${source}`));
    console.log(chalk_1.default.gray(`  Checking ${candidateRpcs.length} endpoint(s)...`));
    const plan = await (0, rpc_resolver_1.planRpcs)(candidateRpcs, chainProfile.chainId);
    for (const bad of plan.dropped) {
        const wrong = (0, chains_1.resolveChain)(bad.chainId);
        console.log(chalk_1.default.red(`    ✗ ${labelOf(bad.url)} is chain ${bad.chainId}${wrong ? ` (${wrong.name})` : ""} — dropped`));
    }
    for (const ep of (0, rpc_blast_1.parseRpcEndpoints)(plan.urls)) {
        const failure = plan.failures.find((f) => f.url === ep.url);
        if (failure) {
            const benign = /not allowed|does not exist|not supported|method not found/i.test(failure.message);
            console.log(benign
                ? chalk_1.default.gray(`    • ${ep.label}  (send-only)`)
                : chalk_1.default.yellow(`    ⚠ ${ep.label}  ${failure.message.slice(0, 90)}`));
        }
        else {
            console.log(chalk_1.default.green(`    ✓ ${ep.label}`));
        }
    }
    if (plan.urls.length === 0) {
        throw new Error(`No usable RPC endpoint for ${chainProfile.name}`);
    }
    if (!plan.verified) {
        console.log(chalk_1.default.yellow(`  ⚠ No endpoint confirmed chain id ${chainProfile.chainId}.`));
        if (!(await (0, prompt_1.askYesNo)("Continue anyway?", false))) {
            throw new Error("Aborted — could not verify the RPC chain");
        }
    }
    else {
        console.log(chalk_1.default.green(`  ✓ Confirmed chain id ${chainProfile.chainId} (${chainProfile.name})`));
    }
    const rpcUrls = plan.urls;
    // ── 6. Read the public drop from chain ────────────────────────────────
    console.log(chalk_1.default.bold.white("\nDrop"));
    const mintPlan = await (0, seadrop_public_1.buildLocalMintPlan)(rpcUrls[0], nftContract, quantity);
    if (!mintPlan) {
        throw new Error(`No SeaDrop public drop readable for ${nftContract} on ${chainProfile.name}.\n` +
            "  Either it isn't a SeaDrop collection, or it keeps its drop config on the token contract.");
    }
    const drop = mintPlan.drop;
    const startsAt = new Date(drop.startTime * 1000);
    const endsAt = new Date(drop.endTime * 1000);
    const live = Date.now() >= startsAt.getTime() && Date.now() < endsAt.getTime();
    console.log(chalk_1.default.green("  ✓ Built calldata from on-chain SeaDrop — no OpenSea token needed"));
    console.log(chalk_1.default.gray(`    Fee recipient: ${mintPlan.feeRecipient}`));
    console.log(chalk_1.default.gray(`    Price:         ${(0, ethers_1.formatEther)(drop.mintPrice)} × ${quantity} = ${(0, ethers_1.formatEther)(mintPlan.value)} per wallet`));
    console.log(chalk_1.default.gray(`    Max per wallet: ${drop.maxTotalMintableByWallet || "unlimited"}`));
    console.log(chalk_1.default.gray(`    Window:        ${(0, time_format_1.toIST)(startsAt)} → ${(0, time_format_1.toIST)(endsAt)} IST  ${live ? chalk_1.default.green("(live)") : chalk_1.default.yellow(`(opens in ${formatRemaining(startsAt.getTime() - Date.now())})`)}`));
    if (drop.maxTotalMintableByWallet > 0 && quantity > drop.maxTotalMintableByWallet) {
        console.log(chalk_1.default.yellow(`  ⚠ This drop allows only ${drop.maxTotalMintableByWallet} per wallet — ${quantity} will revert.`));
    }
    if (Date.now() >= endsAt.getTime()) {
        console.log(chalk_1.default.yellow("  ⚠ This public stage has already ended on-chain."));
    }
    // ── 7. Gas ────────────────────────────────────────────────────────────
    const provider = new ethers_1.JsonRpcProvider(rpcUrls[0]);
    console.log(chalk_1.default.bold.white("\nGas"));
    const baseFeeGwei = await currentBaseFeeGwei(provider);
    if (baseFeeGwei !== null) {
        console.log(chalk_1.default.gray(`  Network base fee right now: ${baseFeeGwei.toFixed(6)} gwei`));
    }
    const envMaxFee = Number(process.env.MAX_FEE_PER_GAS || (chainKey === "ethereum" ? 80 : 2));
    const envPriority = Number(process.env.MAX_PRIORITY_FEE || (chainKey === "ethereum" ? 5 : 0.05));
    // A ceiling under the base fee is rejected outright by every node, so it must
    // not be enterable at all.
    let defaultMaxFee = envMaxFee;
    if (baseFeeGwei !== null) {
        const suggested = Math.ceil((baseFeeGwei * 2 + envPriority) * 1000) / 1000;
        if (envMaxFee < baseFeeGwei)
            defaultMaxFee = suggested;
        console.log(chalk_1.default.gray(`  Must be at least ${baseFeeGwei.toFixed(6)} gwei; ${suggested} gives room to spare.`));
    }
    const maxFeeGwei = await (0, prompt_1.askNumber)("Max fee per gas (gwei) — your ceiling", defaultMaxFee, {
        min: baseFeeGwei ?? 0,
    });
    // EIP-1559 caps the tip at the ceiling; ethers refuses to sign otherwise.
    const priorityDefault = Math.min(envPriority, maxFeeGwei);
    const priorityGwei = await (0, prompt_1.askNumber)("Priority fee / tip (gwei)", priorityDefault, {
        min: 0,
        max: maxFeeGwei,
    });
    const maxFeePerGas = gweiToWei(maxFeeGwei);
    const maxPriorityFee = gweiToWei(priorityGwei);
    const gasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;
    // ── 8. Timing ─────────────────────────────────────────────────────────
    const { targetStart, timingLabel } = await promptTiming(drop.startTime);
    // ── 9. Balances + affordability ───────────────────────────────────────
    console.log(chalk_1.default.bold.white("\nWallets"));
    const wallets = walletKeys.map((k) => new ethers_1.Wallet(k));
    const balances = await Promise.all(wallets.map((w) => provider.getBalance(w.address).catch(() => null)));
    const symbol = chainProfile.nativeSymbol;
    // Nodes reserve gasLimit × maxFee + value upfront and reject if the balance
    // falls short, regardless of the far smaller amount actually spent.
    const required = BigInt(gasLimit) * maxFeePerGas + mintPlan.value;
    wallets.forEach((w, i) => {
        const bal = balances[i];
        const text = bal === null ? "balance unavailable" : `${Number((0, ethers_1.formatEther)(bal)).toFixed(6)} ${symbol}`;
        const short = bal !== null && bal < required;
        const line = `  [W${i}] ${w.address}  ${text}`;
        console.log(short ? chalk_1.default.red(`${line}  ✗ needs ${(0, ethers_1.formatEther)(required)}`) : chalk_1.default.gray(line));
    });
    const shortWallets = wallets.filter((_, i) => balances[i] !== null && balances[i] < required);
    if (shortWallets.length > 0) {
        console.log(chalk_1.default.gray(`\n  Nodes require gasLimit × maxFee${mintPlan.value > 0n ? " + mint price" : ""} = ${(0, ethers_1.formatEther)(required)} ${symbol} held per wallet.`));
        const poorest = balances
            .filter((b) => b !== null)
            .reduce((a, b) => (a < b ? a : b));
        const affordable = Number((poorest - mintPlan.value) / BigInt(gasLimit)) / 1e9;
        if (affordable > 0) {
            console.log(chalk_1.default.yellow(`  Either fund the wallets, or re-run with a max fee at or below ${affordable.toFixed(4)} gwei.`));
        }
        if (shortWallets.length === wallets.length) {
            throw new Error("Every wallet is underfunded — nothing could be broadcast.");
        }
        console.log(chalk_1.default.yellow("  The remaining wallet(s) can still fire."));
    }
    // ── 10. Confirm ───────────────────────────────────────────────────────
    console.log(chalk_1.default.bold.white("\n──────── READY ────────"));
    line("Chain", `${chainProfile.name} (${chainProfile.chainId})`);
    line("RPC", `${labelOf(rpcUrls[0])} + ${rpcUrls.length - 1} more`);
    line("Target", target.label);
    line("Contract", nftContract);
    line("Wallets", `${wallets.length}`);
    line("Quantity", `${quantity} per wallet → ${quantity * wallets.length} total`);
    line("Mint cost", `${(0, ethers_1.formatEther)(mintPlan.value)} per wallet → ${(0, ethers_1.formatEther)(mintPlan.value * BigInt(wallets.length))} total (+ gas)`);
    line("Gas", `${maxFeeGwei} / ${priorityGwei} gwei · limit ${gasLimit}`);
    line("Timing", timingLabel);
    console.log(chalk_1.default.bold.white("───────────────────────"));
    if (!(await (0, prompt_1.askYesNo)(chalk_1.default.bold("Fire?"), false))) {
        console.log(chalk_1.default.yellow("\n  Aborted — nothing was sent.\n"));
        (0, prompt_1.closePrompts)();
        return;
    }
    // Hand stdin back so readline never interleaves with the blast logging.
    (0, prompt_1.closePrompts)();
    await (0, local_mint_1.localPublicSnipe)({
        nftContract,
        quantity,
        walletKeys,
        rpcUrls,
        maxFeePerGas,
        maxPriorityFee,
        gasLimit,
        targetStart,
        plan: mintPlan,
    });
}
// ── Steps ───────────────────────────────────────────────────────────────
async function promptKeys() {
    console.log(chalk_1.default.bold.white("Private keys"));
    console.log(chalk_1.default.gray("  Paste one key per line — typing is hidden. Blank line when done."));
    console.log(chalk_1.default.gray("  Each key is confirmed by its wallet address. Nothing is saved to disk."));
    const keys = [];
    const seen = new Set();
    for (;;) {
        const raw = await (0, prompt_1.askHidden)(chalk_1.default.gray(`  › key ${keys.length + 1}: `));
        if (!raw) {
            if (keys.length === 0) {
                console.log(chalk_1.default.red("  ✗ Need at least one key."));
                continue;
            }
            break;
        }
        const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
        let wallet;
        try {
            wallet = new ethers_1.Wallet(normalized);
        }
        catch {
            console.log(chalk_1.default.red("  ✗ Not a valid private key — try again."));
            continue;
        }
        if (seen.has(wallet.address.toLowerCase())) {
            console.log(chalk_1.default.yellow(`  ⚠ Duplicate of ${short(wallet.address)} — skipped.`));
            continue;
        }
        seen.add(wallet.address.toLowerCase());
        keys.push(normalized);
        console.log(chalk_1.default.green(`  ✓ [W${keys.length - 1}] ${wallet.address}`));
    }
    console.log(chalk_1.default.gray(`  ${keys.length} wallet(s) loaded.`));
    return keys;
}
async function promptQuantity(walletCount) {
    console.log(chalk_1.default.bold.white("\nQuantity"));
    const qty = await (0, prompt_1.askNumber)("NFTs per wallet", 1, { min: 1, max: 100 });
    if (walletCount > 1) {
        console.log(chalk_1.default.gray(`  → ${qty} × ${walletCount} wallets = ${qty * walletCount} total`));
    }
    return Math.floor(qty);
}
async function promptTarget(chainKey) {
    console.log(chalk_1.default.bold.white("\nNFT target"));
    console.log(chalk_1.default.gray("  Paste the OpenSea link (collection or item), a slug, or the contract address."));
    let activeChain = chainKey;
    for (;;) {
        const raw = await (0, prompt_1.askText)("NFT link");
        if (!raw) {
            console.log(chalk_1.default.red("  ✗ Paste a link, slug, or address."));
            continue;
        }
        let parsed;
        try {
            parsed = (0, nft_link_1.parseNftLink)(raw);
        }
        catch (err) {
            console.log(chalk_1.default.red(`  ✗ ${err.message}`));
            continue;
        }
        if (parsed.chainHint && parsed.chainHint !== activeChain && (0, chains_1.resolveChain)(parsed.chainHint)) {
            const hinted = (0, chains_1.resolveChain)(parsed.chainHint);
            console.log(chalk_1.default.yellow(`  ⚠ This link points at ${hinted.name}, but you selected ${(0, chains_1.resolveChain)(activeChain).name}.`));
            if (await (0, prompt_1.askYesNo)(`Switch to ${hinted.name}?`, true)) {
                activeChain = hinted.key;
                console.log(chalk_1.default.green(`  ✓ Chain switched to ${hinted.name}`));
            }
        }
        if (parsed.kind === "address") {
            const normalized = normalizeAddress(parsed.value);
            if (!normalized) {
                console.log(chalk_1.default.red(`  ✗ "${parsed.value}" is not a 20-byte address.`));
                continue;
            }
            if (normalized.checksumWarning) {
                console.log(chalk_1.default.yellow("  ⚠ Mixed-case address whose EIP-55 checksum doesn't match — likely a typo."));
                if (!(await (0, prompt_1.askYesNo)("Use it anyway?", false)))
                    continue;
            }
            console.log(chalk_1.default.green(`  ✓ Contract ${normalized.address}`));
            return { contract: normalized.address, label: short(normalized.address), chainKey: activeChain };
        }
        // Slug → address is a plain OpenSea REST lookup, which often answers without
        // a key. Always try; a key only makes it reliable. The mint itself never
        // touches OpenSea either way.
        const apiKey = (process.env.OPENSEA_API_KEY || "").trim();
        try {
            console.log(chalk_1.default.gray(`  Resolving slug "${parsed.value}"${apiKey ? "" : " (no API key — may be refused)"}...`));
            const info = await (0, slug_resolver_1.resolveSlug)(parsed.value, apiKey || undefined, activeChain);
            const resolved = normalizeAddress(info.contractAddress);
            if (!resolved) {
                console.log(chalk_1.default.red(`  ✗ Unusable address returned: ${info.contractAddress}`));
                continue;
            }
            console.log(chalk_1.default.green(`  ✓ ${info.name} → ${resolved.address}`));
            if (info.chain && (0, chains_1.resolveChain)(info.chain) && info.chain !== activeChain) {
                console.log(chalk_1.default.yellow(`  ⚠ Listed on "${info.chain}", not "${activeChain}".`));
                if (await (0, prompt_1.askYesNo)(`Switch to ${(0, chains_1.resolveChain)(info.chain).name}?`, true)) {
                    activeChain = (0, chains_1.resolveChain)(info.chain).key;
                }
            }
            return { contract: resolved.address, label: info.name || parsed.value, chainKey: activeChain };
        }
        catch (err) {
            console.log(chalk_1.default.red(`  ✗ ${err.message}`));
            console.log(chalk_1.default.gray("    Paste the contract address (0x…) instead — that always works, no key needed."));
            console.log(chalk_1.default.gray("    Find it on the collection page under Details, or click any item: the address is in that URL."));
        }
    }
}
async function promptRpc(profile) {
    console.log(chalk_1.default.bold.white("\nRPC endpoints"));
    console.log(chalk_1.default.gray("  A private RPC (Alchemy / QuickNode / Infura) is what wins a contested mint."));
    if (profile.rpc.alchemyHost) {
        console.log(chalk_1.default.gray(`  Paste a full URL, or just your Alchemy key → https://${profile.rpc.alchemyHost}/v2/<key>`));
    }
    console.log(chalk_1.default.gray("  Comma-separate several to blast to all of them."));
    const fromEnv = (0, rpc_resolver_1.privateRpcsFromEnv)(profile.key);
    if (fromEnv.length > 0) {
        console.log(chalk_1.default.gray(`  .env already has: ${fromEnv.map(rpc_resolver_1.maskRpc).join(", ")}`));
        console.log(chalk_1.default.gray("  Blank = keep the .env value."));
    }
    else {
        console.log(chalk_1.default.yellow(`  Nothing in .env for ${profile.name}. Blank = public nodes only.`));
    }
    for (;;) {
        const raw = await (0, prompt_1.askText)(`RPC for ${profile.name}`);
        if (!raw)
            return fromEnv;
        const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
        const urls = [];
        let bad = false;
        for (const part of parts) {
            const url = (0, rpc_resolver_1.toRpcUrl)(part, profile.key);
            if (!url) {
                console.log(chalk_1.default.red(`  ✗ "${part}" is not a URL or a usable API key.`));
                bad = true;
                break;
            }
            urls.push(url);
        }
        if (bad || urls.length === 0)
            continue;
        for (const url of urls)
            console.log(chalk_1.default.green(`  ✓ ${(0, rpc_resolver_1.maskRpc)(url)}`));
        return urls;
    }
}
async function promptTiming(startTime) {
    const startsInFuture = startTime * 1000 > Date.now();
    const at = new Date(startTime * 1000);
    const choices = [];
    if (startsInFuture) {
        // Firing before the on-chain start reverts with NotActive, so it isn't
        // offered at all once a future start time is known.
        choices.push({
            label: "Wait for the stage",
            value: "wait",
            hint: `${(0, time_format_1.toIST)(at)} IST · in ${formatRemaining(at.getTime() - Date.now())} · fires at T-0`,
        });
    }
    else {
        choices.push({ label: "Fire now", value: "now", hint: "stage is already live" });
    }
    choices.push({ label: "Custom time", value: "custom", hint: "HH:MM, 24-hour IST, today" });
    const pick = await (0, prompt_1.askChoice)("When should it fire?", choices, 0);
    if (pick === "wait")
        return { targetStart: at, timingLabel: `wait for stage — ${(0, time_format_1.toIST)(at)} IST` };
    if (pick === "now")
        return { targetStart: null, timingLabel: "fire immediately" };
    for (;;) {
        const raw = await (0, prompt_1.askText)("Time (HH:MM, 24-hour IST)");
        try {
            const custom = (0, time_format_1.istTimeToDate)(raw);
            if (custom.getTime() < startTime * 1000) {
                console.log(chalk_1.default.bold.red(`  ✗ That is before the stage opens (${(0, time_format_1.toIST)(at)} IST) — it will revert.`));
                if (!(await (0, prompt_1.askYesNo)("Use it anyway?", false)))
                    continue;
            }
            return { targetStart: custom, timingLabel: `custom — ${(0, time_format_1.toIST)(custom)} IST` };
        }
        catch (err) {
            console.log(chalk_1.default.red(`  ✗ ${err.message}`));
        }
    }
}
// ── Helpers ─────────────────────────────────────────────────────────────
// Accept an address in any case — explorer copy-pastes arrive case-mangled and
// hard-failing is worse. A mixed-case string failing EIP-55 is the typo signal.
function normalizeAddress(raw) {
    const value = raw.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value))
        return null;
    const body = value.slice(2);
    const mixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
    return {
        address: (0, ethers_1.getAddress)(value.toLowerCase()),
        checksumWarning: mixedCase && !(0, ethers_1.isAddress)(value),
    };
}
async function currentBaseFeeGwei(provider) {
    try {
        const fee = await provider.getFeeData();
        const wei = fee.gasPrice ?? fee.maxFeePerGas;
        return wei === null || wei === undefined ? null : Number(wei) / 1e9;
    }
    catch {
        return null;
    }
}
function gweiToWei(gwei) {
    return BigInt(Math.round(gwei * 1e9));
}
function formatRemaining(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0)
        return `${h}h ${m}m`;
    if (m > 0)
        return `${m}m ${s}s`;
    return `${s}s`;
}
function short(addr) {
    return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
function labelOf(url) {
    return (0, rpc_blast_1.parseRpcEndpoints)([url])[0].label;
}
function line(label, value) {
    console.log(`  ${chalk_1.default.gray(label.padEnd(10))} ${chalk_1.default.white(value)}`);
}
function printBanner() {
    console.log(chalk_1.default.bold.cyan(`
╔═══════════════════════════════════════╗
║        NFT PUBLIC MINT SNIPER         ║
║   On-chain calldata · no OpenSea      ║
╚═══════════════════════════════════════╝`));
    console.log(chalk_1.default.gray("  Public SeaDrop stages only. Ctrl+C to quit at any point.\n"));
}
//# sourceMappingURL=wizard.js.map