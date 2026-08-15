<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, logout, session } from './api';
import ChangePasswordDialog from './components/ChangePasswordDialog.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import SourcesView from './views/SourcesView.vue';
import SettingsView from './views/SettingsView.vue';
import JsonEditorView from './views/JsonEditorView.vue';

type Page = 'dashboard' | 'sources' | 'editor' | 'settings';
type ThemeMode = 'light' | 'dark';
const ready = ref(false);
const authenticated = ref(false);
const page = ref<Page>('dashboard');
const accountOpen = ref(false), showPassword = ref(false), showTokenConfirm = ref(false), tokenBusy = ref(false);
const currentHour = new Date().getHours();
const themeMode = ref<ThemeMode>(currentHour >= 6 && currentHour < 18 ? 'light' : 'dark');
const navigation = [
  { id: 'dashboard' as const, label: '运行概览', icon: '⌁' },
  { id: 'sources' as const, label: '视频源管理', icon: '◫' },
  { id: 'editor' as const, label: 'JSON 编辑器', icon: '{}' },
  { id: 'settings' as const, label: '系统设置', icon: '⚙' },
];
const currentLabel = computed(() => navigation.find((item) => item.id === page.value)?.label || '运行概览');
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
async function resetToken() {
  tokenBusy.value = true;
  try { await api.send('/api/admin/subscription-token/reset', 'POST'); showTokenConfirm.value = false; accountOpen.value = false; }
  finally { tokenBusy.value = false; }
}
function passwordChanged() { showPassword.value = false; authenticated.value = false; }
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
        <span class="logo-mark"><img src="/icon.svg" alt=""></span>
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
      <div class="sidebar-status"><span class="live-dot"></span><span><b>服务运行中</b><small>Source Sync v0.1</small></span></div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="breadcrumbs"><span>LunaTV</span><b>/</b><strong>{{ currentLabel }}</strong></div>
        <nav class="mobile-nav" aria-label="移动端主导航">
          <button v-for="item in navigation" :key="item.id" :class="{active:page===item.id}" :aria-label="item.label" @click="page=item.id"><span>{{item.icon}}</span></button>
        </nav>
        <div class="top-nav-actions">
        <span class="online-pill"><i></i><span>服务正常</span></span>
        <button class="icon-button theme-switch" :title="themeLabel" :aria-label="themeLabel" @click="toggleTheme">{{ themeIcon }}</button>
        <div class="account-menu-wrap">
          <button class="avatar" title="账户菜单" aria-label="账户菜单" :aria-expanded="accountOpen" @click="accountOpen=!accountOpen">L</button>
          <div v-if="accountOpen" class="account-menu" role="menu">
            <div class="account-summary"><span class="avatar">L</span><div><b>管理员</b><small>系统账户</small></div></div>
            <button role="menuitem" @click="accountOpen=false;showPassword=true"><span>⌨</span>修改密码</button>
            <button role="menuitem" @click="accountOpen=false;showTokenConfirm=true"><span>↻</span>重置订阅令牌</button>
            <button class="menu-danger" role="menuitem" @click="signOut"><span>↗</span>退出登录</button>
          </div>
        </div>
      </div>
      </header>
      <main class="content-area">
        <DashboardView v-if="page === 'dashboard'" @open-sources="page = 'sources'" />
        <SourcesView v-else-if="page === 'sources'" />
        <JsonEditorView v-else-if="page === 'editor'" />
        <SettingsView v-else />
      </main>
    </div>
    <ChangePasswordDialog v-if="showPassword" @close="showPassword=false" @changed="passwordChanged" />
    <ConfirmDialog v-if="showTokenConfirm" title="重置订阅令牌" description="重置后所有旧订阅地址会立即失效，需要前往系统设置重新复制地址。" confirm-text="重置令牌" :busy="tokenBusy" @cancel="showTokenConfirm=false" @confirm="resetToken" />
  </div>
</template>
