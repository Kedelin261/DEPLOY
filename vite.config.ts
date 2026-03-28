import { defineConfig } from 'vite'
import pages from '@hono/vite-cloudflare-pages'

export default defineConfig(({ mode }) => ({
  plugins: [pages()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: './src/index.tsx',
    }
  },
  resolve: {
    alias: {
      '@': '/src'
    }
  }
}))
