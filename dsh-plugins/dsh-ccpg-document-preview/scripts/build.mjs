import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  root,
  plugins: [react()],
  build: {
    outDir: dist,
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: { entry: resolve(root, 'src/react.jsx'), formats: ['es'], fileName: () => 'react.js' },
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client', 'react-markdown', 'remark-gfm'],
      output: {
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'document-preview.css' : 'assets/[name]-[hash][extname]',
        chunkFileNames: 'renderers/[name]-[hash].js',
      },
    },
  },
});

await build({
  root,
  plugins: [react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: resolve(dist, 'client-assets'),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: resolve(root, 'src/client.jsx'), formats: ['es'], fileName: () => 'runtime.js' },
    rollupOptions: {
      // runtime.js 经动态 import 进官方 UI（无 importmap，裸 "react" 解析不了），
      // 全部自包含；define production 防 React dev 分支带进 process.env 引用
      output: {
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'document-preview.css' : 'assets/[name]-[hash][extname]',
        chunkFileNames: 'renderers/[name]-[hash].js',
      },
    },
  },
});

const client = `(function () {\n  var scriptUrl = document.currentScript && document.currentScript.src;\n  window.__ModuleLoader__.load({\n  id: "dsh-ccpg-document-preview",\n  factory: function () {\n    var exports = {};\n    function apply() {\n      if (window.__dshDocumentPreviewLoading) return;\n      window.__dshDocumentPreviewLoading = true;\n      var base = new URL("./client-assets/", scriptUrl || document.baseURI);\n      var link = document.createElement("link");\n      link.rel = "stylesheet";\n      link.href = new URL("document-preview.css", base).href;\n      link.dataset.dshDocumentPreview = "style";\n      if (!document.querySelector('link[data-dsh-document-preview="style"]')) document.head.appendChild(link);\n      import(new URL("runtime.js", base).href).catch(function (error) {\n        window.__dshDocumentPreviewLoading = false;\n        console.error("dsh-ccpg-document-preview failed to load", error);\n      });\n    }\n    exports.apply = apply;\n    exports.name = "dsh-ccpg-document-preview/client";\n    exports.inject = [];\n    return exports;\n  }\n  });\n})();\n`;
await writeFile(resolve(dist, 'client.js'), client);
