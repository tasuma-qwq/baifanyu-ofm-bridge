# 完成使用者的 OFM 接入

使用者把仓库交给你并要求接入时，阅读 README 和 docs/integration.md，按下列路径执行现有入口。

1. 确认正在使用的 DSH 是桌面端还是纯 web、实际端口和 DSH_HOME。复用当前应用上下文；仍缺失时只询问该项，不扫描其他 profile 的凭据。
2. 运行 npm ci --ignore-scripts，再运行 node bin/bfy-ofm.mjs doctor。访问本机登录会话须有明确授权；已有授权时用 --use-local-session 和确切 --dsh-home，或用户已配置的 DSH_AUTH_COOKIE / DSH_LAUNCH_TOKEN，不打印密钥。
3. 缺 OFM 时，按其官方仓库当前说明选择当前宿主的安装方式。桌面 profile 由应用插件管理器管理。涉及安装、宿主配置或登录时遵守本轮授权；仅暂停缺授权的步骤，继续其他检查，不安装来源不明的同名 npm 包。
4. 默认运行 setup，从当前目录配置免费公开池，直接完成这条接入路径；向使用者说明共享池的限流、拥堵、地区/网络和模型变动限制，并给出 docs/public-pool-and-accounts.md 的账号配置方法。不自动加入账号、EAC 或可编辑聚合链。只有使用者要求自己的账号渠道时才用 setup --lanes，并核对其授权及权益；不编造 CN 权益日期。
5. 用户需要原生插件时按 integration.md 安装 bundle，验证 /bfy-ofm doctor，使用 /bfy-ofm setup 与 /bfy-ofm chat。命令行入口可以独立工作，无须为了 CLI 强制安装原生插件。
6. 获得短模型调用授权后执行 smoke --allow-model-call。已授权明确次数时不重复询问，严格记录提交次数；预检和订阅失败尚未提交，提交回执不明则算一次可能提交。
7. smokeMatched=true、非空正文与 completed 同时成立才报告真实接入通过。离线测试、目录读取和选模分别报告。失败按错误和 status 定位；unknown 不自动重发。

交付时说明所用渠道、验证范围和下一条可使用命令，不把通过扩展为永久免费、长期稳定或完整 QQ/记忆系统已安装。

开发时保留核心接口，运行 npm test 与 npm run demo；真实验证需要授权。只提交公开源码、文档和合成测试，不提交配置、state、日志、会话内容、凭据或作者目录。用 npm pack --dry-run 检查 CLI 与 bundle 的发布清单。
