<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { api } from '../api';
import SourceEditor from '../components/SourceEditor.vue';
import ImportDialog from '../components/ImportDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';

interface Source { id:number; sourceKey:string; name:string; api:string; classificationMode:'auto'|'normal'|'adult'; isAdult:boolean; enabled:boolean; ignoreHealthCheck:boolean; healthStatus:'unknown'|'healthy'|'unhealthy'; latencyMs:number|null; lastCheckedAt:string|null; detail:string|null; comment:string|null }
const result = ref<{items:Source[];total:number;page:number;pageSize:number}>({ items:[], total:0, page:1, pageSize:10 });
const filters = reactive({ search:'', classification:'', healthStatus:'', enabled:'' });
const pageSize = ref(10);
const latencySort = ref<''|'latencyAsc'|'latencyDesc'>('');
const jumpPage = ref(1);
const selected = ref<number[]>([]);
const busy = ref(false), error = ref(''), editor = ref<Source|null|undefined>(), showImport = ref(false);
const confirmation = ref<{title:string;description:string;confirmText:string;run:()=>Promise<void>}|null>(null);
let timer:number;

const pages = computed(() => Math.max(1, Math.ceil(result.value.total / result.value.pageSize)));
const allSelected = computed(() => result.value.items.length > 0 && result.value.items.every((source) => selected.value.includes(source.id)));

async function load(page = result.value.page) {
  busy.value = true; error.value = '';
  try {
    const target = Math.min(Math.max(1, page), pages.value);
    const query = new URLSearchParams({ page:String(target), pageSize:String(pageSize.value) });
    Object.entries(filters).forEach(([key, value]) => value && query.set(key, value));
    if (latencySort.value) query.set('sort', latencySort.value);
    result.value = await api.get(`/api/admin/sources?${query}`);
    jumpPage.value = result.value.page;
    selected.value = [];
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '载入失败'; }
  finally { busy.value = false; }
}

watch(filters, () => { clearTimeout(timer); timer = window.setTimeout(() => load(1), 250); }, { deep:true });
watch(pageSize, () => load(1));
watch(latencySort, () => load(1));
function goToPage() { load(Math.min(Math.max(1, Math.trunc(Number(jumpPage.value) || 1)), pages.value)); }
function toggleAll() { selected.value = allSelected.value ? [] : result.value.items.map((source) => source.id); }
async function runAction(action:'enable'|'disable'|'delete'|'check') { busy.value=true; try { await api.send('/api/admin/sources/bulk','POST',{ids:selected.value,action}); await load(); } catch(cause) { error.value=cause instanceof Error?cause.message:'操作失败'; } finally { busy.value=false; } }
async function action(action:'enable'|'disable'|'delete'|'check') { if(!selected.value.length)return; if(action==='delete'){const count=selected.value.length;confirmation.value={title:'删除视频源',description:`确定删除已选择的 ${count} 个视频源吗？删除后无法恢复。`,confirmText:'删除',run:()=>runAction('delete')};return} await runAction(action); }
async function removeNow(source:Source) { busy.value=true;try{await api.send(`/api/admin/sources/${source.id}`,'DELETE');await load()}catch(cause){error.value=cause instanceof Error?cause.message:'删除失败'}finally{busy.value=false} }
async function remove(source:Source) { confirmation.value={title:'删除视频源',description:`确定删除“${source.name}”吗？删除后无法恢复。`,confirmText:'删除',run:()=>removeNow(source)}; }
async function check(source:Source) { try{await api.send(`/api/admin/sources/${source.id}/check`,'POST');await load()}catch(cause){error.value=cause instanceof Error?cause.message:'检测失败'} }
async function removeUnhealthyNow(){busy.value=true;error.value='';try{const response=await api.send<{affected:number}>('/api/admin/sources/remove-unhealthy','POST');await load(1);if(response.affected===0)error.value='当前没有异常来源'}catch(cause){error.value=cause instanceof Error?cause.message:'移除失败'}finally{busy.value=false}}
async function removeUnhealthy(){confirmation.value={title:'移除所有异常视频源',description:'这会删除当前所有健康状态为“异常”的视频源，操作完成后无法恢复。',confirmText:'全部移除',run:removeUnhealthyNow}}
async function confirmPending(){const pending=confirmation.value;if(!pending)return;await pending.run();confirmation.value=null}
onMounted(()=>load(1));
</script>

