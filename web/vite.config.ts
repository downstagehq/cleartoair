import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const agent = 'http://127.0.0.1:7700';

// The release version (root package.json), for the About dialog when the agent
// cannot be asked. The agent's /api/version wins when it answers.
const rootPkg = fileURLToPath(new URL('../package.json', import.meta.url));
const version = String((JSON.parse(readFileSync(rootPkg, 'utf8')) as { version?: string }).version ?? '');
// The About dialog's supporters and sponsors (imported at build time).
const credits = fileURLToPath(new URL('../credits.json', import.meta.url));

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    // The dev server may read web/ and the one root file the bundle imports, nothing else above it.
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), credits] },
    proxy: {
      '/api': { target: agent, changeOrigin: true },
      '/ws': { target: agent, ws: true },
      '/packs': { target: agent, changeOrigin: true },
      '/overlays': { target: agent, changeOrigin: true },
      '/healthz': { target: agent, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
