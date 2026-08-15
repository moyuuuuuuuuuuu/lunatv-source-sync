<script setup lang="ts">
import { onMounted, ref } from 'vue'; import { api } from '../api';
const emit = defineEmits<{ 'open-sources': [] }>();
interface Stats { total:number; normal:number; adult:number; healthy:number; unhealthy:number; unknown:number; nextCheckAt:string|null }
const data=ref<Stats|null>(null), error=ref(''), checking=ref(false);
async function load(){ try{data.value=await api.get('/api/admin/dashboard')}catch(e){error.value=e instanceof Error?e.message:'载入失败'} }
async function check(){checking.value=true;try{await api.send('/api/admin/health/check','POST');await load()}catch(e){error.value=e instanceof Error?e.message:'检测失败'}finally{checking.value=false}}
onMounted(load);
</script>
<template><section><div class="page-head"><div><div class="eyebrow">OVERVIEW</div><h1>运行概览</h1></div><button class="primary" :disabled="checking" @click="check">{{checking?'检测中…':'立即全部检测'}}</button></div><p v-if="error" class="error" role="alert">{{error}}</p><div v-if="data" class="stats"><article><span>来源总数</span><strong>{{data.total}}</strong></article><article><span>正常 / 成人</span><strong>{{data.normal}} <small>/ {{data.adult}}</small></strong></article><article><span>健康</span><strong class="good">{{data.healthy}}</strong></article><article><span>异常 / 未检测</span><strong class="bad">{{data.unhealthy}} <small>/ {{data.unknown}}</small></strong></article></div><div v-if="data" class="notice">下次自动检测：{{data.nextCheckAt ? new Date(data.nextCheckAt).toLocaleString() : '尚未安排'}} <button class="link" @click="emit('open-sources')">查看视频源 →</button></div></section></template>
