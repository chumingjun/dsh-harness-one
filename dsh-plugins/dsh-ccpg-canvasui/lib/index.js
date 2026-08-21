// dsh-ccpg-canvasui host 半：只做插件声明，画布静态资源与 /wf1/api/* 由
// dsh-ccpg-web / dsh-ccpg-orchestrator 提供；本插件仅注册官方 UI 的工作流 tab（client 半）。

export const name = 'dsh-ccpg-canvasui';
export const inject = ['webServer', 'commands'];

export function apply(ctx) {
  ctx.commands.register({
    name: 'workflow',
    description: '打开当前会话的工作流画布',
    handler: () => ({ kind: 'success', text: '工作流画布已打开。' }),
  });
}
