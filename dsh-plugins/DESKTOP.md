# Workflow One × Harness Desktop

本文说明两件事：在 [Harness Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)（DSH 官方 Electron 桌面壳）里安装使用 Workflow One，以及本仓库插件如何做到「同一份代码同时兼容 Desktop 与普通 dsh」。

TL;DR：**Desktop 不需要任何专用安装脚本或专用插件分支**——一切走 `dsh plugin add`；开发兼容只依赖一条规则：Desktop 专属能力（profile 探测、受管 pnpm）用 `ctx.get('desktopProfiles')` 动态探测，探测不到就走普通 dsh 路径。

---

## 1. 在 Harness Desktop 里安装使用

### 1.1 安装（一条命令）

从 Desktop 托盘菜单打开 **Open DSH Terminal**（该终端已绑定当前 profile），执行：

```sh
dsh plugin add dsh-ccpg-one
```

聚合包自带 `dsh.bundle.patch`：`dsh plugin add` 一步完成「装依赖 + 进 bundles 层 + 挂载」7 个默认插件与 better-sidebar。安装完成后**重启 Desktop**（新 bundle 要在下一次 Loader 组合中生效）。

逐包安装（不想要聚合包时）等价于对每个包重复 `dsh plugin add dsh-ccpg-<name>`；注意 better-sidebar 不在 7 个默认插件内，逐包路径需单独 `dsh plugin add dsh-better-sidebar`，否则官方 UI 右侧工作台侧栏（含「工作流」tab）不可用——独立全屏画布 `/wf1/` 不受影响。

不要在 Desktop 里运行本仓库的 `setup.sh`：它面向普通 dsh，会创建/修改 profile、依赖系统全局 dsh/npm、写固定 Web 端口；Desktop 自己管理 profile、Node/pnpm 与随机 loopback 端口，这些都不该被脚本覆盖。

### 1.2 使用

重启后与普通 dsh Web UI 完全同构：

- **官方对话主区**照常使用；点输入框旁的工作流按钮展开画布，或新标签页开 `http://127.0.0.1:<端口>/wf1/`（端口随机，以 Desktop 窗口实际地址为准）
- **飞书扫码**：设置 → 飞书账号 → 扫码登录飞书。首次会提示安装 lark-cli——点「自动安装」即可，插件用宿主发布的包管理器把固定版本 `@larksuite/cli` 装进**当前 profile**（切换 profile 需分别安装）。已经装在 profile 里就直接用，不会再问你
- **模型**：与普通 dsh 相同，在官方 UI「模型」页选型、存 key（dsh 用户级 credentials）

### 1.3 Desktop 环境须知（与普通 dsh 的差异）

| 方面 | 普通 dsh | Harness Desktop |
|---|---|---|
| lark-cli 安装 | setup.sh / 插件自举装到 `~/.local/npm-global` | 用户点击「自动安装」后装进当前 profile；已在 profile 里就直接用 |
| lark-cli 探测面 | 全局 bin 目录 + `which` | profile 的 `node_modules/@larksuite/cli/bin/lark-cli`（GUI 进程 PATH 上没有它，也没有 npm） |
| Web 端口 | profile patch 固定（如 4021） | 随机 loopback 端口，勿改 |
| profile 管理 | `dsh --profile <name>` | Desktop 托盘/设置切换（切换 = 重启新 generation） |
| pnpm 操作 | 系统 pnpm | 宿主发布的包管理器（官方壳：`profileContext.packageManager`；第三方壳：`desktopPnpm`），**一个 generation 同时只允许一个包操作** |

### 1.4 常见问题排查

- **界面说「本机未安装 lark-cli」，但 profile 里明明有**：只扫全局 bin 目录与 `which` 的老插件会这样（GUI 进程 PATH 上本来就没有 lark-cli），官方壳还会因为没有 `desktopPnpm` service 被误判成普通 dsh，连点「自动安装」也是死路（那里没有 npm）。先 `ls <profile 目录>/node_modules/@larksuite/cli/bin/lark-cli` 确认，升级插件即可。命令行自查：`<profile 目录>/node_modules/@larksuite/cli/bin/lark-cli auth status --json`
- **点「扫码登录飞书」没反应**：包管理器子进程强制 `CI=true`，若 profile 的 `pnpm-workspace.yaml` 里残留 pnpm 写入的占位值（`allowBuilds.'@larksuite/cli': set this to true or false`），`pnpm exec` 会静默 exit=1。0.1.0+ 的插件已内置自愈（自动把占位符改为 `true` 并补装）；旧版手动把该值改为 `true` 后在 profile 目录跑一次 `pnpm install`，重启 Desktop
- **设置 → 插件列表里找不到 better-sidebar**：说明走的是逐包安装路径，单独 `dsh plugin add dsh-better-sidebar` 即可（见 1.1）
- **页面空白/侧边栏整体消失**：检查 Desktop 设置里的呈现模式。compatibility（默认）与 advanced 都支持本套件；advanced 模式故障属于 Desktop 壳自身问题
- **日志/状态位置**：Desktop 私有状态在 `~/Library/Application Support/DSH Desktop/`（macOS）；dsh 侧仍是 `~/.dsh/`（settings.yaml / profiles / sessions）

---

## 2. Desktop 开发兼容方式（给本仓库贡献者）

### 2.1 官方契约：两种宿主，两套 service

Desktop 生态里有两种壳，发布的 service **不同**，插件必须都能活下来：

