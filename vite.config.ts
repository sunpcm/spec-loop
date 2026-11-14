import { defineConfig, type Plugin } from 'vite';

declare global {
  const __APP_VERSION__: string;
}

type BuildEnvironment = Record<string, string | undefined>;

export function resolveAppVersion(env: BuildEnvironment = process.env): string {
  const explicitVersion = env.SPEC_LOOP_VERSION?.trim();
  if (explicitVersion) return explicitVersion;
  return env.VERCEL_GIT_COMMIT_SHA?.trim() || 'dev';
}

export function resolveAssetBase(env: BuildEnvironment = process.env): string {
  if (env.VERCEL === '1') return '/';
  return env.SPEC_LOOP_ASSET_BASE?.trim() || '/';
}

export function versionManifestPlugin(version: string): Plugin {
  return {
    name: 'spec-loop-version-manifest',
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
    base: resolveAssetBase(),
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    plugins: [versionManifestPlugin(version)],
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
    },
    build: {
      outDir: process.env.VERCEL === '1' ? 'dist' : process.env.SPEC_LOOP_OUT_DIR?.trim() || 'dist',
      emptyOutDir: true,
      sourcemap: false,
    },
  };
});
