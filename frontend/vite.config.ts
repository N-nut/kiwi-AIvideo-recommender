/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../demo', import.meta.url))] },
    proxy: { '/api': 'http://127.0.0.1:8000', '/health': 'http://127.0.0.1:8000', '/demo': 'http://127.0.0.1:8000' },
  },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'] },
});
