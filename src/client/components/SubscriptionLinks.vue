<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'; import { api } from '../api';
const links=ref<Record<string,string|boolean>>({}),copied=ref(''),error=ref(''); onMounted(async()=>{try{links.value=await api.get('/api/admin/subscription-examples')}catch(e){error.value=e instanceof Error?e.message:'载入失败'}});
const linkEntries=computed(()=>Object.entries(links.value).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
async function copy(key:string,url:string){await navigator.clipboard.writeText(url);copied.value=key;setTimeout(()=>copied.value='',1500)}
const labels:Record<string,string>={normalJson:'普通源 · JSON',allBase58:'全部源 · Base58',normalProxy:'普通源 · 代理'};
</script>
<template><section class="panel subscriptions"><div><div class="eyebrow">SUBSCRIPTIONS</div><h2>订阅地址</h2><p>令牌始终以占位符显示，复制后请自行替换。</p></div><p v-if="error" class="error">{{error}}</p><template v-else><div v-for="[key,url] in linkEntries" :key="key" class="copy-row"><div><b>{{labels[key]}}</b><code>{{url}}</code></div><button class="ghost" @click="copy(key,url)">{{copied===key?'已复制':'复制'}}</button></div></template></section></template>
