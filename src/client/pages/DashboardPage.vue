<script setup lang="ts">
import { ref } from "vue";
import MintPanel from "../components/MintPanel.vue";
import TokenBuyPanel from "../components/TokenBuyPanel.vue";

const activeTab = ref<"mint" | "token">("mint");
</script>

<template>
  <main class="shell">
    <div class="workspace page-shell">
      <header class="app-nav">
        <div class="brand-mark">
          <span class="brand-dot" aria-hidden="true"></span>
          <span>Auto Min</span>
        </div>
        <nav aria-label="Main navigation" class="main-nav">
          <button
            class="nav-item"
            :class="{ active: activeTab === 'mint' }"
            :aria-current="activeTab === 'mint' ? 'page' : undefined"
            type="button"
            @click="activeTab = 'mint'"
          >
            <span class="nav-index">01</span>
            <span>NFT Mint</span>
          </button>
          <button
            class="nav-item"
            :class="{ active: activeTab === 'token' }"
            :aria-current="activeTab === 'token' ? 'page' : undefined"
            type="button"
            @click="activeTab = 'token'"
          >
            <span class="nav-index">02</span>
            <span>Token Buy</span>
          </button>
        </nav>
        <span class="nav-state"><span class="state-dot" aria-hidden="true"></span>Ready</span>
      </header>

      <MintPanel v-if="activeTab === 'mint'" />
      <TokenBuyPanel v-else />
    </div>
  </main>
</template>
