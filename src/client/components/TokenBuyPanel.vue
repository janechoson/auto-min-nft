<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

interface TokenBuyChain {
  key: string;
  label: string;
  chainId: number;
  rpc: string;
  nativeSymbol: string;
  wrappedNative: string;
  defaultRouter: string;
}

interface QuoteResponse {
  ok: boolean;
  chainId: number;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  buyAmount: string;
  nativeSymbol: string;
  requiredNative: string;
  routerAddress: string;
  estimatedCostUsd?: string;
  error?: string;
}

const chains = ref<TokenBuyChain[]>([]);
const selectedChainId = ref<number>(1);
const tokenAddress = ref("");
const buyAmount = ref("1");
const slippageBps = ref(200);
const status = ref("Ready");
const output = ref("Ready");
const isBusy = ref(false);
const quote = ref<QuoteResponse | null>(null);
const privateKeys = ref<string[]>([]);
const walletFileName = ref("");

const selectedChain = computed(
  () => chains.value.find((chain) => String(chain.chainId) === String(selectedChainId.value)) ?? null
);

const canQuote = computed(() => Boolean(tokenAddress.value.trim() && buyAmount.value && Number(buyAmount.value) > 0));
const canBuy = computed(() => Boolean(tokenAddress.value.trim() && buyAmount.value && Number(buyAmount.value) > 0 && privateKeys.value.length > 0 && selectedChain.value && !isBusy.value));

watch(
  selectedChainId,
  () => {
    quote.value = null;
    output.value = "Ready";
  },
  { immediate: true }
);

onMounted(async () => {
  try {
    const response = await fetch("/api/token-buy/chains");
    const data = (await response.json()) as TokenBuyChain[];

    if (!response.ok || !Array.isArray(data)) {
      throw new Error("Cannot load token-buy chain config");
    }

    chains.value = data;
    if (chains.value.length > 0) {
      selectedChainId.value = chains.value[0].chainId;
    }
  } catch (error) {
    status.value = "Error";
    output.value = `Cannot load buy-token chains: ${String(error)}`;
  }
});

async function loadWalletFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const entries = (await file.text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (entries.length === 0) {
    status.value = "Error";
    output.value = "The wallet file does not contain any private key.";
    return;
  }
  privateKeys.value = entries;
  walletFileName.value = file.name;
  input.value = "";
}

async function fetchQuote() {
  if (!tokenAddress.value.trim()) {
    status.value = "Error";
    output.value = "Please enter a token contract address.";
    return;
  }

  if (!selectedChain.value) {
    status.value = "Error";
    output.value = "Please choose a supported chain.";
    return;
  }

  isBusy.value = true;
  status.value = "Quoting";
  output.value = "Fetching buy quote...";

  try {
    const response = await fetch("/api/token-buy/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chainId: selectedChain.value.chainId,
        tokenAddress: tokenAddress.value.trim(),
        buyAmount: buyAmount.value,
      }),
    });

    const data = (await response.json()) as QuoteResponse & { error?: string };
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Cannot quote token buy.");
    }

    quote.value = data;
    status.value = "Ready";
    output.value = JSON.stringify(
      {
        chain: selectedChain.value?.label,
        tokenAddress: data.tokenAddress,
        buyAmount: data.buyAmount,
        tokenSymbol: data.tokenSymbol || "UNKNOWN",
        requiredNative: data.requiredNative,
        routerAddress: data.routerAddress,
        estimatedCostUsd: data.estimatedCostUsd || "N/A",
        nativeSymbol: data.nativeSymbol,
      },
      null,
      2
    );
  } catch (error) {
    status.value = "Error";
    output.value = String(error);
  } finally {
    isBusy.value = false;
  }
}

