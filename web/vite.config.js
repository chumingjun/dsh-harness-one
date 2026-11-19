import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base 从环境变量取：dsh 插件路径下挂 /wf1/（WF1_BASE=/wf1/）。
// dev 开发：WF1_BASE=/wf1/ npm run dev 起 5173/wf1/，
// 前端 API base 解析为 /wf1，请求 /wf1/api/* 经代理转发到 dsh 插件端口（默认 4021）。
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: process.env.WF1_BASE || '/',
  server: {
    port: 5173,
    proxy: {
      '/wf1/api': 'http://127.0.0.1:4021',
    },
  },
}));
