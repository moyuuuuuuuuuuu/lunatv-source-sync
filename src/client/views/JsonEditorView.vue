<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../api';

interface Preview { inserted:number; updated:number; invalid:number; errors:Array<{sourceKey:string;message:string}> }
const text = ref('{\n  "api_site": {\n\n  }\n}');
const policy = ref<'skip'|'overwrite'>('skip');
const preview = ref<Preview>();
const document = ref<unknown>();
const busy = ref(false), error = ref(''), message = ref('');
watch(text, () => { preview.value=undefined; document.value=undefined; message.value=''; });

async function validate() {
  busy.value=true; error.value=''; message.value=''; preview.value=undefined;
  try { document.value=JSON.parse(text.value); preview.value=await api.send('/api/admin/import/preview','POST',document.value); }
  catch(cause){error.value=cause instanceof SyntaxError?`JSON 语法错误：${cause.message}`:cause instanceof Error?cause.message:'JSON 无效'}
  finally{busy.value=false}
}
async function apply(){if(!document.value||!preview.value)return;busy.value=true;error.value='';try{const result=await api.send<{inserted:number;updated:number;skipped:number}>('/api/admin/import/apply','POST',{document:document.value,duplicateApiPolicy:policy.value});message.value=`导入完成：新增 ${result.inserted}，更新 ${result.updated}，跳过 ${result.skipped}`;preview.value=undefined;document.value=undefined}catch(cause){error.value=cause instanceof Error?cause.message:'导入失败'}finally{busy.value=false}}
</script>

<template><section><div class="page-head"><div><div class="eyebrow">JSON EDITOR</div><h1>JSON 编辑器</h1><p>粘贴 LunaTV JSON 配置，校验后批量导入视频源。</p></div></div><div class="panel json-editor"><label>配置 JSON<textarea v-model="text" spellcheck="false" aria-label="LunaTV JSON 配置"></textarea></label><div class="editor-toolbar"><label>API 地址重复时<select v-model="policy"><option value="skip">跳过，保留已有来源</option><option value="overwrite">覆盖已有来源</option></select></label><div class="actions"><button class="ghost" :disabled="busy" @click="validate">{{busy?'校验中…':'校验并预览'}}</button><button class="primary" :disabled="busy||!preview" @click="apply">批量导入</button></div></div><p v-if="error" class="error" role="alert">{{error}}</p><p v-if="message" class="good" role="status">{{message}}</p><div v-if="preview" class="preview"><b>新增 {{preview.inserted}}</b><b>更新 {{preview.updated}}</b><b :class="{bad:preview.invalid}">无效 {{preview.invalid}}</b></div><ul v-if="preview?.errors.length" class="errors"><li v-for="item in preview.errors" :key="item.sourceKey"><code>{{item.sourceKey||'(空键)'}}</code>：{{item.message}}</li></ul></div></section></template>
