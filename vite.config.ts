import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  define: { 'process.env.IS_PREACT': 'false' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_TARGET || 'http://127.0.0.1:3001' },
      '/sync': { target: process.env.API_TARGET || 'http://127.0.0.1:3001', ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 5000 },
});
