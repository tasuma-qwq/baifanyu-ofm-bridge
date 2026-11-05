# 0.3.1 装插件后 DSH 崩溃 —— 源码调研

调研时间：2026-11-05（本机时区 UTC+9）。对象：npm 包 `baifanyu-ofm`（仓库 `baifanyu-ofm-bridge`）`origin/main` = 683fdff = 0.3.1，对照工作树 0.2.0。
证据来源：仓库源码、本机 `~/.dsh/profiles/desktop`（DSH 0.2.1-rc.5 的 Electron profile）、`resources/app.asar` 内的内核实现（`@deepseek-ai/cordis-plugin-loader`、`cordis-plugin-include`、`dsh-app-boot`、`dsh-llm`、`dsh-web`）与 `.plugin-manager/logs/*/pnpm.log`。全部只读取证，未改配置、未发模型请求。

## 1. 结论

"和原来的 OFM 冲突"这个方向是对的，但冲突点不是命令名、模块名或端口，而是 **0.3.1 把上游 OFM 变成自己的依赖并再挂载一份**：

- `origin/main:package.json` 新增 `"@ebony-vinyl/dsh-our-free-model": "2.8.0"` 到 `dependencies`；
- `origin/main:cordis.patch.yml` 新增一行 `- id: baifanyu-ofm-upstream / name: '@ebony-vinyl/dsh-our-free-model' / config: {distribution: managed}`；
- 去重只靠这一行的 `disabled: !!js` 表达式，而该表达式**只看"存不存在一条 OFM 行"，不看顺序、不看是否启用、也不认源码/相对路径挂载出来的名字**。

于是同一台机器上可能出现两种相反的后果：OFM 装两遍（内核在 `registerAdapter` 处抛 `DUPLICATE_ADAPTER`，后挂载的那份直接死掉），或者一份都不装（用户本来就禁用了 OFM、或 OFM 被 DSH 版本兼容性门拒了，桥接又不再自带副本）。这两条都会打在"用户自己的 OFM"身上，用户感知就是"装完插件 dsh 坏了/打不开"。

**是否等于进程级"闪退"已有实证答案（见 §10）：Desktop 会。** 报障者那张"应用无法自动完成已意外停止 / web boot: 1 entry did not activate: import failed"的截图，与本机 2026-11-02 留下的 `crash-*-web-boot.log` 是同一个致命路径，只是失败的 entry 不同。这条致命路径有**两个来源，都由同一处改动引起**：(1) `baifanyu-ofm-upstream` 那一行的模块在该 profile 里根本解析不到（scoped tarball 没装下来），它携带的浏览器半身进入合并请求后整捆失败；(2) 门漏判导致两份 OFM 同时挂载，两份浏览器半身的 web provider id 都是写死的 `dsh-our-free-model`（`client.js:22`），后注册那份抛重复注册错误，条目永不激活。任一条都会让渲染端启动审计抛错 → `DESKTOP_IPC.bootFailed` → `reportFatal(…, "web-boot")` → 弹框终止。双份 OFM 在宿主侧的 `DUPLICATE_ADAPTER`（§3、§4）是同一改动的第三条后果，那条只死插件自身。

## 2. 0.2.0 → 0.3.1 的关键差异

| | 0.2.0（工作树） | 0.3.1（origin/main 683fdff） |
| --- | --- | --- |
| 组合行 | 只有 `baifanyu-ofm` → `baifanyu-ofm/plugin` 一行 | 增加 `baifanyu-ofm-upstream` → 上游 OFM 副本，带去重门 |
| npm 依赖 | `ws`、`js-yaml` | 再加 `@ebony-vinyl/dsh-our-free-model@2.8.0`（精确锁死单版本） |
| 注入服务 | `['commands','sessionController']` | `['commands','sessionController','llm']`，另有 `ctx.inject(['accountPool'])`、`ctx.inject(['tools'])` |
| 运行期副作用 | 只在 `/bfy-ofm` 命令里选模 | 注册全局 `llm/stream` waterfall 包裹每一次模型调用；注册工具 `bfy_ofm_onboard`；`ensureOfmEnabled()` 会 `POST /api/our-free-model/settings {enabled:true}` **写穿 OFM 总开关** |
| 引擎约束 | `engines.node` only | 同样没有 `engines.dsh`、没有 `@deepseek-ai/dsh-*` peer —— **对宿主版本零约束** |