| 宿主 | 判别方式 | 提供的 service | 装包通道 |
|---|---|---|---|
| 官方 Electron 壳（DeepSeek Harness.app） | `ctx.get('desktopProfiles') === undefined` | 只有内核的 `profileContext`：`{name, dir, packageManager}` | `profileContext.packageManager`（宿主自带 node + pnpm.mjs + 自己的 PATH） |
| 第三方壳 [deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) | `ctx.get('desktopProfiles')` 有值 | `desktopProfiles`（`current: {name, dir}` / `list()` / `select(name)`）+ `desktopPnpm`（`run(args)` / `runPlugin(args, dir)`） | `desktopPnpm.run()` |

**两套都没有**是真实发生过的故障：官方壳 0.2.0-rc.1 的整个 app.asar 里 `desktopProfiles` / `desktopPnpm` 零命中，于是插件退回「普通 dsh」分支，去 `~/.local/npm-global/bin`、`/usr/local/bin`、`which` 里找 lark-cli——而 lark-cli 明明装在 profile 的 node_modules 里，GUI 进程 PATH 上又没有软链、`npm` 也没有，于是界面永远显示「本机未安装 lark-cli」，扫码/续约/退出登录全被挡住。

因此探测顺序固定为：

```js
const profiles = ctx.get('desktopProfiles');
if (profiles !== undefined) { /* 第三方壳：受管 pnpm */ }
else {
  const profile = profileContextOf(ctx.get('profileContext')); // 官方壳：profile 目录 + 宿主包管理器
  if (profile?.packageManager) { /* 官方壳：直连 profile 内二进制 + 宿主 pnpm 装包 */ }
  else { /* 普通 dsh：npm i -g，但探测面仍要认 profile 目录 */ }
}
```

官方壳的其余边界（完整契约见 upstream `dsh-plugin-desktop/docs/plugin-services.md`）：

- **`desktopProfiles`**：一个 generation 内 `current` 不可变；`select(name)` = 请求重启，不是原地切换
- **`desktopPnpm`**：`run(args)` 返回 handle（stdout/stderr 流 + `done` promise + `cancel()`），**没有内建超时**——仅包操作使用它，调用方自己包 AbortController/定时器，退出时在 `ctx.effect` disposer 里 `cancel()` 并 `await done`；一个 generation 同时只允许一个包操作（并发第二个同步抛错），子进程环境强制注入 `CI=true`、electron 构建三件套
- **`profileContext.packageManager`**：`{command, args, env}`，逐字段校验后使用；env 合并规则照抄 dshmarket 的 `spawnEnv`——宿主那份 env 在前（GUI 进程 PATH 上通常什么都没有，内置 Node 必须赢），`CI=true` 压过一切
- `desktopRuntime` / `desktopPnpmBootstrap` / Electron API 是 Desktop 私有实现，不依赖
- Renderer（浏览器端）**读不到**任何 service；带 UI 的插件继续走普通 DSH Web routes / slots / client bundle，不要给 client 侧写 Desktop 分支

### 2.2 跨环境插件的标准写法

**铁律：Desktop service 不进顶层 `inject`**（否则普通 dsh 里插件永远 pending）。用动态探测 + 嵌套 `ctx.inject`，实参示例即 `dsh-ccpg-larkauth/lib/index.js`：

```js
export const inject = ['webServer'];           // 只声明两边都有的依赖

export function apply(ctx) {
  const profiles = ctx.get('desktopProfiles'); // 有值 = 第三方壳
  if (profiles !== undefined) {
    ctx.inject(['desktopPnpm'], (desktopCtx) => { // 嵌套注入等 desktopPnpm
      mount(desktopCtx, createDesktopLarkCliRuntime({
        desktopPnpm: desktopCtx.desktopPnpm,
        profileDir: profiles.current.dir,        // profile 目录以 current 为准
      }), { desktop: true });
    });
    return;
  }
  // 官方壳没有那两个 service，只有 profileContext；再退才是普通 dsh
  const profile = profileContextOf(ctx.get('profileContext'));
  if (profile?.packageManager) {                // 官方壳：宿主自带 pnpm
    mount(ctx, createDesktopLarkCliRuntime({
      profileDir: profile.dir,
      packageManager: profile.packageManager,
    }), { desktop: true });
    return;
  }
  setLarkProfileDir(profile?.dir);               // 普通 dsh，但探测面认 profile 目录
  mount(ctx, null);
}
```

要点：

- **探测必须逐级退到底**：只判 `desktopProfiles` 会把官方壳误认成普通 dsh（见 2.1 的故障）；只判 `profileContext` 又会漏掉第三方壳。两条路都要走
- runtime 抽象统一执行链（`runtime.run(args)` / `runtime.install()` / `runtime.qrcode()`），上层业务函数（`larkAuthStatus` / `larkLoginStart` …）对环境无感知。`runtime.run()` 直接执行当前 profile 内已下载的 `@larksuite/cli/bin/lark-cli`，避免把状态查询和授权命令放进包管理器子进程；装包通道才走 `desktopPnpm` 或宿主发布的包管理器
- **探测面要覆盖 profile 目录**：`lark-cli` 装在 profile 里时不在任何全局 bin 目录，PATH 上通常也没有软链。只扫 `~/.local/npm-global/bin`、`/usr/local/bin`、`/opt/homebrew/bin` 和 `which` 会把「已装」判成「未装」
- `desktopPnpm.run()` 返回 handle（stdout/stderr 流 + `done` promise + `cancel()`），**没有内建超时**——仅包操作使用它，调用方自己包 AbortController/定时器，退出时在 `ctx.effect` disposer 里 `cancel()` 并 `await done`
- 包操作（add/install）只应由**明确的用户动作**触发（Desktop 官方 checklist 第 1 条）；插件启动时探测到未安装就等待用户确认，不要自作主张改 profile
- **两条装包通道都没有时，构造期就抛**：给一个「装不了也看不出来」的 runtime 只会把用户骗到点按钮那一步才失败

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
