<script setup lang="ts">
defineProps<{ title: string; description: string; confirmText?: string; busy?: boolean }>();
const emit = defineEmits<{ cancel: []; confirm: [] }>();
</script>

<template>
  <div class="modal confirm-modal" role="presentation" @click.self="!busy && emit('cancel')">
    <section class="panel confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
      <div class="confirm-content">
        <span class="confirm-icon" aria-hidden="true">!</span>
        <div>
          <h2 id="confirm-title">{{ title }}</h2>
          <p id="confirm-description">{{ description }}</p>
        </div>
      </div>
      <footer>
        <button class="ghost" :disabled="busy" @click="emit('cancel')">取消</button>
        <button class="primary danger-primary" :disabled="busy" @click="emit('confirm')">{{ busy ? '处理中…' : (confirmText || '确认') }}</button>
      </footer>
    </section>
  </div>
</template>
