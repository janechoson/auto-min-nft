<script setup lang="ts">
import { ref } from "vue";
import MintPanel from "../components/MintPanel.vue";
import TokenBuyPanel from "../components/TokenBuyPanel.vue";

const activeTab = ref<"mint" | "token">("mint");
</script>

<template>
  <main class="shell">
    <div class="workspace page-shell">
      <div class="page-switcher">
        <button class="tab-button" :class="{ active: activeTab === 'mint' }" type="button" @click="activeTab = 'mint'">
          NFT Mint
        </button>
        <button class="tab-button" :class="{ active: activeTab === 'token' }" type="button" @click="activeTab = 'token'">
          Token Buy
        </button>
      </div>

      <MintPanel v-if="activeTab === 'mint'" />
      <TokenBuyPanel v-else />
    </div>
  </main>
</template>
