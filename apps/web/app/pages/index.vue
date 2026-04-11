<script setup lang="ts">
// Workspace smoke test: if these imports don't resolve, the whole
// monorepo dependency chain (apps/web → scan-vue → scan-core) is broken.
// Real usage comes in Phase 1a when the pipeline is wired up.
import type { CapturedPage, UseScannerReturn } from '@astarworks/scan-vue'

defineProps<{
  initialScanner?: UseScannerReturn
  seedPages?: readonly CapturedPage[]
}>()
</script>

<template>
  <main class="landing">
    <div class="landing__inner">
      <h1 class="landing__title">AstarScan</h1>
      <p class="landing__tagline">
        スマホを書類の山に向けて、ページをめくるだけ。<br />
        ユニークなページが自動でPDFになります。
      </p>
      <p class="landing__status">🚧 Coming soon — Phase 1a in progress</p>
    </div>
  </main>
</template>

<style scoped>
.landing {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100dvh;
  padding: 2rem;
  background: linear-gradient(180deg, #0f172a 0%, #1e293b 100%);
  color: #f1f5f9;
  font-family:
    'Hiragino Sans',
    'Hiragino Kaku Gothic ProN',
    'Yu Gothic UI',
    system-ui,
    -apple-system,
    sans-serif;
}
.landing__inner {
  max-width: 36rem;
  text-align: center;
}
.landing__title {
  font-size: clamp(3rem, 10vw, 5rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 1.5rem;
  background: linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.landing__tagline {
  font-size: 1.25rem;
  line-height: 1.75;
  color: #cbd5e1;
  margin: 0 0 2rem;
}
.landing__status {
  font-size: 0.875rem;
  color: #94a3b8;
  margin: 0;
}
</style>
