// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',

  // SPA mode — no server-side rendering.
  // AstarScan is an edge-first PWA with 100% client-side processing;
  // there is no server component to render against, and SSR would
  // just slow down the initial load for no benefit.
  ssr: false,

  devtools: { enabled: true },

  // Static output for Cloudflare Pages. `nuxt generate` produces
  // pure HTML/JS/CSS into `.output/public/` — no Nitro runtime, no
  // Workers, no Functions. Deploy with:
  //   npx wrangler pages deploy .output/public --project-name=astar-scan
  nitro: {
    preset: 'static',
  },

  typescript: {
    strict: true,
    typeCheck: false, // run via `bun run --cwd apps/web typecheck`
  },

  app: {
    head: {
      title: 'AstarScan — Edge Document Scanner',
      htmlAttrs: {
        lang: 'ja',
      },
      meta: [
        { charset: 'utf-8' },
        {
          name: 'viewport',
          content:
            'width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no',
        },
        {
          name: 'description',
          content:
            'スマホで大量の紙書類を PDF に — 動画ストリーミングでユニークなページを自動抽出する完全オフラインのエッジスキャナー。',
        },
        { name: 'theme-color', content: '#0f172a' },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
})
