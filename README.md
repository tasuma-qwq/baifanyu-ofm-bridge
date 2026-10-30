# 白饭鱼 · OFM 接入

为 DSH 中的 OFM 免费公开池及用户自有账号渠道设置主备顺序、额度冷却和任务档位，并验证真实模型回答。首次接入默认使用免费公开池。

**v0.2.0** 提供原生 `/bfy-ofm` 命令、环境诊断、配置生成及独立文本回合入口。把本仓库交给 DSH 时，可要求它按 [AGENTS.md](AGENTS.md) 完成接入；涉及登录会话和真实调用的步骤仍需你的授权。

Our Free Model 是 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 的项目。本仓库提供其上的接入与治理，保留 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 的来源和 MIT 许可。这里不附带账号、额度或模型服务，完整 QQ bot 和记忆系统另行维护。

## 在 DSH 中安装

前提：DSH 正常运行，OFM 已安装并启用免费公开池；首次使用不要求添加账号。当前验收宿主与范围见 [验证记录](docs/validation.md)。

纯 web profile：

```sh
dsh plugin --profile web add git+https://github.com/tasuma-qwq/baifanyu-ofm-bridge.git
```

桌面端通过应用的插件管理器安装此 GitHub 仓库；不要用 CLI 修改 Electron 管理的 desktop profile。按宿主提示重新加载后：

```text
/bfy-ofm doctor
/bfy-ofm setup
/bfy-ofm chat
```

setup 从当前目录配置公开免费模型，不自动加入账号、EAC 或可编辑聚合链。命令选好模型后，发送普通消息开始推理。插件不接管其他会话；原生选模同时保存 DSH 的新会话默认选择。

公开池可能限流、拥堵、超时，受网络和地区影响，模型也会变化，不保证免费无限或长期可用。[公开池限制与添加自己账号的方法](docs/public-pool-and-accounts.md)给出了具体入口和切换步骤。

## 让 Agent 完成首次接入

需要 Node.js 22.19+，建议 24。命令行入口可独立使用，不要求先安装本仓库的原生插件。

```sh
git clone https://github.com/tasuma-qwq/baifanyu-ofm-bridge.git
cd baifanyu-ofm-bridge
npm ci --ignore-scripts
npm test
npm run demo
```

最后两步是离线验证，不调用模型。接到真实 DSH：

```sh
npm run doctor -- --use-local-session
npm run setup -- --use-local-session
npm run smoke -- --allow-model-call --use-local-session
```

按顺序执行：检查目录 → 配置免费公开池 → 授权一次短调用后验证。添加自己的账号后可用 --lanes 显式选择主备。`--use-local-session` 仅在你明确允许读取本机 DSH 会话时使用；也可用 DSH_AUTH_COOKIE / DSH_LAUNCH_TOKEN 环境变量。不要公开这些值。默认地址为 http://127.0.0.1:3080；独立端口与目录分别用 --base-url 和 --dsh-home，并在各步保持一致。

配置默认在 `DSH_HOME/baifanyu-ofm/config.local.json`，与原生插件共享；项目隔离用 --config PATH。不同的已有配置不会被 setup 覆盖。旧 config.example.json 保留关闭状态，作为核心策略参考；新用户用 setup 按当前目录生成。

smoke 创建空工作目录和独立会话，收到事件订阅 baseline 后才提交固定短提示词。只有 `smokeMatched: true`、非空正文和 `status: completed` 同时成立才证明本次文本接入成功。当前目录里有模型并不代表渠道可调用或免费。

完整连接、普通文本任务、故障定位和代码复用见 [接入说明](docs/integration.md)。

## 已实现的行为

| 场景 | 行为 |
| --- | --- |
| 当前目录不含候选 | 跳过该渠道，输出可定位的错误 |
| 提交前主渠道选模失败 | 保存失败原因并冷却，最多再选择一次备用 |
| 不同渠道的思考档位不同 | 优先读取目录词表，将最低/高档偏好映射到合法值 |
| 额度、认证、限频或上游故障 | 按 provider/model 分别记录冷却 |
| 工具执行与模型等待 | 核心看门狗分阶段计时，支持嵌套工具结果 ID |
| 已提交后超时、断线或行动未知 | 独立运行器不自动重放，保留 unknown 供核对 |
| 重复配置或并发写状态 | 相同配置幂等，不覆盖不同配置，写入者加锁 |
| 日志与审计 | 本地只保存提交元数据，不记录提示词、工具参数或账号密钥 |

原生命令负责诊断、配置和当前会话选模；冷却与完整回合验收由 CLI runner 使用。完整工具 Agent 可复用核心，但仍需自己的权限、取消和行动回执接线。本项目不会安装 QQ 或替你登录渠道。

## 边界与费用

- 上游可能消耗免费额度、Credits 或付费余额；本仓库不能证明每次请求免费，未知用量不当作零。
- CN 权益须核实并明确期限，不靠修改日期延长实际权益。
- 模型内容会发到所选上游；DSH 按宿主策略保存会话。冷却原因和来源 ID 也可能敏感，分享前处理。
- CLI 选模可能临时改变新会话默认值，结束时在未被其他使用者更改的前提下恢复；未确认的清理留有记录。详见接入说明。
- 单次验证不保证其他账户、网络或未来时刻可用，也不证明长期稳定。未知结果不自动重试。

## 开发与来源

`src/` 包含策略、审计、DSH 客户端、运行器和原生命令；`bin/` 是 CLI；`test/` 包含核心回归与本地 HTTP/WebSocket 契约测试；`examples/` 是离线演示。

[架构](docs/architecture.md) · [验证记录](docs/validation.md) · [插件市场申请条件](docs/marketplace.md) · [记忆系统预告](docs/memory-preview.md)

MIT。保留 [LICENSE](LICENSE)、[NOTICE](NOTICE.md) 和 [qq-bridge 原许可](third_party/qq-bridge-LICENSE)。初始提取快照见 [provenance.json](docs/provenance.json)。本仓库不重新分发 OFM 渠道包或 DSH 代码；互操作不表示上游认可。
