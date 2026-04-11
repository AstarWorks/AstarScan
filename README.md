# AstarScan

Edge document scanner PWA — point your phone at a stack of paper, flip through pages,
and watch unique pages automatically extracted into a PDF. Fully offline, $0 cost,
MIT licensed.

## Why AstarScan?

Designed for **law firms** and **construction sites** where paper documents are
messy, mixed-size, bound, and need to be digitized quickly on location. Unlike
dedicated ADF scanners (great for uniform office stacks), AstarScan handles
the chaos of real-world paper — bindings, sticky notes, torn originals,
handwritten memos mixed with faxes — all with a device already in your pocket.

## Three ways to use

### 1. Web app (no install)

Visit [scan.astarworks.com](https://scan.astarworks.com), add to home screen,
start scanning. Works offline after first load. No account required.

### 2. Embed as Web Component

```html
<script type="module" src="https://scan.astarworks.com/element.js"></script>
<astar-scan mode="video" lang="ja" max-pages="100"></astar-scan>
```

### 3. Import as library

```ts
import { ScanPipeline } from '@astarworks/scan-core'

const pipeline = new ScanPipeline({ mode: 'video', fps: 10 })
await pipeline.start(videoElement)
```

Vue/Nuxt projects:

```vue
<script setup>
import { useScanner } from '@astarworks/scan-vue'
const { state, pages, start, exportPdf } = useScanner({ mode: 'video' })
</script>
```

## Packages

| Package                    | Purpose                                | Framework                  |
| -------------------------- | -------------------------------------- | -------------------------- |
| `@astarworks/scan-core`    | Pipeline, edge detection, PDF assembly | Pure TypeScript            |
| `@astarworks/scan-vue`     | Composables + components               | Vue 3 (no Nuxt dependency) |
| `@astarworks/scan-element` | `<astar-scan>` Web Component           | Vue 3 + Custom Elements    |
| `apps/web`                 | scan.astarworks.com PWA                | Nuxt 4 SPA                 |

## Development

Requires [Bun](https://bun.sh) ≥ 1.1.0.

```bash
bun install
bun run dev:web        # Start the Nuxt PWA
bun run test           # Run all tests
bun run typecheck      # Type-check all packages
bun run build          # Build all packages
```

## Privacy

**All processing happens on your device.** No images, PDFs, or personal data
are ever sent to any server. Scanned sessions are stored in your browser's
IndexedDB and deleted when you export the PDF (or kept manually as drafts).

See [`apps/web/pages/privacy.vue`](apps/web/pages/privacy.vue) for the full
privacy policy.

## Browser support

| Platform              | Minimum version |
| --------------------- | --------------- |
| iOS Safari            | 15.0+           |
| Android Chrome        | 100+            |
| Desktop Chrome / Edge | 100+            |
| Desktop Firefox       | 100+            |
| Desktop Safari        | 15.4+           |

## License

[MIT](./LICENSE) © 2026 AstarWorks
