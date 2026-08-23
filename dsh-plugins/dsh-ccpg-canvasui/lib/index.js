// dsh-ccpg-canvasui host 半：只做插件声明，画布静态资源与 /wf1/api/* 由
// dsh-ccpg-web / dsh-ccpg-orchestrator 提供；client 半注册官方 UI 的工作流侧栏。

export const name = 'dsh-ccpg-canvasui';
export const inject = ['webServer'];

export function apply() {}
