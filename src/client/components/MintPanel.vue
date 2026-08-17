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
const output = ref("Ready");
const jobLog = ref("Ready");
const status = ref("Idle");
const isBusy = ref(false);
const activeJobId = ref<string | null>(null);
let pollTimer: number | null = null;

const now = new Date();
const fireYear = ref(now.getUTCFullYear());
const fireMonth = ref(now.getUTCMonth());
const fireDay = ref(now.getUTCDate());
const fireHour = ref(now.getUTCHours());
const fireMinute = ref(now.getUTCMinutes());
const visibleYear = ref(fireYear.value);
const visibleMonth = ref(fireMonth.value);

const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hours = Array.from({ length: 24 }, (_, hour) => hour);
const minutes = Array.from({ length: 60 }, (_, minute) => minute);

const selectedRpc = computed(() =>
  rpcs.value.find((rpc) => String(rpc.id) === String(selectedRpcId.value)) ?? null
);

const canSubmit = computed(() =>
  Boolean(nftContract.value.trim() && selectedRpc.value && !isBusy.value)
);

const calendarDays = computed(() => {
  const firstDay = new Date(Date.UTC(visibleYear.value, visibleMonth.value, 1));
  const startOffset = (firstDay.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(visibleYear.value, visibleMonth.value + 1, 0)).getUTCDate();
  return [
    ...Array.from({ length: startOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
});

const targetStart = computed(() => {
  const date = new Date(Date.UTC(fireYear.value, fireMonth.value, fireDay.value, fireHour.value, fireMinute.value, 0, 0));
  return date.toISOString().replace(".000Z", "Z");
});

const selectedDateLabel = computed(
  () =>
    `${pad(fireDay.value)}/${pad(fireMonth.value + 1)}/${fireYear.value} ${pad(fireHour.value)}:${pad(
      fireMinute.value
    )} UTC`
);

onMounted(async () => {
  try {
    const response = await fetch("/const.js");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const source = await response.text();
    const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const mod = await import(/* @vite-ignore */ moduleUrl);
    URL.revokeObjectURL(moduleUrl);
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
    targetStart: targetStart.value,
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

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function isSelectedDate(day: number | null) {
  return (
    day === fireDay.value &&
    visibleMonth.value === fireMonth.value &&
    visibleYear.value === fireYear.value
  );
}

function isToday(day: number | null) {
  const today = new Date();
  return (
    day === today.getUTCDate() &&
    visibleMonth.value === today.getUTCMonth() &&
    visibleYear.value === today.getUTCFullYear()
  );
}

function selectDate(day: number | null) {
  if (!day) return;
  fireYear.value = visibleYear.value;
  fireMonth.value = visibleMonth.value;
  fireDay.value = day;
}

function changeMonth(delta: number) {
  const next = new Date(Date.UTC(visibleYear.value, visibleMonth.value + delta, 1));
  visibleYear.value = next.getUTCFullYear();
  visibleMonth.value = next.getUTCMonth();
}

function goToToday() {
  const today = new Date();
  fireYear.value = today.getUTCFullYear();
  fireMonth.value = today.getUTCMonth();
  fireDay.value = today.getUTCDate();
  fireHour.value = today.getUTCHours();
  fireMinute.value = today.getUTCMinutes();
  visibleYear.value = fireYear.value;
  visibleMonth.value = fireMonth.value;
}
</script>

<template>
  <section class="workspace">
    <header class="topbar">
      <div>
        <p class="eyebrow">OpenSea NFT Mint</p>
        <h1>Mint NFT Tự Động</h1>
      </div>
      <div class="status" :class="{ error: status === 'Error' }">
        {{ status }}
      </div>
    </header>

    <div class="layout">
      <form class="panel" @submit.prevent="startMint">
        <label>
          <span>Địa chỉ NFT</span>
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
            <span>Số lượng</span>
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

        <div class="fire-field">
          <div class="field-heading">
            <span>Fire time UTC</span>
            <strong>{{ selectedDateLabel }}</strong>
          </div>

          <div class="date-picker">
            <div class="calendar">
              <div class="calendar-header">
                <button class="icon-button" type="button" aria-label="Previous month" @click="changeMonth(-1)">
                  ‹
                </button>
                <div class="month-title">
                  <select v-model.number="visibleMonth" aria-label="Month">
                    <option v-for="(month, index) in monthNames" :key="month" :value="index">
                      {{ month }}
                    </option>
                  </select>
                  <input v-model.number="visibleYear" aria-label="Year" min="1970" type="number" />
                </div>
                <button class="icon-button" type="button" aria-label="Next month" @click="changeMonth(1)">
                  ›
                </button>
              </div>

              <div class="weekday-grid">
                <span v-for="weekday in weekdays" :key="weekday">{{ weekday }}</span>
              </div>

              <div class="day-grid">
                <button
                  v-for="(day, index) in calendarDays"
                  :key="`${visibleYear}-${visibleMonth}-${index}`"
                  class="day-button"
                  :class="{ selected: isSelectedDate(day), today: isToday(day), empty: !day }"
                  :disabled="!day"
                  type="button"
                  @click="selectDate(day)"
                >
                  {{ day || "" }}
                </button>
              </div>
            </div>

            <div class="time-controls">
              <label>
                <span>Giờ</span>
                <select v-model.number="fireHour">
                  <option v-for="hour in hours" :key="hour" :value="hour">{{ pad(hour) }}</option>
                </select>
              </label>
              <label>
                <span>Phút</span>
                <select v-model.number="fireMinute">
                  <option v-for="minute in minutes" :key="minute" :value="minute">{{ pad(minute) }}</option>
                </select>
              </label>
              <button class="secondary small" type="button" @click="goToToday">Today</button>
              <p class="utc-preview">{{ targetStart }}</p>
            </div>
          </div>
        </div>

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
</template>
