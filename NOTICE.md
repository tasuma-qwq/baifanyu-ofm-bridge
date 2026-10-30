# 来源说明

本项目由 tasuma-qwq 整理发布，分享白饭鱼的 OFM 集成方式。

| 部分 | 来源与变化 |
| --- | --- |
| `src/model-lanes.js` | 从本地修改过的 qq-bridge 集成提取；v0.2.0 新增 DSH 选模错误分类 |
| `src/turn-stall-guard.js` | 同一集成的生产模块；v0.2.0 增补嵌套工具结果 ID 与显式审批恢复 |
| `src/inference-audit.js` | 同一集成的生产模块，规范换行 |
| 两个核心回归套件 | 从本地 qq-bridge 测试整理，移除依赖完整宿主的测试与历史注释 |
| `src/session-route.js`、公开契约测试、演示与文档 | 为本次独立发布新增 |
| `src/dsh-client.js`、`src/runner.js`、`src/configuration.js`、`src/plugin.js`、`bin/` | v0.2.0 新增；DSH 客户端依据公开宿主协议和本机静态接口验证编写，认证协议和 RPC 接线亦参考上述 qq-bridge 集成；没有复制 DSH 宿主实现 |

qq-bridge 上游：[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，MIT。版权声明与授权文本保存在 `third_party/qq-bridge-LICENSE`。本地未提交集成不冒充上游已有的功能；来源快照哈希见 `docs/provenance.json`。

Our Free Model 上游：[Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)。本仓库没有重新分发 OFM 源码、渠道包或其内置凭据。DSH 是独立宿主。项目名只用于说明互操作关系，不表示各上游对本项目的认可。

这次发布从文件白名单生成，未带入原工作区 Git 历史、配置、日志、数据库、聊天记录、日记、人格卡或账号授权资料。