<template>
  <section class="sources-page">
    <div class="page-head"><div><div class="eyebrow">SOURCES</div><h1>视频源管理</h1><p class="muted">共 {{result.total}} 个来源</p></div><div class="actions"><button class="ghost danger-button" :disabled="busy" @click="removeUnhealthy">移除异常</button><button class="ghost" @click="showImport=true">导入视频源</button><button class="primary" @click="editor=null">＋ 添加视频源</button></div></div>
    <div class="filters panel"><label><span class="sr-only">搜索</span><input v-model="filters.search" type="search" placeholder="搜索名称、键或 API"></label><select v-model="filters.classification" aria-label="分类"><option value="">全部分类</option><option value="normal">普通</option><option value="adult">成人</option></select><select v-model="filters.healthStatus" aria-label="健康状态"><option value="">全部状态</option><option value="healthy">健康</option><option value="unhealthy">异常</option><option value="unknown">未检测</option></select><select v-model="filters.enabled" aria-label="启用状态"><option value="">全部启用状态</option><option value="true">已启用</option><option value="false">已停用</option></select><select v-model="latencySort" aria-label="响应速度排序"><option value="">默认排序</option><option value="latencyAsc">速度从快到慢</option><option value="latencyDesc">速度从慢到快</option></select></div>
    <div v-if="selected.length" class="bulk"><b>已选 {{selected.length}} 项</b><button @click="action('enable')">启用</button><button @click="action('disable')">停用</button><button @click="action('check')">检测</button><button class="danger" @click="action('delete')">删除</button></div>
    <p v-if="error" class="error" role="alert">{{error}}</p>
    <div class="table-wrap sources-table-wrap panel"><table><thead><tr><th><input type="checkbox" :checked="allSelected" aria-label="选择本页全部" @change="toggleAll"></th><th>来源</th><th>分类</th><th>状态</th><th>启用</th><th>操作</th></tr></thead><tbody><tr v-if="busy&&!result.items.length"><td colspan="6">载入中…</td></tr><tr v-else-if="!result.items.length"><td colspan="6" class="empty">没有符合条件的来源</td></tr><tr v-for="source in result.items" :key="source.id"><td><input v-model="selected" type="checkbox" :value="source.id" :aria-label="`选择 ${source.name}`"></td><td><b>{{source.name}}</b><code>{{source.sourceKey}}</code><small class="truncate" :title="source.api">{{source.api}}</small><small :class="['source-latency',source.latencyMs===null?'unknown':source.latencyMs<1000?'fast':source.latencyMs<3000?'medium':'slow']">响应 {{source.latencyMs===null?'未检测':`${source.latencyMs} ms`}}</small></td><td><span class="tag">{{source.isAdult?'成人':'普通'}}</span></td><td><span :class="['status',source.healthStatus]">{{source.healthStatus==='healthy'?'健康':source.healthStatus==='unhealthy'?'异常':'未检测'}}</span></td><td>{{source.enabled?'是':'否'}}</td><td><div class="row-actions"><button class="link" @click="editor=source">编辑</button><button class="link" @click="check(source)">检测</button><button class="link danger" @click="remove(source)">删除</button></div></td></tr></tbody></table></div>
    <div class="pager"><span>共 {{result.total}} 条</span><label>每页 <select v-model.number="pageSize" aria-label="每页条数"><option :value="10">10</option><option :value="25">25</option><option :value="50">50</option><option :value="100">100</option></select> 条</label><button :disabled="result.page<=1||busy" @click="load(result.page-1)">上一页</button><span>{{result.page}} / {{pages}}</span><button :disabled="result.page>=pages||busy" @click="load(result.page+1)">下一页</button><label>跳至 <input v-model.number="jumpPage" type="number" min="1" :max="pages" aria-label="跳转页码" @keyup.enter="goToPage"> 页</label><button :disabled="busy" @click="goToPage">确定</button></div>
    <SourceEditor v-if="editor!==undefined" :source="editor||undefined" @close="editor=undefined" @saved="editor=undefined;load()"/><ImportDialog v-if="showImport" @close="showImport=false" @applied="showImport=false;load(1)"/><ConfirmDialog v-if="confirmation" :title="confirmation.title" :description="confirmation.description" :confirm-text="confirmation.confirmText" :busy="busy" @cancel="confirmation=null" @confirm="confirmPending"/>
  </section>
</template>
