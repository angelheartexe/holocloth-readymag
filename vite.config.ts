import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5199,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        word: resolve(import.meta.dirname, 'word.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
      },
    },
  },
});
