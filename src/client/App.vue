<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { logout, session } from './api';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import SourcesView from './views/SourcesView.vue';
import SettingsView from './views/SettingsView.vue';

type Page = 'dashboard' | 'sources' | 'settings';
type ThemeMode = 'light' | 'dark';
const ready = ref(false);
const authenticated = ref(false);
const page = ref<Page>('dashboard');
const currentHour = new Date().getHours();
const themeMode = ref<ThemeMode>(currentHour >= 6 && currentHour < 18 ? 'light' : 'dark');
const navigation = [
  { id: 'dashboard' as const, label: '运行概览', icon: '⌁' },
  { id: 'sources' as const, label: '视频源管理', icon: '◫' },
  { id: 'settings' as const, label: '系统设置', icon: '⚙' },
];
const themeLabel = computed(() => themeMode.value === 'dark' ? '切换到浅色主题' : '切换到深色主题');
const themeIcon = computed(() => themeMode.value === 'dark' ? '☾' : '☀');

function applyTheme() {
  document.documentElement.dataset.theme = themeMode.value;
  document.documentElement.style.colorScheme = themeMode.value;
}
function toggleTheme() {
  themeMode.value = themeMode.value === 'light' ? 'dark' : 'light';
  applyTheme();
}
applyTheme();

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
    <header class="top-nav">
      <button class="logo" aria-label="返回概览" @click="page = 'dashboard'">
        <span class="logo-mark">L</span>
        <span><b>LunaTV</b></span>
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
      <div class="top-nav-actions">
        <span class="online-pill"><i></i><span>服务正常</span></span>
        <button class="icon-button theme-switch" :title="themeLabel" :aria-label="themeLabel" @click="toggleTheme">{{ themeIcon }}</button>
        <button class="avatar" title="退出管理后台" aria-label="退出管理后台" @click="signOut">L</button>
      </div>
    </header>
    <main class="content-area">
      <DashboardView v-if="page === 'dashboard'" @open-sources="page = 'sources'" />
      <SourcesView v-else-if="page === 'sources'" />
      <SettingsView v-else />
    </main>
  </div>
</template>
