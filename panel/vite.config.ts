import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

type BuildEnvironment = Record<string, string | undefined>;

const panelRoot = fileURLToPath(new URL('.', import.meta.url));

export function resolveAppVersion(env: BuildEnvironment = process.env): string {
  const explicitVersion = env.SPEC_LOOP_VERSION?.trim();
  if (explicitVersion) return explicitVersion;
  return env.VERCEL_GIT_COMMIT_SHA?.trim() || 'panel';
}

export function resolveAssetBase(env: BuildEnvironment = process.env): string {
  if (env.VERCEL === '1') return '/';
  return env.SPEC_LOOP_ASSET_BASE?.trim() || '/';
}

export function versionManifestPlugin(version: string): Plugin {
  return {
    name: 'spec-loop-panel-version-manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify({ version }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig(() => {
  const version = resolveAppVersion();
  return {
    root: panelRoot,
    base: resolveAssetBase(),
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    plugins: [versionManifestPlugin(version)],
    build: {
      outDir:
        process.env.SPEC_LOOP_OUT_DIR?.trim()
        || fileURLToPath(new URL('../.orchestrator/panel-dist', import.meta.url)),
      emptyOutDir: true,
      assetsDir: 'assets',
      sourcemap: false,
    },
    server: {
      host: '127.0.0.1',
      port: 5175,
    },
  };
});
