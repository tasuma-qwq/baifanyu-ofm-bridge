# 检修报告：baifanyu-ofm 与上游 OFM 的契约一致性

范围：把 [baifanyu-ofm](https://github.com/tasuma-qwq/baifanyu-ofm-bridge)（v0.2.0）装进桌面端 DSH 后，它对本机 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 的读写是否与上游实际契约一致。

本文只陈述事实与问题。不含修复方案。

判定基准（用户目标）：模型仍是 DS、消耗走 OFM、轮换可用。本文说明这三条在本机当前为何**都不成立**。

---

## 1. 双方是什么

**上游 OFM** 是模型供给方。它把免费车道、EAC 协付、Kilo 免费池和十个账号渠道挂成 provider，向宿主广播模型清单，并自己实现了账号池、降级链（combo）和失败分类。

**baifanyu-ofm** 是选路层。它读宿主目录，挑一条 `provider/model`，调 `session/selectModel`，再按自己的分类记录冷却。

**关键前提：上游已经内置了两套轮换。** 一是 `accountPool`（同 provider 多账号，额度错误时切换），二是 `combo` 虚拟模型（`fallback` / `round-robin` / `smart` / `usage` / `pace` 五种策略，降级对调用方不可见）。插件又叠了第三套（`laneChain` + 冷却账本）。三套并存是后面多数问题的根源。

---

## 2. 本机装载现状

| 项 | 值 |
|---|---|
| 插件 | `baifanyu-ofm@0.2.0`，已挂 package.json bundles，`/bfy-ofm` 已在运行中的宿主注册 |
| 配置文件 | **不存在**（`~/.dsh/baifanyu-ofm/config.local.json`），故除 `doctor` 外全部动作不可用 |
| OFM 来源 | `github:Ebony-Vinyl/dsh-our-free-model`，commit `999e9f78`，版本 2.8.0 |
| 宿主 | DSH 0.2.1-rc.5 |
| 实测目录 | 8 个 provider 组，79 条车道 |

上游 README 明确警告：npm 上裸名 `dsh-our-free-model` **不是本仓库发布的**，由第三方打包且改动过 `index.js`/`client.js`，并额外含 `src/channel-visibility.js`；官方制品是带 scope 的 `@ebony-vinyl/dsh-our-free-model`。

本机装的是 GitHub tarball，属于可信路径，但**不是上游发布制品**：没有签名清单，因此应用内升级与公告 feed 的完整性校验链在此安装上不生效。

---

## 3. 检出的问题

### A. provider id 与上游契约不一致

**A1（确定错误）`our-free-model-region-limited` 不是任何 provider 的 id。**

上游 `src/adapter.js` 导出的是：

```
ROUTE_MAIN   = 'our-free-model'
ROUTE_REGION = 'our-free-model-region'
```

而 `region-limited` 是**分组标题**（`'Our Free Model · region-limited'`），不是 id。插件白名单把标题当成了 id。

当前无功能损失，因为该组此刻根本没注册：区域受限模型 `beam-free` 在用户 `hiddenModelIds` 里，`computeMembership` 不向空组写入 membership，所以 `our-free-model-region` 组不出现。

这是一个**潜伏缺口**：一旦用户取消隐藏 `beam-free`，或上游新增区域受限模型，这些模型对插件完全不可见，且报错会显示"目录中没有允许的候选"，指向错误方向。

**A2（类别错误）`kilo` 与 `eac` 不是 provider。**

上游把两者实现为**同一 provider 内的 channel**：EAC 模型以 `EAC ` 前缀显示、Kilo 模型带 Kilo 徽章，都落在 `our-free-model` 组里。本机实测印证：`our-free-model` 组的条目确实包含 `opencode/deepseek-v4.1-flash-free`（EAC）和 `recursive/flint-v1.0:free`（Kilo）。

按 provider 匹配这两个名字永远不命中。

**A3（拼写冗余）`lobster` 无效，`lobsterai` 才有效。**

上游渠道包 id 是 `lobsterai`（LobsterAI，有道）。白名单把两个都列了，其中一个恒不命中。

**A4（语义混淆）六个渠道 id 合法但当前未注册。**

`cline` / `loomy` / `raccoon` / `minimax` / `gemini` 是上游十个账号渠道中的五个，id 正确，只是未登录，因此 `providerCatalogVisible` 返回空、provider 不注册。

问题不在 id，在于**插件无法区分"该渠道没登录"和"这个 id 根本不存在"**。白名单是静态的，两种情况的输出都是"没有候选"。用户据此无法判断该去登录，还是该怀疑配置写错。

**A5 `combo:recommended-free` 消失是用户设置造成的，不是插件拒绝的。**

该 combo 存在于上游，但用户的 `hiddenModelIds` 里明确列了它。此前把它当作"插件正确拒绝"来论证设计，证据不成立。

---

### B. 轮换：三套引擎，其中两套不可能触发

**B1 免费车道没有"账号"可轮换。**

上游免费车道的凭据是 `Authorization: Bearer public`——公开免密额度，README 明写"没有号池、没有中转、没有二道贩子"。因此对公开池而言，「账号池轮换」这个目标本身不适用。轮换语义只存在于十个账号渠道（`accountPool`）和 combo 策略里。

**B2 本机四个 provider 各一个账号，账号级轮换在物理上不可能发生。**

`~/.dsh/channel-pack/state.json`：`qoder` / `qodercn` / `trae` / `zcode` 均只有一个账号。

上游 `getAvailableAccount` 在排除已试账号后若无候选即返回 `null`，`switchAccountOnQuota` 直接 `return void 0`。TRAE 的 `TRAE_MAX_ROTATE = 3` 上限在此完全用不到。

所以用户目标的第三条「轮换可用」在本机**当前配置下不可能成立**，与插件实现质量无关。

**B3 插件的车道冷却与上游的 combo 降级互不可见。**

上游 combo 在**任何正文增量之前**失败会丢弃该链并静默切换，对调用方不可见。插件因此只能看到"这一轮成功了"，无法记录"曾经换过道"，也无法把 combo 内部的失败计入自己的冷却账本。

反过来，插件记录的冷却不会告诉上游，上游的 combo 仍会照常尝试被插件判为冷却的链。

**B4 429 的语义对不上。**

上游：免费车道**按 session 统计速率**，短时间打满返回 429；v1.3.2 起 429 移出可重试状态码，且整轮探测全为 429 时按 30→120 分钟指数退避。

插件：`classifyLaneFailure` 把 429 归为 `rate-limit`，冷却 **60 秒**，且按 `provider/model` 全局生效。

两个后果：冷却时长与上游退避不一致；上游是 session 级限速，插件却把整条车道对所有会话拉黑 60 秒。

**B5 上游的自动恢复会让"提交次数"审计偏低。**

上游 `streamRecovery` 默认开启：纯思考截断或纯思考空停时，会追加一次物理请求（每个逻辑回合最多两次，默认总时限 900 秒）。

插件把一次提交记为一，审计与冷却都按一算。实际配额消耗可能是两倍。这与插件文档里"严格记录提交次数"的说法冲突。

**B6 免费池配额按上游 session 计，而插件 CLI 每次新建会话。**

CLI 的 `run`/`smoke` 每次都 `session/create` 一个隔离会话，上游再按对话映射到上游 session（`session-map.json`）。新会话意味着**新的配额桶**。因此反复跑 smoke 得到的"公开池可用"结论，不代表日常同一会话下的可用性。

---

### C. 思考档位

**C1 宿主会硬拒无档位模型的档位参数。**

宿主 `resolveCallWithInfo`：模型 `reasoning === undefined` 时只要请求带了 `reasoningEffort`，直接抛 `UNSUPPORTED_REASONING_EFFORT`。

本机目录里 `trae/DeepSeek-V4-Flash` 的 `reasoning` 为 `undefined`。插件当前的 `resolveLaneEffort` 对它返回 `undefined`（不发该字段），恰好安全；但只要配置的 lane 里显式写了 `reasoningEffort`，就会 400。

**C2 内置档位表只覆盖三个模型名。**

`KNOWN_EFFORT_VOCAB` 只有 `dfmodel` / `qfmodel` / `deepseek-v4.1-flash`。目录读不到词表时依赖它；其余模型一律"不猜"。这与上游"声明了档位才下发、否则走预算阶梯"的设计一致，但意味着对 `deepseek-v4.1-flash-free` 这类**有目录菜单**的模型，实际取值完全依赖目录刷新是否成功。

**C3 "lowest = 关闭思考"只对部分模型成立。**

本机实测映射：`qodercn/dfmodel` → `none`，`our-free-model/deepseek-v4.1-flash-free` → `disabled`，`trae/deepseek-v4.1-flash` → `light`。

但上游 README 记载：GLM 5.3 Flash 的 `none` **实测关不掉思考**；`deepseek-v4.1-flash-free` 的三次采样中位数则是 none 0 / low 793 / high 700 / xhigh 1405 / max 1906。

所以"最低档等于不思考"不能一概而论，取决于模型。当前会话默认是 `qodercn/dfmodel` + `max`，一次 `lowest` 重映射会把它落到 `none`——这是实质行为改变。

---

### D. 官方渠道的边界被高估

`deepseek-official` / `deepseek-account` 来自宿主自带的 DeepSeek provider，**不属于 OFM**（上游的来源清单里没有它们）。

插件的 `FORBIDDEN_PROVIDERS` 只约束**插件自己发起的 `selectModel`**。用户在界面里手选官方、或 `agent-default-model` 配置指向官方时，请求照走官方余额，插件无感。

本机 `catalog.default` 当前是 `qodercn/dfmodel`，暂时安全；但这是宿主持久化的值，不是插件能保证的。

---

### E. 计量口径

**E1 面板金额不是扣费。**

本机 2026-11-02 实测：

```
whale 面板今日估算（dfmodel 两笔）   0.544334 CNY
官方余额账本今日实际扣减             0.008355 CNY
```

差约 65 倍。面板按价目表折算等价 API 金额，而 `dfmodel` 走账号额度，不产生现金扣费。两者不可互证，也不能相减当作"省了多少"。

**E2 装载环节绕过了供应链等待期。**

安装时向 `pnpm-workspace.yaml` 写入了 `minimumReleaseAgeExclude: baifanyu-ofm@0.2.0`，该包因此跳过了 pnpm 的新鲜发布等待门。

**E3 TRAE 凭证次日到期。**

`trae` 车道的 `expiresAt` 在装插件的次日 21:09（JST）就到期，只能靠 refresh_token 续期；`qodercn` / `qoder` 约两周后到期，`zcode` 无 refresh。这是短期内最可能单独失效的一条车道。

---

## 4. 三条完成判据的当前状态

| # | 判据 | 现状 | 依据 |
|---|---|---|---|
| 1 | 模型确认为 DS | **未成立** | 插件未配置，`onboard` 动作不存在；当前 `catalog.default` 已是 `qodercn/dfmodel`（DS 系），但那来自宿主配置，不是本插件建立的状态 |
| 2 | 消耗走 OFM | **未验证** | 无真实回合；且 E1 说明面板数字不能作为证据，必须以余额账本 `debitUnits` + OFM 渠道账本 `requests` 双信号判定 |
| 3 | 轮换可用 | **不成立** | B1/B2：免费池无账号可轮换；四个账号渠道各一个账号，切换路径必返回空 |

---

## 5. 未能确认的项

这些需要看上游源码或实机验证，本文不下结论：

1. 插件 `fetch` 的 `commands/list` 必须带 `agentId`，否则 `gateway/arguments-invalid`。桌面宿主是否另有查询入口，未查。
2. 上游 `src/route/classify.js`（全车道统一的失败词汇与冷却策略）与插件的 `classifyLaneFailure` 是否有语义冲突——源码两次抓取超时，只读到 README 的转述。
3. 上游 combo 的 `stickyLimit` 与插件车道顺序叠加后的实际选路分布，未实测。
4. 若取消隐藏 `beam-free`，`our-free-model-region` 组的模型是否会进入插件视野——按代码推断不会（A1），未实测。
5. 上游应用内升级在本机这条 `github:` tarball 安装上是否完全停用，取决于 `settings.json` 的 `distribution` 字段；当前为 `self`，但安装方式与上游"托管安装"的说明并不完全对应。

---

## 6. 本文不主张的事

- 不主张插件"完全无效"：`/bfy-ofm` 确实注册可用，`doctor` 能正常读出 79 条车道，白名单对 `deepseek-official` / `deepseek-account` 的硬拒在代码层面成立。
- 不主张上游有缺陷：本次检出的不一致，绝大多数是插件假设与上游契约不匹配，而非上游行为异常。
- 不主张免费池"长期不可用"：2026-11-02 两轮探测全为 `throttled` 只是当日快照，上游按 session 计速，状态会变。
