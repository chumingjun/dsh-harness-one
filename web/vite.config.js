import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 画布挂在 /wf1/，完整功能需通过 dsh 宿主注入会话。
export default defineConfig({
  plugins: [react()],
  base: process.env.WF1_BASE || '/',
  server: {
    port: 5173,
  },
});
