// dsh-ccpg-canvasui host 半：只做插件声明，画布静态资源与 /wf1/api/* 由
// dsh-ccpg-web / dsh-ccpg-orchestrator 提供；本插件仅注册官方 UI 的工作流 tab（client 半）。

export const name = 'dsh-ccpg-canvasui';
export const inject = ['webServer'];

export function apply(_ctx) {
  // 无 host 侧逻辑；client 半（lib/client.js）在 conversation.view 注册 id=workflow 的 tab。
}