最后一行值得单独说：OFM 自己在 `peerDependencies` 里声明了 `@deepseek-ai/dsh-commands`/`dsh-credentials`/`dsh-llm` 的 `^0.1.2-rc.1 || ^0.1.7-rc.2 || ^0.2.0-rc.1`，DSH 会在挂载前按 `getDshRuntimeVersion()` 校验并把不合格的行改成 `disabled: true`。桥接插件没有任何等价声明，所以它在任何宿主版本上都会被准入，包括它调不到的 API 尚不存在的旧版本。

## 3. 去重门为什么会漏

门表达式：

```js
[...ctx.get('loader').entries()].some(entry =>
  entry.options.id !== 'baifanyu-ofm-upstream' &&
  (entry.options.id === 'our-free-model' ||
   ['dsh-our-free-model', '@ebony-vinyl/dsh-our-free-model'].includes(entry.options.name)))
```

它假设"OFM 行一定在我之前、一定以这三种字面量之一出现、且出现即有效"。三个假设都不成立。

**(a) 顺序假设不成立 —— 门只能看见排在自己之前的行。**
`dsh-app-boot` 的 `composeEntries()` = `applyEntryPatches([], layers.flat())`：所有 bundle 层按 profile `dsh.profile.bundles` 数组顺序、再 profile patch、再 home patch、再 CLI overlay，扁平拼成**一条根 entry list**。`EntryGroup.update()` 用 `Promise.all(ids.map(id => this.create(...)))` 并发建行，`create()` 在第一个 `await` 之前就把 `tree.store[id] ??= new Entry(...)` 写好；`Entry.update()` 同样在第一个 `await` 之前**同步**读 `this.disabled`。所以第 i 行的 `!!js` 门求值时，`loader.entries()` 里只有第 0..i 行。
后果：如果用户**先装桥接、后装 OFM**（或任何一次 `reconcile` 让 `baifanyu-ofm` 排在 `dsh-our-free-model` 之前），门看不到 OFM → 副本挂载 → 随后真正的 OFM 行也挂载 → 双份。反过来，插件管理器 `reconcile()` 与 `reconcileProfilePlugins()` 都是 `bundles.push(name)`（追加到末尾），所以"先 OFM 后桥接"这条常见路径是安全的——这正是问题难复现、难归因的原因：**同一次安装的结果取决于 bundles 数组的历史顺序**。

**(b) 名字形式假设不成立。**
`parsePatchList()` 会把 insert 行里的绝对路径与 `./`、`../` 相对路径重写成 `file://` URL（`anchorInsertedPluginNames`）。凡是按源码 checkout 方式挂载 OFM 的用户，`entry.options.name` 是 `file:///.../dsh-our-free-model/index.js`，既不等于 `'dsh-our-free-model'` 也不等于 `'@ebony-vinyl/dsh-our-free-model'`；只要他把行 `id` 也改了（README 里推荐的源码安装形状、或早期 `baifanyu-ofm-bridge` 包），id 检查也失效 → 双份。

**(c) "存在即有效"假设不成立。**
门读的是 `entry.options.id/name`，不是 `entry.disabled`（`Entry.disabled` 是个 getter，会连同父 group 一起算）。所以：用户在插件管理器里把 OFM 关掉、或 OFM 因 `engines`/peer 版本门被改写成游离的 `disabled: true` 行 —— 门照样判定"OFM 已存在"，**拒绝挂载自己那份**，结果一个 OFM 都没有；而 0.3.1 的 `/bfy-ofm onboard` 第一件事就是访问 `/api/our-free-model/summary`，必然失败。这条是"装了插件反而用不了"的稳定成因，且不产生任何崩溃迹象。

## 4. 双份 OFM 时到底发生什么

OFM 2.8.0 的 Host 半身（`index.js:71 export const name = 'our-free-model'`，`inject = ['llm']`）在 `apply()` 里**同步**做三件全局注册：

