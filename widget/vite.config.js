import { defineConfig } from 'vite';

// Library mode -> one self-contained IIFE bundle a tenant drops in with a
// <script> tag. No framework, no code-splitting, no external deps.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.js',
      name: 'HiveDeskWidget',
      formats: ['iife'],
      fileName: () => 'hivedesk-widget.js',
    },
    minify: 'terser',
    cssCodeSplit: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
    // Keep everyone honest about bundle weight.
    chunkSizeWarningLimit: 50,
  },
});
