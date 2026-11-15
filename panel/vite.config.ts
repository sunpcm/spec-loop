import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const panelRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: panelRoot,
  base: '/',
  build: {
    outDir: fileURLToPath(new URL('../.orchestrator/panel-dist', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
  },
});