```js
const registration = ctx.llm.registerAdapter([ROUTE_MAIN, ROUTE_REGION], adapter)      // index.js:447
ctx.llm.registerConfigurableProviders?.([{ provider: ROUTE_MAIN, settingsNs: ctx.fiber?.entry?.options?.id ?? name }])
ctx.llm.registerModelDiscovery?.(ctx.fiber?.entry?.options?.id ?? name, async () => { ... })
```

内核 `dsh-llm` 的 `prepareRoutes()`：

```js
if (unique.has(provider) || this.adapters.has(provider) && !owned.has(provider))
  throw new LlmError(`an adapter for provider "${provider}" is already registered`, 'DUPLICATE_ADAPTER');
```

即：**后挂载的那一份在 `apply()` 里抛 `DUPLICATE_ADAPTER`**（同一 registration 自己换路由才允许，见 `handle.replace`）。谁先谁后由 §3(a) 的顺序决定，所以危险版本是"桥接那份 npm 副本先挂、用户从 `github:Ebony-Vinyl/dsh-our-free-model` 装的那份后挂并死掉"——用户死掉的正是携带他自己账号、设置页和浏览器半身的那一行。

其余连带面（都是同一份共享资源被两个实例碰）：

- 两个实例都 `resolveDshHome()` + 同一个 `DATA_DIR_NAME` 目录，两份 settings/stats/availability 内存态互相覆盖；
- 两个实例都在 `ctx.inject(['webServer'])` 里 `server.register({ kind:'prefix', path:'/api/our-free-model' })` 与 `/api/our-free-model/events`；
- 两个实例都吃 `globalThis[Symbol.for('our-free-model.generation')]`（它本是为热重载设计：`generation > 1` 就写 `reloadedAt/reloadCount`，并且"旧闭包 dispose 后不得再碰 store"）——双实例并存时这个前提不成立；
- 转发监听器本身**不会**崩：`src/forward.js` 显式处理了 `EADDRINUSE`/`EACCES` 并挂了 `server.on('error')`，所以"端口冲突导致崩溃"可以排除；
- 浏览器半身绑定在 `name` 为裸包名的那一行上（OFM bundle patch 的注释明确说明子路径行不带半身）。桥接那行的名字恰好也是裸包名，所以双份时是两个 web 半身，其中一个挂在失败的 fiber 上——这类"面板空白/设置读不到"的表现，用户也很可能描述成"崩溃"。

## 5. 本机实测到的另一条：依赖装不上

`.plugin-manager/logs/operation-oGQHtI/pnpm.log`（11-03 安装 0.3.1）：

```
Packages: +2
[WARN] GET https://registry.npmjs.org/@ebony-vinyl/dsh-our-free-model/-/dsh-our-free-model-2.8.0.tgz error (ECONNRESET). Will retry in 10 seconds. 2 retries left.
[WARN] GET ... error (ECONNRESET). Will retry in 1 minute. 1 retries left.
[ERROR] fetch failed / TypeError: fetch failed
```

之后 `node_modules/@ebony-vinyl/` 只剩一个空目录，`operation-dBQ4MV/pnpm.log`（13:24）记录 `- baifanyu-ofm 0.3.1` 卸载。当前 profile 的 `bundles`/`dependencies` 里已经没有 `baifanyu-ofm`，但 `pnpm-workspace.yaml` 仍留着 `minimumReleaseAgeExclude: baifanyu-ofm@0.2.0`（0.3.1 和 `@ebony-vinyl/dsh-our-free-model@2.8.0` 都没有对应豁免）。

对报障者的意义：0.3.1 把插件可用性绑在"**npm 上精确版本的 OFM tarball 能被拉到**"上。国内/代理受限环境、私有 registry、以及 DSH 的 `minimumReleaseAge` 供应链等待门都可能让这一步失败。本节原先据此推断"按 app-boot 的失败矩阵那只是启动页警告"，**该推断已被 §10 的渲染端证据推翻**：桌面端的致命化发生在渲染进程的启动审计里，不在这份 app-boot 矩阵里，所以装不下来就是开不了机。

## 6. 桥接自身新增的运行期风险（与 OFM 无关）

