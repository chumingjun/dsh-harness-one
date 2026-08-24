# Workflow One × Harness Desktop

本文说明两件事：在 [Harness Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)（DSH 官方 Electron 桌面壳）里安装使用 Workflow One，以及本仓库插件如何做到「同一份代码同时兼容 Desktop 与普通 dsh」。

TL;DR：**Desktop 不需要任何专用安装脚本或专用插件分支**——一切走 `dsh plugin add`；开发兼容只依赖一条规则：Desktop 专属能力（profile 探测、受管 pnpm）用 `ctx.get('desktopProfiles')` 动态探测，探测不到就走普通 dsh 路径。

---

## 1. 在 Harness Desktop 里安装使用

### 1.1 安装（一条命令）

从 Desktop 托盘菜单打开 **Open DSH Terminal**（该终端已绑定当前 profile），执行：

```sh
dsh plugin add dsh-ccpg-one@0.2.1
```

聚合包自带 `dsh.bundle.patch`：`dsh plugin add` 一步完成「装依赖 + 进 bundles 层 + 挂载」7 个默认插件与 better-sidebar。安装完成后**重启 Desktop**（新 bundle 要在下一次 Loader 组合中生效）。

逐包安装（不想要聚合包时）等价于对每个包重复 `dsh plugin add dsh-ccpg-<name>`；注意 better-sidebar 不在 7 个默认插件内，逐包路径需单独 `dsh plugin add dsh-better-sidebar`，否则官方 UI 右侧工作台侧栏（含「工作流」tab）不可用——独立全屏画布 `/wf1/` 不受影响。

不要在 Desktop 里运行本仓库的 `setup.sh`：它面向普通 dsh，会创建/修改 profile、依赖系统全局 dsh/npm、写固定 Web 端口；Desktop 自己管理 profile、Node/pnpm 与随机 loopback 端口，这些都不该被脚本覆盖。

### 1.2 使用

重启后与普通 dsh Web UI 完全同构：

- **官方对话主区**照常使用；点输入框旁的工作流按钮展开画布，或新标签页开 `http://127.0.0.1:<端口>/wf1/`（端口随机，以 Desktop 窗口实际地址为准）
- **飞书扫码**：设置 → 飞书账号 → 扫码登录飞书。首次会提示安装 lark-cli——点「自动安装」即可，插件通过 Desktop 的受管 pnpm 把固定版本 `@larksuite/cli` 装进**当前 profile**（切换 profile 需分别安装）
- **模型**：与普通 dsh 相同，在官方 UI「模型」页选型、存 key（dsh 用户级 credentials）

### 1.3 Desktop 环境须知（与普通 dsh 的差异）

| 方面 | 普通 dsh | Harness Desktop |
|---|---|---|
| lark-cli 安装 | setup.sh / 插件自举装到 `~/.local/npm-global` | 用户点击「自动安装」后经受管 pnpm 装进当前 profile |
| Web 端口 | profile patch 固定（如 4021） | 随机 loopback 端口，勿改 |
| profile 管理 | `dsh --profile <name>` | Desktop 托盘/设置切换（切换 = 重启新 generation） |
| pnpm 操作 | 系统 pnpm | Desktop 受管 pnpm，**一个 generation 同时只允许一个包操作** |

### 1.4 常见问题排查

- **点「扫码登录飞书」没反应**：Desktop 的 pnpm 子进程强制 `CI=true`，若 profile 的 `pnpm-workspace.yaml` 里残留 pnpm 写入的占位值（`allowBuilds.'@larksuite/cli': set this to true or false`），`pnpm exec` 会静默 exit=1。0.1.0+ 的插件已内置自愈（自动把占位符改为 `true` 并补装）；旧版手动把该值改为 `true` 后在 profile 目录跑一次 `pnpm install`，重启 Desktop
- **设置 → 插件列表里找不到 better-sidebar**：说明走的是逐包安装路径，单独 `dsh plugin add dsh-better-sidebar` 即可（见 1.1）
- **页面空白/侧边栏整体消失**：检查 Desktop 设置里的呈现模式。compatibility（默认）与 advanced 都支持本套件；advanced 模式故障属于 Desktop 壳自身问题
- **日志/状态位置**：Desktop 私有状态在 `~/Library/Application Support/DSH Desktop/`（macOS）；dsh 侧仍是 `~/.dsh/`（settings.yaml / profiles / sessions）

---

## 2. Desktop 开发兼容方式（给本仓库贡献者）

### 2.1 官方契约：两个公开 Host service

Desktop 在 Electron main 进程的 Host Cordis generation 上多提供两个公开 service（完整契约见 upstream `dsh-plugin-desktop/docs/plugin-services.md`）：

