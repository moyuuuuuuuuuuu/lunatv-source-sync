<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { api } from '../api';

interface Preview { inserted:number; updated:number; invalid:number; errors:Array<{sourceKey:string;message:string}> }
const jsonTemplate = `{
  "cache_time": 7200,
  "api_site": {
    "example": {
      "name": "示例资源",
      "api": "https://example.com/api.php/provide/vod/",
      "detail": "",
      "_comment": "可选备注",
      "adult": false
    }
  }
}`;
const text = ref(jsonTemplate);
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
function useTemplate(){text.value=jsonTemplate;error.value=''}
function formatJson(){try{text.value=JSON.stringify(JSON.parse(text.value),null,2);error.value=''}catch(cause){error.value=cause instanceof Error?`无法格式化：${cause.message}`:'JSON 格式错误'}}
async function insertTab(event:KeyboardEvent){const input=event.target as HTMLTextAreaElement;const start=input.selectionStart;const end=input.selectionEnd;text.value=`${text.value.slice(0,start)}  ${text.value.slice(end)}`;await nextTick();input.setSelectionRange(start+2,start+2)}
</script>

<template><section><div class="page-head"><div><div class="eyebrow">JSON EDITOR</div><h1>JSON 编辑器</h1><p>粘贴 LunaTV JSON 配置，校验后批量导入视频源。</p></div></div><div class="panel json-editor"><div class="editor-template"><div><b>LunaTV JSON 模板</b><p><code>api_site</code> 下每个键代表唯一来源；<code>name</code> 和 <code>api</code> 必填，其他字段可选。</p></div><button class="ghost" type="button" @click="useTemplate">使用模板</button></div><div class="editor-field"><div class="editor-field-head"><span><i></i> config.json</span><button type="button" @click="formatJson">格式化 JSON</button></div><label class="sr-only" for="json-config-editor">配置 JSON</label><textarea id="json-config-editor" v-model="text" spellcheck="false" aria-label="LunaTV JSON 配置" @keydown.tab.prevent="insertTab"></textarea><div class="editor-status"><span>JSON</span><span>{{text.split('\n').length}} 行 · {{text.length}} 字符</span></div></div><div class="editor-toolbar"><label>API 地址重复时<select v-model="policy"><option value="skip">跳过，保留已有来源</option><option value="overwrite">覆盖已有来源</option></select></label><div class="actions"><button class="ghost" :disabled="busy" @click="validate">{{busy?'校验中…':'校验并预览'}}</button><button class="primary" :disabled="busy||!preview" @click="apply">批量导入</button></div></div><p v-if="error" class="error" role="alert">{{error}}</p><p v-if="message" class="good" role="status">{{message}}</p><div v-if="preview" class="preview"><b>新增 {{preview.inserted}}</b><b>更新 {{preview.updated}}</b><b :class="{bad:preview.invalid}">无效 {{preview.invalid}}</b></div><ul v-if="preview?.errors.length" class="errors"><li v-for="item in preview.errors" :key="item.sourceKey"><code>{{item.sourceKey||'(空键)'}}</code>：{{item.message}}</li></ul></div></section></template>