- `ctx.on('llm/stream', observeStream(store, {...}), { prepend: true })` 包裹**本进程所有**模型调用（含标题生成、压缩、自我反思），`prepend` 使它排在链路最前；
- `record()` 在每次请求首帧与终帧做 `readFileSync` + `JSON.parse` + `writeFileSync(tmp,'wx')` + `renameSync` —— 同步文件 I/O 进入流链路；`try/catch` 覆盖了 `record`，但没有覆盖 `OFM_PROVIDERS.includes(request.provider)` 之前对 `request` 的取属性，形态异常会抛在生成器体内；
- `observeAccountPool(pool)` 直接改写 `pool.getAvailableAccount` 为 wrapper，靠 `effect` 清理还原；同一 pool 被多个 fiber 观察（插件重挂载、或多份 `baifanyu-ofm` 行）时 wrapper 成链，是长期隐患；
- `ensureOfmEnabled()` 会替用户把 OFM 总开关写成 `enabled: true`；
- `officialFallback()` 走 `agent.model.select()` / `agents.selectForNextRequest()`，把会话选模与"新会话默认值"耦合（0.2.0 的 `selectSessionRoute` 已承认 DSH 会同时保存为新会话默认）。

## 7. 建议的修法（按性价比排序）

1. **不要再挂载上游 OFM 副本。** 把 `@ebony-vinyl/dsh-our-free-model` 从 `dependencies` 与 bundle patch 里移除，改成"检测 + 引导安装"：`/bfy-ofm onboard` 先 `ctx.get('accountPool')` / 查 `/api/our-free-model/summary`，缺失时输出 OFM 的官方安装入口让用户自己装。这条一次消掉 §3、§4 全部风险。
2. 若产品上必须自带副本，去重判定必须离开"组合期看行"的形态：改为在插件 `apply()` 里按**能力**判定（宿主 `llm` 是否已有 `our-free-model` provider、`accountPool` 服务是否存在），并且判定"已启用"而非"行存在"；`disabled: !!js` 门要同时覆盖 `file://` 名字与 `entry.disabled`。
3. 补 `engines.dsh` 或 `@deepseek-ai/dsh-*` peer 范围，让 DSH 的版本兼容性门能拒绝不匹配的宿主，而不是让插件在旧宿主上半路失败。
4. 把 `llm/stream` 观测改成异步、限流、只覆盖本插件会话；去掉热路径上的同步 `renameSync`。
5. `dsh.bundle.patch` 不要插入第三方包的行去抢占它的浏览器半身/设置命名空间；如果确需插入，用独立 dataDir（`distribution: managed` 只关了更新器，没关状态写入）。
6. 文档补一句：桥接与 OFM 的安装顺序会影响结果，先装桥接的用户需要重装 OFM 或手工调整 `dsh.profile.bundles` 顺序。

## 8. 需要报障者提供的东西才能定论

1. `dsh --dump-config`（会以 `!!js` 原样打印组合后的行，能直接看出是否同时存在 `our-free-model` 与 `baifanyu-ofm-upstream`、以及它们的先后）。
2. `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 数组和 `dependencies`。
3. 崩溃那一刻的启动诊断/日志（CLI 保存的完整启动诊断，或 Electron host 日志）里第一条 `LlmError`/`StartupError`/`DUPLICATE_ADAPTER`/`failed to parse overlay` 文本。
4. `.plugin-manager/logs/operation-*/pnpm.log` 最后 20 行。
5. 症状口径：进程直接退出 / 界面白屏 / 只是 OFM 面板与模型目录少了一半。

## 9. 本次已排除的解释

- "`name: baifanyu-ofm/plugin` 子路径 export 非法" —— loader 文档与 `EntryTree.import` 支持子路径与 `file://`，非成因（唯一副作用是子路径行不带浏览器半身）。
- "`!!js` 在 bundle patch 层解析不了导致启动失败" —— `parsePatchList` 用的 `userPatchesSchema = entryListSchema`，含 `tag:yaml.org,2002:js`，可正常往返。
- "`/bfy-ofm` 与 `/ofm` 命令重名导致崩溃" —— 内核确实"同一作用域重复注册同名命令会抛异常"，但那发生在 `apply()` 内、对 optional 条目只是警告。
- "端口被占导致闪退" —— OFM `forward.js`/`chan-relay.js` 自带 `server.on('error')` 与 `EADDRINUSE` 提示。
- "0.3.1 的 `config: {distribution: managed}` 是无效键" —— OFM `distributionOf()` 明确读取 `config.distribution === 'managed'`，合法且优先级高于 settings 文件。

