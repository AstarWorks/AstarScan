import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',

  ssr: false,

  devtools: { enabled: true },

  devServer: { port: 3005 },

  modules: ['shadcn-nuxt', '@vite-pwa/nuxt'],

  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'AstarScan — Edge Document Scanner',
      short_name: 'AstarScan',
      description: 'スマホで書類を電子化。完全オフラインのエッジスキャナー。',
      theme_color: '#001f42',
      background_color: '#ffffff',
      display: 'standalone',
      orientation: 'portrait',
      lang: 'ja',
      icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
    },
  },

  shadcn: {
    prefix: '',
    componentDir: '~/components/ui',
  },

  css: ['~/assets/css/main.css'],

  vite: {
    plugins: [tailwindcss()],
    server: { hmr: { overlay: false } },
    worker: { format: 'es' as const },
    optimizeDeps: {
      exclude: ['onnxruntime-web', 'onnxruntime-web/wasm'],
    },
  },

  postcss: {
    plugins: {
      '@tailwindcss/postcss': {},
      autoprefixer: {},
    },
  },

  nitro: {
    preset: 'static',
  },

  typescript: {
    strict: true,
    typeCheck: false,
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
        { name: 'theme-color', content: '#001f42' },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
})