- **`desktopProfiles`**：`current`（`{name, dir}`，一个 generation 内不可变）/ `list()` / `select(name)`（= 请求重启，不是原地切换）
- **`desktopPnpm`**：`run(args)`（低层 pnpm，cwd = profile 目录）/ `runPlugin(args, invokingDir)`（`dsh plugin --profile <active>` 语义，装/卸/更新插件用它）

关键边界：

- 这两个 service **只在 Desktop 中存在**——`ctx.get('desktopProfiles')` 返回 `undefined` 即普通 dsh 环境，这是官方指定的环境判别器
- Renderer（浏览器端）**读不到**它们；带 UI 的插件继续走普通 DSH Web routes / slots / client bundle，不要给 client 侧写 Desktop 分支
- `desktopRuntime` / `desktopPnpmBootstrap` / Electron API 是 Desktop 私有实现，不依赖
- `desktopPnpm` 一个 generation 同时只允许一个包操作（并发第二个同步抛错）；子进程环境强制注入 `CI=true`、electron 构建三件套（`npm_config_runtime=electron` 等）——任何依赖 pnpm 的逻辑要按「CI 模式、无交互、报错可能被吞」设计

### 2.2 跨环境插件的标准写法

**铁律：Desktop service 不进顶层 `inject`**（否则普通 dsh 里插件永远 pending）。用动态探测 + 嵌套 `ctx.inject`，实参示例即 `dsh-ccpg-larkauth/lib/index.js`：

```js
export const inject = ['webServer'];           // 只声明两边都有的依赖

export function apply(ctx) {
  const profiles = ctx.get('desktopProfiles'); // undefined = 普通 dsh
  if (profiles === undefined) {
    mount(ctx, null);                          // 普通 dsh：本机 lark-cli
    return;
  }
  ctx.inject(['desktopPnpm'], (desktopCtx) => { // 嵌套注入等 desktopPnpm
    const runtime = createDesktopLarkCliRuntime({
      desktopPnpm: desktopCtx.desktopPnpm,
      profileDir: profiles.current.dir,        // profile 目录以 current 为准
    });
    mount(desktopCtx, runtime, { desktop: true });
  });
}
```

要点：

- runtime 抽象统一两套执行链（`runtime.run(args)` / `runtime.install()` / `runtime.qrcode()`），上层业务函数（`larkAuthStatus` / `larkLoginStart` …）对环境无感知。Desktop 的 `runtime.run()` 直接执行当前 profile 内已下载的 `@larksuite/cli/bin/lark-cli`，避免把状态查询和授权命令放进 Electron 的 pnpm 子进程；`desktopPnpm` 只负责安装与修复该 profile 的包
- `desktopPnpm.run()` 返回 handle（stdout/stderr 流 + `done` promise + `cancel()`），**没有内建超时**——仅包操作使用它，调用方自己包 AbortController/定时器，退出时在 `ctx.effect` disposer 里 `cancel()` 并 `await done`
- 包操作（add/install）只应由**明确的用户动作**触发（Desktop 官方 checklist 第 1 条）；插件启动时探测到未安装就等待用户确认，不要自作主张改 profile

### 2.3 插件形态通用约束（Desktop 下同样生效）

- **包入口不得有 `default` 导出**：loader 的 `unwrapExports` 是 `exports.default ?? exports`，default 存在时你的 `apply`/`inject` 会被整个忽略（document-preview 踩过：host 路由从未挂载）。同时注意包有 `exports` 字段时 `main` 被忽略，插件入口必须写在 `exports['.']`
- **client bundle 全自包含**：浏览器动态 import 没有 importmap，裸 `react` 等模块说明符解析不了；构建加 `define: {'process.env.NODE_ENV': '"production"'}`（React dev 分支的 `process.env` 引用会炸浏览器）
- **静态资源自托管**：上游 `dsh-client-modules` 只服务 `/plugins/<id>/client.js` 精确路径；插件懒加载 chunk / 样式要自己注册 `ctx.webServer` prefix 路由（见 `dsh-ccpg-document-preview/src/host.js`）
- **改插件代码后必须彻底重启 Desktop**（同 dsh HMR 缓存问题）；排查 boot 失败直接命令行启动 `/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop` 能拿到完整报错栈

### 2.4 验证清单（Desktop 相关改动必过）

1. 普通 dsh：`desktopProfiles` 不存在时插件照常加载（`npm test` 的 plugin-environments 套覆盖）
2. Desktop：profile 目录/名称与用户实际选择一致；包操作的超时、取消、非零退出、generation teardown 有测试（desktop-runtime 套）
3. 浏览器端在 Desktop loopback 上实测：client bundle 200、控制台无报错、slot 注册生效
4. Playwright 模拟 Desktop 渲染器时带上 query 参数：`?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin`（不带会触发 dsh-plugin-desktop 的 invalid mode 报错，那是预期行为）
