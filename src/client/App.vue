<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { logout, session } from './api';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import SourcesView from './views/SourcesView.vue';
import SettingsView from './views/SettingsView.vue';

type Page = 'dashboard' | 'sources' | 'settings';
const ready = ref(false), authenticated = ref(false), page = ref<Page>('dashboard');
onMounted(async () => { try { authenticated.value = Boolean(await session()); } finally { ready.value = true; } });
async function signOut() { try { await logout(); } finally { authenticated.value = false; } }
</script>
<template>
  <div v-if="!ready" class="center" role="status">正在载入…</div>
  <LoginView v-else-if="!authenticated" @authenticated="authenticated = true" />
  <div v-else class="shell">
    <header><a class="brand" href="#" @click.prevent="page = 'dashboard'">LunaTV <span>来源管理</span></a><nav aria-label="主导航"><button v-for="item in ([['dashboard','概览'],['sources','来源'],['settings','设置']] as const)" :key="item[0]" :class="{ active: page === item[0] }" @click="page = item[0]">{{ item[1] }}</button></nav><button class="ghost" @click="signOut">退出</button></header>
    <main><DashboardView v-if="page === 'dashboard'" @open-sources="page = 'sources'"/><SourcesView v-else-if="page === 'sources'"/><SettingsView v-else/></main>
  </div>
</template>
