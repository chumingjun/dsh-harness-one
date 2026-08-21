// dsh-ccpg-one：聚合壳（无运行时代码）。
// 职责只有两件：dependencies 拉齐八个 dsh-ccpg-* 插件（+ 软依赖 better-sidebar），
// cordis.patch.yml 把它们一次性挂载。真正的实现全在各插件包内。
// 可选件（larkauth/brand/document-preview/better-sidebar）用 disabled: !!js
// 表达式按 CCPG_* 环境变量门控——用户 export CCPG_NO_LARK=1 即整行不加载。
export const name = 'dsh-ccpg-one';
export const inject = [];
export function apply() {}
