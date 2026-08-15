<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { logout, session } from './api';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import SourcesView from './views/SourcesView.vue';
import SettingsView from './views/SettingsView.vue';

type Page = 'dashboard' | 'sources' | 'settings';
const ready = ref(false);
const authenticated = ref(false);
const page = ref<Page>('dashboard');
const navigation = [
  { id: 'dashboard' as const, label: '运行概览', icon: '⌁' },
  { id: 'sources' as const, label: '视频源管理', icon: '◫' },
  { id: 'settings' as const, label: '系统设置', icon: '⚙' },
];

onMounted(async () => {
  try { authenticated.value = Boolean(await session()); }
  finally { ready.value = true; }
});

async function signOut() {
  try { await logout(); }
  finally { authenticated.value = false; }
}
</script>

<template>
  <div v-if="!ready" class="center boot-screen" role="status">
    <span class="loader"></span>
    正在载入控制台…
  </div>
  <LoginView v-else-if="!authenticated" @authenticated="authenticated = true" />
  <div v-else class="app-layout">
    <aside class="sidebar">
      <button class="logo" aria-label="返回概览" @click="page = 'dashboard'">
        <span class="logo-mark">L</span>
        <span><b>LunaTV</b><small>Source Console</small></span>
      </button>
      <nav aria-label="主导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          :class="{ active: page === item.id }"
          @click="page = item.id"
        >
          <span class="nav-icon">{{ item.icon }}</span>
          {{ item.label }}
        </button>
      </nav>
      <div class="sidebar-status">
        <span class="live-dot"></span>
        <span><b>服务运行中</b><small>Source Sync v0.1</small></span>
      </div>
      <button class="sign-out" @click="signOut">退出管理后台</button>
    </aside>

    <header class="mobile-header">
      <button class="logo" aria-label="返回概览" @click="page = 'dashboard'">
        <span class="logo-mark">L</span><b>LunaTV</b>
      </button>
      <nav aria-label="移动端主导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          :class="{ active: page === item.id }"
          :aria-label="item.label"
          @click="page = item.id"
        >{{ item.icon }}</button>
      </nav>
      <button class="mobile-exit" aria-label="退出" @click="signOut">↗</button>
    </header>

    <main class="content-area">
      <DashboardView v-if="page === 'dashboard'" @open-sources="page = 'sources'" />
      <SourcesView v-else-if="page === 'sources'" />
      <SettingsView v-else />
    </main>
  </div>
</template>