async function approveAndBuy() {
  if (!selectedChain.value) {
    status.value = "Error";
    output.value = "Select a token chain first.";
    return;
  }

  isBusy.value = true;
  status.value = "Submitting";
  output.value = "Executing swap...";

  try {
    const response = await fetch("/api/token-buy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chainId: selectedChain.value.chainId,
        tokenAddress: tokenAddress.value.trim(),
        buyAmount: buyAmount.value,
        slippageBps: Number(slippageBps.value || 200),
        privateKeys: privateKeys.value,
      }),
    });

    const data = (await response.json()) as QuoteResponse & {
      hash?: string;
      txHash?: string;
      approved?: boolean;
      error?: string;
      message?: string;
    };

    if (!response.ok) {
      throw new Error(data.error || data.message || "Token buy failed.");
    }

    status.value = "Completed";
    output.value = JSON.stringify(
      {
        hash: data.hash || data.txHash || null,
        approved: data.approved ?? false,
        chain: selectedChain.value.label,
        tokenAddress: tokenAddress.value.trim(),
        buyAmount: buyAmount.value,
        routerAddress: data.routerAddress || selectedChain.value.defaultRouter,
        requiredNative: data.requiredNative || "quoted",
      },
      null,
      2
    );
  } catch (error) {
    status.value = "Error";
    output.value = String(error);
  } finally {
    isBusy.value = false;
  }
}
</script>

<template>
  <section class="workspace token-buy-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Token Buy</p>
        <h1>Mua Token Theo Contract</h1>
      </div>
      <div class="status" :class="{ error: status === 'Error' }">
        {{ status }}
      </div>
    </header>

    <div class="layout">
      <form class="panel" @submit.prevent="fetchQuote">
        <label>
          <span>Chain</span>
          <select v-model.number="selectedChainId">
            <option :value="null" disabled>Select chain</option>
            <option v-for="chain in chains" :key="chain.chainId" :value="chain.chainId">
              {{ chain.label }} ({{ chain.chainId }})
            </option>
          </select>
        </label>

        <label>
          <span>Token contract</span>
          <input v-model="tokenAddress" autocomplete="off" placeholder="0x..." />
        </label>

        <label>
          <span>Danh sách ví</span>
          <input accept=".txt,text/plain" type="file" @change="loadWalletFile" />
          <small>{{ privateKeys.length ? `${privateKeys.length} ví đã tải từ ${walletFileName}` : "Mỗi dòng trong file là một private key" }}</small>
        </label>

        <div class="field-grid">
          <label>
            <span>Quantity to buy</span>
            <input v-model="buyAmount" min="0.000000000000000001" step="any" type="number" />
          </label>
          <label>
            <span>Slippage</span>
            <input v-model.number="slippageBps" min="0.1" max="50" step="0.1" type="number" />
          </label>
        </div>

        <div class="meta-row">
          <div>
            <p class="meta-label">Router</p>
            <p class="meta-value break">{{ selectedChain?.defaultRouter || "Server config required" }}</p>
          </div>
        </div>

        <div class="meta-row">
          <div>
            <p class="meta-label">Native</p>
            <p class="meta-value">{{ selectedChain?.nativeSymbol || "ETH" }}</p>
          </div>
          <div>
            <p class="meta-label">RPC</p>
            <p class="meta-value break">{{ selectedChain?.rpc || "No chain selected" }}</p>
          </div>
        </div>

        <div class="actions no-top">
          <button class="primary" :disabled="!canQuote || isBusy" type="submit">
            {{ isBusy ? "Working..." : "Quote" }}
          </button>
          <button class="secondary" :disabled="!canBuy" type="button" @click="approveAndBuy">
            Buy Now
          </button>
        </div>
      </form>

      <aside class="panel side">
        <div>
          <p class="meta-label">Quote / result</p>
          <pre class="summary break">{{ output }}</pre>
        </div>
        <div>
          <p class="meta-label">Current quote</p>
          <pre class="summary break">{{ quote ? JSON.stringify(quote, null, 2) : "No quote generated yet." }}</pre>
        </div>
      </aside>
    </div>
  </section>
</template>
