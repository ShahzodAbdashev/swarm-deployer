import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// @devtools/ui is a symlinked TypeScript source package (file:../../shared-ui).
// preserveSymlinks resolves its imports (react, react-dom) from this app's node_modules, so there is one React.
export default defineConfig({
  plugins: [react()],
  resolve: {preserveSymlinks: true, dedupe: ['react', 'react-dom']},
  optimizeDeps: {exclude: ['@devtools/ui']},
  build: {outDir: 'dist', emptyOutDir: true, sourcemap: false},
  server: {
    port: 5173,
    proxy: {'/api': {target: 'http://127.0.0.1:8095', changeOrigin: false}},
  },
});