## 10. 崩溃实证（2026-11-05 补充）

报障截图（DSH 桌面端，日志时间 2026-11-04T13:12:27.185Z，来源 `web-boot`）：

> 应用无法自动完成已意外停止。
> `web boot: 1 entry did not activate: import failed (see console for the import error)`
> 日志保存到 `…\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\<随机>-web-boot.log`
> 按钮：退出 / 重启 / 禁用第三方插件、备份 profile patch 并重启

本机 2026-11-02 有一份同类的真实产物，位于应用数据目录的 `logs/crash-2026-11-02T10-07-36-359Z-web-boot.log`（Windows 下即 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\`；app 0.2.1-rc.5 / electron 44.7.0 / node 24.21.0，phase: running）：

```
Error: web boot: 2 entries did not activate
dsh-our-free-model: import failed (see console for the import error)
dshmarket: import failed: client-modules: could not load "dshmarket": plugins/??...dsh-our-free-model/client.js...dshmarket/client.js...:
  skipped after an earlier failure of this bundle; ... bundle script failed to load
    at file:///…/resources/app.asar/lib/main.js:12437:15
```

三点要据此更正前面的判断：

1. **致命化发生在渲染进程的启动审计，而不是 app-boot 的失败矩阵。** `dsh-web-frontend` 的入口在 client loader 组装完毕后遍历全部条目，任何 `fiber === undefined` 或状态非 `active` 都会被收集成人话并抛出：

   ```js
   for (const i of e.loader.entries()) {
     if (i.fiber === void 0) { …`${i.options.name}: import failed (see console for the import error)`…; continue }
     const s = stateOf(i.fiber.state); if (s !== "active") … `${n}: pending (waiting for services: …)` …
   }
   if (r.length > 0) throw new Error(`web boot: ${r.length} entr${…} did not activate\n${r.join("\n")}`)
   ```

   这个 throw 经 `DESKTOP_IPC.bootFailed` 上报，宿主 `resources/app.asar/lib/main.js` 调 `reportFatal(new Error(message), "web-boot")` → 写 crash 日志 + 弹框 + 终止。所以 `dsh-app-boot` 文档里"optional 条目 import 失败只是警告"在桌面端**不成立**：已安装的 bundle 只要有一个没能激活，就是启动级 fatal。截图里的"pending (waiting for services)"变体也说明：一个永远等待服务的条目同样致命，不只是 import 失败。

2. **0.3.1 新增的那一行把"上游 OFM 能不能装下来/能不能只挂一份"变成了"DSH 能不能开机"的前置条件。** `dsh-client-modules` 的宿主半侧是按**已启用的 Loader 条目**组合启动图的，浏览器半身经合并请求 `plugins/??a/client.js,b/client.js&rev=…` 提供。于是两条路径都会落到上面那个 throw：(a) 该行模块缺失 → 合并请求里它的 `client.js` 取不到 → 报 `import failed`；(b) 门漏判导致两份 OFM 都启用 → 两份浏览器半身的 web provider id 都是写死的 `'dsh-our-free-model'`（`client.js:22`），后注册那份在 `dsh-web` 的 `if (store.has(provider.id)) throw … 'WEB_DUPLICATE_PROVIDER'` 处失败。报障者是 `1 entry`，本机那次是 `2 entries`；要区分只需看日志里那条 entry 的 id 与 `import failed` 后面的原始错误。
3. **级联面比预想的大。** 浏览器半身被捆进同一个 `plugins/??a/client.js,b/client.js,…` 组合请求，其中一个失败会让整捆 `skipped after an earlier failure of this bundle` —— 本机那次就连带把 `dshmarket` 的界面也打挂了。所以"装一个插件，别的插件面板也没了"是这个路径的正常表现，不是巧合。

### 报障者的即时恢复

1. 先点第三个按钮"禁用第三方插件、备份 profile patch 并重启"。它对应 `sanitizeProfile("dsh", profile, WEB_PROFILE.bundles)`：把 profile 的 `cordis.patch.yml` 改名为 `.bak-<timestamp>` 并恢复宿主自带的 bundle 列表，**能起来**，代价是第三方插件（含 OFM）一起停用，且 home 级 patch 不动。
2. 想只回滚这一个插件：关掉应用，编辑 `~/.dsh/profiles/desktop/package.json`，从 `dsh.profile.bundles` 去掉 `"baifanyu-ofm"`、从 `dependencies` 去掉 `baifanyu-ofm`，保留 `dsh-our-free-model`；或反过来，在能联网的环境把 `@ebony-vinyl/dsh-our-free-model@2.8.0` 真正装上再启动。
3. 不要点"重新安装"。任务数据在独立位置，崩溃来自 profile 组合层，重装应用不改它。
4. 请把框里那条 `crash-*-web-boot.log` 发回来 —— 它会写明到底是哪一行 `import failed`，这是区分上面第 2 点两种可能的唯一证据。

## 11. "装了插件后白饭鱼死机"：挂起侧的隐形 bug（2026-11-05 补充）

"死机"与 §10 的闪退是两类现象：进程还在、界面还在，但那一个会话（极端情况是整个 DSH 进程）不再产出。下面按"能否让回合永不返回"排序，全部为只读取证。

**(1) 工具 `bfy_ofm_onboard` 的 `execute` 不读 `exec.signal`，内部宿主调用一律裸 await。** `modelCatalog()`、`selectModel()`、`pool.getAvailableAccount()`、`agent.model.select()` 都没有超时也没有取消；`AbortSignal.timeout` 只覆盖了 loopback 的那几个 fetch。内核侧要留意两点：`dsh-tools` 的 `timeoutMs` 只是声明，`dsh-tool-call-timeout-policy` 也只在工具自己理会 `exec.signal` 时才起作用——文档原话是"忽略或缓慢处理取消的工具仍可能让调用方继续等待"。所以一个 OFM 目录刷新卡住的瞬间，就是一次永不返回的工具调用，也就是报障者看到的"白饭鱼不动了"。命令路径只在入口 `signal.throwIfAborted()`，之后的 await 同样不可取消。

**(2) 宿主选模走的是每 agent 一条串行链。** `sessionController.selectModel()` 整体包在 `agents.serializeImageAdmission(agent, …)` 里，那条链是 `imageAdmissionChains.get(agent).then(operation)`。链上任何一次操作不 settle，该 agent 之后的每一次选模都排队等死。qq-bridge 每条消息都要选模，于是表现为"机器人整体停摆"而 DSH 界面正常。补一句结论：`selectModel` 自己**不等回合边界**（它同步调用 `selectForNextRequest` 后就返回），所以不是"回合等工具、工具等回合"的自等待死锁，而是队列里前一个卡住就是它卡住——插件侧唯一能做的是给它一个本地上限。

**(3) 观测记录把同步文件 I/O 放进了每一次模型调用。** `record()` 每做一次就 `readFileSync` + `JSON.parse` + `writeFileSync(tmp,'wx')` + `renameSync`，且 `prepend: true` 使这层包住本进程**所有**模型调用（含标题生成、压缩、自我反思）；一个带 N 个工具步的回合至少产生 2N 次同步写周期。当 `DSH_HOME` 落在 OneDrive/网络盘（占位符 hydration 可以阻塞分钟级）或被杀软实时扫描放大延迟时，事件循环被冻住，**所有会话同时"死机"**——这是唯一能把整个进程卡住的机制，而且同步 I/O 不受任何超时保护。

**(4) `renameSync` 遇 EPERM 时 `*.uuid.tmp` 永不清理。** Windows 上目标被索引/杀软/另一个 DSH 进程句柄占用就会走到这条路，每次模型调用至少漏一个临时文件，目录膨胀又反过来加剧 (3)。原代码外层是空 `catch`，所以完全静默。

**(5) `observeAccountPool` 的 wrapper 在重复 `apply()` 时成链。** 只用"是不是我这次包的那个函数"做身份判定，dispose 不跑（插件重挂、profile 重组）时链会一直增长，而还原只剥掉最外层。实测 OFM 2.8.0 的 `getAvailableAccount` 是 `async` 且所有调用点都 `await`，所以 async 包装本身不会破坏选号——这条只是长期隐患。

**(6) CLI 的 `acquireStateLock` 没有陈旧判定。** 进程被杀后 `writer.lock` 永留，之后每次 `smoke`/`run` 立即 `STATE_BUSY`；`unlock()` 里 `readFileSync` + `JSON.parse` 无保护，锁文件被删或写坏时会在 `finally` 抛出并掩盖真正的运行结果。用户视角同样是"装了插件之后就跑不动了"。

**(7) `dsh-client.follow()` 只在"未就绪"阶段有超时。** 就绪之后的半开连接永不报错。`runOneTurn` 有总时限兜底，直接复用 `follow()` 的其他调用方没有。

已排除（不构成挂起）：`ensureOfmEnabled` 的 loopback 调用（各自 10 秒上限，最坏 4 次后报错）；`authenticate()`（`useLocalSession` 只读本地凭据）；`observeStream` 丢帧或永不 done（chunk 1:1 透传，提前退出记 `unknown`）；同进程内 read-modify-write 是原子的（只有桌面 + web 双实例共享同一 profile 才可能互相丢写）；无界重试与 `while (true)`（各处重试上限均为 2）。

## 12. 0.3.2 实际改了什么

| 风险 | 0.3.2 处置 |
| --- | --- |
| §10 的两条致命路径 | `cordis.patch.yml` 删掉 `baifanyu-ofm-upstream` 行，只保留 `baifanyu-ofm/plugin` 一行；`dependencies` 去掉 `@ebony-vinyl/dsh-our-free-model`，不再依赖"远端 tarball 拉得下来"才能开机。 |
| §3 的去重门、§4 的双份 OFM | 门整体消失。改为按能力检测（`accountPool` 服务存在，或 `llm.listProviders()` 里有 OFM 路由），判定的是"已启用"而不是"行存在"；缺失时返回 `OFM_NOT_MOUNTED` + 官方安装入口，onboard 不再探测宿主接口。 |
| §6 的 `!!js` 表达式行 | 不再存在于 bundle patch；`test/hang-regressions.test.js` 断言 patch 只含本插件的子路径行且没有 `disabled` 表达式，防止回归。 |
| §11(1)(2) 无限等待 | 新增 `guard()`：每次宿主往返默认 15 秒上限（`hostTimeoutMs` 可调），并透传 `exec.signal` / 命令 `signal`；超时报 `HOST_CALL_STALLED`、取消报 `HOST_CALL_CANCELLED`，被中断的调用一律不宣称完成。工具在宿主已取消时把取消抛回宿主，而不是伪造一个结果。 |
| §11(3)(4) 同步 I/O 与临时文件 | 策略文件改为内存态 + 异步合并落盘（单飞 + 失败重试一次合并），模型调用链路上不再有 `readFileSync`/`renameSync`；命令路径用 `store.flush()` 取得持久化确认；写失败清掉临时文件并经 `onWriteError` 告警，不再静默。 |
| §11(5) wrapper 成链 | 观察函数上挂符号 + 引用计数，第二个持有者复用同一个 wrapper，最后一个释放才还原。 |
| §11(6) 陈旧锁 | `acquireStateLock` 增加持有者 pid 存活判定 + mtime 静默期（默认 120 秒，可注入）；只在"进程已死且已过静默期"时接管，损坏但仍是活的锁不动；`unlock()` 全程吞异常，不再掩盖运行结果。 |
| §7 第 3 条（版本门拦不住） | `package.json` 声明 `engines.dsh: ">=0.2.0-rc.1"`，让宿主的插件兼容性门在不匹配时拒绝该行并给出可确认放行的提示，而不是让插件在调不到的接口上半路失败。 |
| 写穿 OFM 总开关 | 保留（这是用户明确要求的接入），但结果里回执 `ofmEnabledByThisRun` 并说明它是全局设置。 |

未处置并留档：§11(7) 的 `follow()` 半开连接（CLI 专用，`runOneTurn` 已有总时限兜底）；宿主选模串行链本身是宿主性质，插件只能设上限，不能替宿主拆链。跨进程共享同一 profile 时的策略文件丢写仍未解决——需要宿主级的单写者协调，不属于本插件能安全实现的范围。
