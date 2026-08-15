<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'; import { api } from '../api';
const links=ref<Record<string,string|boolean>>({}),copied=ref(''),error=ref(''),resetting=ref(false); async function load(){try{links.value=await api.get('/api/admin/subscription-examples')}catch(e){error.value=e instanceof Error?e.message:'载入失败'}} onMounted(load);
const linkEntries=computed(()=>Object.entries(links.value).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
async function copy(key:string,url:string){await navigator.clipboard.writeText(url);copied.value=key;setTimeout(()=>copied.value='',1500)}
async function resetToken(){if(!confirm('确定重置订阅令牌？所有旧订阅地址会立即失效。'))return;resetting.value=true;error.value='';try{await api.send('/api/admin/subscription-token/reset','POST');await load()}catch(e){error.value=e instanceof Error?e.message:'重置失败'}finally{resetting.value=false}}
const labels:Record<string,string>={normalJson:'普通源 · JSON',allBase58:'全部源 · Base58',normalProxy:'普通源 · 代理'};
</script>
<template><section class="panel subscriptions"><div class="page-head"><div><div class="eyebrow">SUBSCRIPTIONS</div><h2>订阅地址</h2><p>订阅令牌由系统首次启动时自动生成，以下地址可直接复制使用。</p></div><button v-if="links.tokenCanReset" class="ghost danger" :disabled="resetting" @click="resetToken">{{resetting?'重置中…':'重置令牌'}}</button></div><p v-if="error" class="error">{{error}}</p><template v-else><div v-for="[key,url] in linkEntries" :key="key" class="copy-row"><div><b>{{labels[key]}}</b><code>{{url}}</code></div><button class="ghost" @click="copy(key,url)">{{copied===key?'已复制':'复制'}}</button></div></template></section></template>
