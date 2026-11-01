# 接入自己的 DSH

v0.2.0 提供原生 bundle 和完整单回合入口，要求正常运行的 DSH 及已安装的 OFM。首次配置默认使用免费公开池，不需要添加账号。公开池受限与账号配置见 public-pool-and-accounts.md。

## 原生插件

纯 web profile 通过 npm 安装：

```sh
dsh plugin --profile web add baifanyu-ofm
```

GitHub 源码安装仍然可用：

```sh
dsh plugin --profile web add git+https://github.com/tasuma-qwq/baifanyu-ofm-bridge.git
```

web 换成实际 profile。桌面端通过应用的插件管理器安装仓库；Electron 管理的 desktop profile 不通过 CLI 修改。按宿主提示重新加载后，在会话输入：

```text
/bfy-ofm doctor
/bfy-ofm setup
/bfy-ofm chat
```

setup 默认配置公开池，其他账号渠道需先自行添加，再以 provider/model 显式指定，多个候选用逗号分隔。选模不发起推理，发送普通消息才调用模型。chat 使用最低合法档位；diary/selfReflection 偏好高档。

配置默认在 `DSH_HOME/baifanyu-ofm/config.local.json`。未设 DSH_HOME 时使用用户主目录的 `.dsh`。插件只处理命令所在的会话，不自动接管所有会话；DSH 的 selectModel 还会保存新会话默认选择，命令会提示这一点。

## 命令行首次接入

需要 Node.js 22.19+，建议 24。在克隆仓库里运行 `npm ci --ignore-scripts`。

授权可用环境变量 DSH_AUTH_COOKIE 或当前启动链接的 DSH_LAUNCH_TOKEN。不要把带 token 的 URL 传给 --base-url。用户明确允许访问本机 DSH 登录会话时，也可使用 --use-local-session；只有该标志会读取 DSH_HOME 的会话签名密钥，密钥仅在内存中使用，不导入或导出渠道凭据。

```sh
npm run doctor -- --use-local-session
npm run setup -- --use-local-session
npm run smoke -- --allow-model-call --use-local-session
```

逐步执行：检查目录、配置公开池、获得短模型调用授权后执行 smoke。公开池没有可用候选时停止并说明，不自动切到账号渠道。默认地址 http://127.0.0.1:3080；端口不同时每次提供相同 --base-url。独立实例每次提供 --dsh-home。CLI 与原生插件共享默认配置；项目隔离用 --config PATH 和 --state PATH。

doctor 只验证目录 RPC，不证明事件流或模型可用。smoke 在空工作目录创建独立会话，等事件订阅收到 baseline 后才提交固定短提示词；非空正文、completed 和精确 BFY_OK 同时成立才成功。目录可见、选模成功、prompt 已接收都不足以判为成功。

## 普通文本任务

```sh
node bin/bfy-ofm.mjs run --prompt-file ./prompt.txt --allow-model-call --use-local-session
node bin/bfy-ofm.mjs status
```

正文从文件读取，不放进命令行和本地审计。DSH 仍按自身策略保存会话，内容仍会发往所选上游。run/smoke 面向最小纯文本任务；观察到工具调用时请求停止并保留未知状态，不自动重放。这不是完整工具 Agent 的权限隔离器。

## 故障和恢复

- 提交前选模失败：冷却失败渠道，最多选择一次备用，不增加允许集之外的渠道。
- 提交后不自动重放：包括断线、超时、工具调用或接收回执未知。HTTP 错误不证明上游没有接受请求。
- state/<runId>.json 只记路由和状态；pending 在 status 中显示 unknown，保留供核对，不视为可以自动重试的队列。
- writer.lock 限制单进程写入。异常退出后，核对 PID 确已退出再移走锁；保留 unknown 记录，核对 DSH 会话后才决定是否重发。
- setup 内容相同可重复执行；已有不同配置时返回 CONFIG_EXISTS，不覆盖。使用新 --config 路径或人工合并。
- CLI 选模暂时触及 DSH 的新会话默认选择；结束时仅在默认值仍与本次选择一致时恢复之前的值，保留其他使用者的新选择。恢复不确认会留下 .cleanup.json。成功会话归档，未知会话保留检查。
- 空工作目录保留，因为 DSH 仍引用它；不删除用户工作区。

CN dfmodel 只有核实权益并提供未来 --cn-until 才进入生成配置。修改日期不会延长上游权益，也不能证明免费。

## 复用核心

`baifanyu-ofm/client` 导出 DshClient；`baifanyu-ofm/runner` 导出 runOneTurn，参数包括 client、config、stateDir、prompt、timeoutMs。根入口仍保留原来的核心函数。npm 包名已改为 baifanyu-ofm；已安装早期 baifanyu-ofm-bridge 源码包时，先通过宿主卸载旧包，避免同时注册 /bfy-ofm。

selectSessionRoute 只选模，runLaneAttempts 只限制次数。完整工具 Agent 仍须提供行动权限、回执和取消核对；mayReplayTurn 的未知值保持未知。看门狗支持 data.callId、data.toolCallId、data.message.toolCallId、data.message.source.callId；审批恢复由宿主传入 question/resolved 或 approval/resolved。
