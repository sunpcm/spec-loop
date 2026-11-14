import { defineConfig } from 'vite';

declare global {
  const __APP_VERSION__: string;
}

export default defineConfig({
  base: process.env.SPEC_LOOP_ASSET_BASE ?? '/',
  define: {
    __APP_VERSION__: JSON.stringify(process.env.SPEC_LOOP_VERSION ?? 'dev'),
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: process.env.SPEC_LOOP_OUT_DIR ?? 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
