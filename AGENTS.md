# 完成使用者的 OFM 接入

使用者要求保持 DS、将大肥鱼消耗转到 OFM 时，优先调用已装载插件的 bfy_ofm_onboard 工具或 /bfy-ofm onboard；阅读 README 与 docs/deepseek-onboarding.md。不要再从旧示例现场编写客户端、静默降思考档位或增加其他模型。

1. 确认正在使用的 DSH 是桌面端还是纯 web、实际端口和 DSH_HOME。复用当前应用上下文；仍缺失时只询问该项，不扫描其他 profile 的凭据。
2. 运行 npm ci --ignore-scripts，再运行 node bin/bfy-ofm.mjs doctor。访问本机登录会话须有明确授权；已有授权时用 --use-local-session 和确切 --dsh-home，或用户已配置的 DSH_AUTH_COOKIE / DSH_LAUNCH_TOKEN，不打印密钥。
3. 缺 OFM 时，按其官方仓库当前说明选择当前宿主的安装方式。桌面 profile 由应用插件管理器管理。涉及安装、宿主配置或登录时遵守本轮授权；仅暂停缺授权的步骤，继续其他检查，不安装来源不明的同名 npm 包。
4. 默认 onboard free，接入时先选择可确认的 DeepSeek 公开模型并保留当前显式档位。说明免费池无门槛但不稳定，且没有账号轮换；推荐本人已有渠道，指定 onboard qoder/qodercn/trae。账号不足时说明需同渠道至少两个可用账号，不注册或导入他人账号，不把预检当成真实切换。
5. 本插件不携带也不挂载 OFM 副本：cordis.patch.yml 只允许插入 baifanyu-ofm 自己的子路径行，按裸包名插入第三方插件会连带注册它的浏览器半身，可能让桌面端启动直接终止。OFM 一律由宿主的插件管理器按上游官方说明安装（npm 裸名 `dsh-our-free-model` 不是上游制品），插件只按能力检测。遵守宿主安装机制与供应链等待期；不直接改 loader/profile 文件或 minimumReleaseAgeExclude。桌面端通过应用管理器装载。
6. 获得短模型调用授权后执行 smoke --allow-model-call。已授权明确次数时不重复询问，严格记录提交次数；预检和订阅失败尚未提交，提交回执不明则算一次可能提交。
7. 以当前会话的 DS 选择、OFM 宿主调用/账号选择回执及实际轮换观察分别验收；未满足时给原因和下一步，不把物理请求数或金额猜成事实。旧 smoke 只证明一个独立文本任务，不能替代原会话和账号池验收。unknown 不自动重发。

官方兜底默认关闭。先向用户说明触发原因和会消耗官方余额/套餐/API 费用，只有明确同意后才能执行人工 fallback --confirm-official-billing。工具不提供让 Agent 自行批准费用的参数。重新 onboard 关闭兜底。

交付时说明所用渠道、验证范围和下一条可使用命令，不把通过扩展为永久免费、长期稳定或完整 QQ/记忆系统已安装。

开发时保留核心接口，运行 npm test 与 npm run demo；真实验证需要授权。只提交公开源码、文档和合成测试，不提交配置、state、日志、会话内容、凭据或作者目录。用 npm pack --dry-run 检查 CLI 与 bundle 的发布清单。

0.3.1：免费池只是接入默认值，不是模型允许列表。不得拦截或覆盖用户手动选择、qq-bridge 的选择或其他模型调用；安装、创建和恢复聊天不触发自动改选。主要在 SnowLuma + qq-bridge 的实际 DSH Web profile 验证，不能用桌面端结果代替。

0.3.2：任何进入模型调用链路的代码都不得做同步磁盘 I/O；对宿主接口（目录、选模、账号池、OFM 设置）的等待必须带本地上限并透传取消信号，结果未知时报告为未确认，不宣称完成，也不让回合无限等待。
