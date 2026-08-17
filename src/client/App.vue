<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

interface RpcEntry {
  label: string;
  id: number;
  rpc: string;
}

interface MintResponse {
  jobId?: string;
  status?: string;
  usedRpc?: string;
  rpcId?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  updatedAt?: number;
  error?: string | null;
  nftContract?: string;
  quantity?: number;
  logs?: string[];
}

const rpcs = ref<RpcEntry[]>([]);
const selectedRpcId = ref<number | null>(null);
const nftContract = ref("");
const quantity = ref(1);
const gasLimit = ref(250000);
const maxFeeGwei = ref(2);
const maxPriorityGwei = ref(0.05);
const targetStart = ref("");
const output = ref("Ready");
const jobLog = ref("Ready");
const status = ref("Idle");
const isBusy = ref(false);
const activeJobId = ref<string | null>(null);
let pollTimer: number | null = null;

const selectedRpc = computed(() =>
  rpcs.value.find((rpc) => String(rpc.id) === String(selectedRpcId.value)) ?? null
);

const canSubmit = computed(() =>
  Boolean(nftContract.value.trim() && selectedRpc.value && !isBusy.value)
);

onMounted(async () => {
  try {
    const configPath = "/const.js";
    const mod = await import(/* @vite-ignore */ configPath);
    rpcs.value = Array.isArray(mod.default) ? mod.default : [];
    selectedRpcId.value = rpcs.value[0]?.id ?? null;
  } catch (error) {
    status.value = "Config error";
    output.value = `Cannot load /const.js: ${String(error)}`;
  }
});

async function startMint() {
  if (!nftContract.value.trim()) {
    setError("Missing NFT contract address.");
    return;
  }
  if (!selectedRpc.value) {
    setError("Select an RPC.");
    return;
  }

  isBusy.value = true;
  status.value = "Starting";
  output.value = "Starting mint job...";
  jobLog.value = "Waiting for job logs...";

  const payload = {
    nftContract: nftContract.value.trim(),
    rpcId: selectedRpc.value.id,
    quantity: Number(quantity.value || 1),
    gasLimit: Number(gasLimit.value || 250000),
    maxFeeGwei: Number(maxFeeGwei.value || 0),
    maxPriorityGwei: Number(maxPriorityGwei.value || 0),
    targetStart: normalizeUtcInput(targetStart.value),
  };

  try {
    const response = await fetch("/api/mint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as MintResponse;

    if (!response.ok) {
      setError(data.error || JSON.stringify(data));
      return;
    }

    activeJobId.value = data.jobId || null;
    renderJob(data);
    if (data.jobId) {
      pollJob(data.jobId);
    }
  } catch (error) {
    setError(`Request failed: ${String(error)}`);
  } finally {
    isBusy.value = false;
  }
}

async function diagnoseRpc() {
  if (!nftContract.value.trim()) {
    setError("Enter an NFT contract before diagnosing.");
    return;
  }
  if (!selectedRpc.value) {
    setError("Select an RPC.");
    return;
  }

  isBusy.value = true;
  status.value = "Diagnosing";
  output.value = "Checking public drop...";

  try {
    const response = await fetch("/api/diagnose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nftContract: nftContract.value.trim(),
        rpcId: selectedRpc.value.id,
      }),
    });
    const data = await response.json();

    if (!response.ok) {
      setError(data.error || JSON.stringify(data));
      return;
    }

    status.value = "Ready";
    output.value = JSON.stringify(data, null, 2);
    jobLog.value = "Diagnose completed. Start mint to see live job logs.";
  } catch (error) {
    setError(`Diagnose failed: ${String(error)}`);
  } finally {
    isBusy.value = false;
  }
}

function setError(message: string) {
  stopPolling();
  status.value = "Error";
  output.value = message;
  jobLog.value = message;
}

async function pollJob(jobId: string) {
  stopPolling();

  const tick = async () => {
    try {
      const response = await fetch(`/api/jobs/${jobId}`);
      const data = (await response.json()) as MintResponse;

      if (!response.ok) {
        setError(data.error || "Cannot load job status.");
        return;
      }

      renderJob(data);
      if (data.status === "completed" || data.status === "failed") {
        stopPolling();
      }
    } catch (error) {
      setError(`Job polling failed: ${String(error)}`);
    }
  };

  await tick();
  if (pollTimer === null) {
    pollTimer = window.setInterval(tick, 1000);
  }
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function renderJob(job: MintResponse) {
  status.value = job.status || "Unknown";
  jobLog.value = job.logs && job.logs.length > 0 ? job.logs.join("\n") : "Waiting for job logs...";
  output.value = JSON.stringify(
    {
      jobId: job.jobId,
      status: job.status,
      error: job.error,
      usedRpc: job.usedRpc,
      rpcId: job.rpcId,
      nftContract: job.nftContract,
      quantity: job.quantity,
      startedAt: formatTime(job.startedAt),
      completedAt: formatTime(job.completedAt),
      updatedAt: formatTime(job.updatedAt),
    },
    null,
    2
  );
}

function formatTime(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString() : null;
}

function normalizeUtcInput(value: string) {
  const raw = value.trim();
  if (!raw) return null;
  return /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
}
</script>

<template>
  <main class="shell">
    <section class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">SeaDrop public mint</p>
          <h1>AutoMint NFT</h1>
        </div>
        <div class="status" :class="{ error: status === 'Error' }">
          {{ status }}
        </div>
      </header>

      <div class="layout">
        <form class="panel" @submit.prevent="startMint">
          <label>
            <span>NFT contract address</span>
            <input v-model="nftContract" autocomplete="off" placeholder="0x..." />
          </label>

          <label>
            <span>RPC</span>
            <select v-model="selectedRpcId">
              <option :value="null" disabled>Select RPC</option>
              <option v-for="rpc in rpcs" :key="rpc.id" :value="rpc.id">
                {{ rpc.label }} - {{ rpc.id }}
              </option>
            </select>
          </label>

          <div class="field-grid">
            <label>
              <span>Quantity</span>
              <input v-model.number="quantity" min="1" type="number" />
            </label>
            <label>
              <span>Gas limit</span>
              <input v-model.number="gasLimit" min="21000" type="number" />
            </label>
          </div>

          <div class="field-grid">
            <label>
              <span>Max fee (gwei)</span>
              <input v-model.number="maxFeeGwei" min="0" step="0.001" type="number" />
            </label>
            <label>
              <span>Priority fee (gwei)</span>
              <input v-model.number="maxPriorityGwei" min="0" step="0.001" type="number" />
            </label>
          </div>

          <label>
            <span>Fire time UTC</span>
            <input v-model="targetStart" placeholder="2026-08-17T12:00:00Z" />
          </label>

          <div class="actions">
            <button class="primary" :disabled="!canSubmit" type="submit">
              {{ isBusy ? "Working..." : "Start mint" }}
            </button>
            <button class="secondary" :disabled="isBusy" type="button" @click="diagnoseRpc">
              Diagnose RPC
            </button>
          </div>
        </form>

        <aside class="panel side">
          <div>
            <p class="meta-label">Wallet</p>
            <p class="meta-value">Loaded from server .env</p>
          </div>
          <div>
            <p class="meta-label">Selected RPC</p>
            <p class="meta-value break">{{ selectedRpc?.rpc || "No RPC selected" }}</p>
          </div>
          <div>
            <p class="meta-label">Job</p>
            <pre class="summary">{{ output }}</pre>
          </div>
          <div>
            <p class="meta-label">Job log</p>
            <pre class="logbox">{{ jobLog }}</pre>
          </div>
        </aside>
      </div>
    </section>
  </main>
</template>
