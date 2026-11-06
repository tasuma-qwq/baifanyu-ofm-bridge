# 白饭鱼 OFM · Web 接入

默认先选 DeepSeek 免费池，也可以显式选择本人已有的 OFM 账号。插件负责接入和查看调用、账号轮换回执；你在 DSH 中手动选择的模型，以及 qq-bridge 自己的选模继续正常生效。

**0.3.2 修复 0.3.1 的启动级崩溃与会话挂死。** 不再把上游 OFM 作为依赖插入自己的装载行（那一行会连带注册第二份 OFM 浏览器半身，可能让桌面端启动审计直接终止），也不再让模型调用链路做同步磁盘写入；所有宿主往返都带上限并可被取消。0.3.1 已修复 0.3.0 的全局拦截问题：已移除模型拒绝逻辑及聊天创建/恢复时的自动改选，免费池是默认入口，不是只能使用的模型。

## 主要面向 Web + SnowLuma + qq-bridge

```text
QQ ↔ SnowLuma ↔ qq-bridge ↔ DSH Web ↔ OFM
```

把本插件安装到 **qq-bridge 实际连接的 DSH Web profile**，并使用该实例的 DSH_HOME 和端口。SnowLuma 负责 QQ 接线，qq-bridge 负责把消息交给 DSH；本插件不接管它们的消息、账号登录、人格或记忆。

先安装 OFM 本身，再装本插件。OFM 由 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 维护，请按其仓库当前的说明装载官方制品（注意 npm 上的裸名 `dsh-our-free-model` 不是该仓库发布的）；桌面端用应用内插件管理器。本插件不会再替你挂一份 OFM。

```sh
dsh plugin --profile web add baifanyu-ofm@0.3.2
```

遵守宿主正常安装、加载与供应链等待期。安装后在对应 DSH Web 会话说：

> 帮大肥鱼接入 OFM，默认先走 DeepSeek 免费池，保持当前思考档位，并检查账号轮换。

模型可调用 `bfy_ofm_onboard`。也可直接运行无需模型推理的命令：

```text
/bfy-ofm onboard
/bfy-ofm onboard qodercn
/bfy-ofm onboard trae
/bfy-ofm status
```

onboard 不指定来源时选免费池；指定渠道时选该渠道的 DeepSeek。目标不支持原思考档位时给出原因，不擅自调低。DSH 保存这次显式选模作为默认值；之后的手动选模和桥接选模不受限制，不会被本插件改回免费池。

免费池无账号门槛，但可能限流、拥堵或不可用。需要账号池时，在 OFM 中添加并授权本人已有的 qoder、qodercn、trae 等账号，再显式指定渠道；同一渠道至少两个可用账号才能检查备用。公开池没有可轮换的账号。

## 默认接入与手动选择

接入流程默认使用 OFM，不会在免费池失败后自动选择官方计费渠道。用户仍可在 DSH 中手动选择官方、其他 OFM 模型、自定义模型或聚合模型；本插件不拦截这些调用。

需要插件协助切回官方时，先了解其余额、套餐或 API 费用，再显式确认：

```text
/bfy-ofm fallback --confirm-official-billing
```

这只是插件提供的便捷切换流程，不是对宿主选模的权限限制。

## 证据与轮换

status 分别报告当前模型、OFM 实际调用、账号池备用预检和真实切换观察。预检不等于发生过切换；一次成功也不保证长期可用。账号调度、冷却与恢复仍由 OFM 管理。本插件只保存路由与回执，不保存提示词、回复正文、账号标识或凭据；观察记录出错也不会阻止模型调用。

OFM 是前置条件，不是本插件的依赖：0.3.2 起不再携带或挂载上游 OFM 副本，改为按能力检测（账号池服务或 OFM 模型路由存在）。缺少 OFM 时 onboard 与 status 返回 OFM_NOT_MOUNTED 并给出安装入口，不改动你的 profile 配置。桌面端使用应用插件管理器安装，作为补充支持场景。其他机器人框架尚未单独验收。OFM 内有三条接入车道——免费公开池（Kilo 免密，onboard 默认）、EAC 协付池（GitHub 登录并 star 上游仓库解锁，仅桌面端可见）、十个本人账号渠道（qoder/qodercn/trae/zcode/gemini/cline/loomy/raccoon/lobsterai/minimax）——各自的接入方式、可用模型与局限见[池子与账号](docs/public-pool-and-accounts.md)。

[接入说明](docs/deepseek-onboarding.md) · [验证记录](docs/validation.md) · [账号配置](docs/public-pool-and-accounts.md) · [与上游 OFM 的契约检修](docs/one-line-onboarding.md) · [0.3.1 崩溃与挂死调研](docs/crash-investigation-0.3.1.md)

## 来源与许可

OFM 属于 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)。[qq-bridge](https://github.com/Derpyu520/qq-bridge) 与 [SnowLuma](https://github.com/SnowLuma/SnowLuma) 各自维护。本项目提供模型接入，不提供账号或完整 QQ bot。MIT；来源与保留声明见 LICENSE、NOTICE.md 和 third_party/qq-bridge-LICENSE。
