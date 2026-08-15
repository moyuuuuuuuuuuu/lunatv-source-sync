<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import ConfirmDialog from './ConfirmDialog.vue';

type SourceType = 'normal' | 'adult' | 'all';
type FormatType = 'json' | 'base58';
interface SubscriptionExamples { normalJson?: string; tokenCanReset?: boolean }

const links = ref<SubscriptionExamples>({});
const source = ref<SourceType>('normal');
const format = ref<FormatType>('base58');
const copied = ref(false);
const error = ref('');
const resetting = ref(false);
const showResetConfirm = ref(false);

const generatedUrl = computed(() => {
  if (!links.value.normalJson) return '';
  const url = new URL(links.value.normalJson);
  url.searchParams.set('source', source.value);
  url.searchParams.set('format', format.value);
  url.searchParams.set('proxy', '0');
  return url.toString();
});

async function load() {
  error.value = '';
  try { links.value = await api.get<SubscriptionExamples>('/api/admin/subscription-examples'); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '载入失败'; }
}

async function copy() {
  if (!generatedUrl.value) return;
  try {
    await navigator.clipboard.writeText(generatedUrl.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
  } catch { error.value = '复制失败，请手动选择地址复制。'; }
}

async function resetToken() {
  resetting.value = true;
  error.value = '';
  try {
    await api.send('/api/admin/subscription-token/reset', 'POST');
    await load();
    showResetConfirm.value = false;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '重置失败'; }
  finally { resetting.value = false; }
}

onMounted(load);
</script>

<template>
  <section class="panel subscriptions">
    <div class="page-head">
      <div>
        <div class="eyebrow">SUBSCRIPTIONS</div>
        <h2>生成订阅地址</h2>
        <p>选择视频源范围和输出格式，LunaTV 配置订阅请选择 Base58。</p>
      </div>
      <button v-if="links.tokenCanReset" class="ghost danger" :disabled="resetting" @click="showResetConfirm=true">
        {{ resetting ? '重置中…' : '重置令牌' }}
      </button>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="generatedUrl" class="subscription-builder">
      <div class="subscription-options">
        <label>视频源类型
          <select v-model="source">
            <option value="normal">普通源</option>
            <option value="adult">成人源</option>
            <option value="all">全部源</option>
          </select>
        </label>
        <label>订阅格式
          <select v-model="format">
            <option value="base58">Base58（LunaTV）</option>
            <option value="json">JSON（原始配置）</option>
          </select>
        </label>
      </div>
      <div class="generated-link">
        <span>生成的订阅地址</span>
        <div>
          <code :title="generatedUrl">{{ generatedUrl }}</code>
          <button class="primary" @click="copy">{{ copied ? '已复制' : '复制地址' }}</button>
        </div>
      </div>
    </div>
    <ConfirmDialog v-if="showResetConfirm" title="重置订阅令牌" description="重置后，所有使用旧令牌的订阅地址会立即失效，需要重新复制并更新客户端。" confirm-text="重置令牌" :busy="resetting" @cancel="showResetConfirm=false" @confirm="resetToken"/>
  </section>
</template>
