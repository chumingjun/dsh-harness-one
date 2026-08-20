import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base 从环境变量取：dsh 插件路径下挂 /wf1/（WF1_BASE=/wf1/），
// 旧 Express 独立部署时默认 '/'（同源根）。
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: process.env.WF1_BASE || '/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4020',
    },
  },
}));
