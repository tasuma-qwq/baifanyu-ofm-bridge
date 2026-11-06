0.3.2 当前行为以 [接入说明](deepseek-onboarding.md) 为准：默认免费池，不限制手动或桥接选模。OFM 侧共有三条接入车道，按"先跑通、再求稳"的顺序引导；以下按上游当前版本的实际行为整理，模型清单以你模型目录里看到的为准。

# 三条接入车道：免费池 → EAC → 自己的账号

| 车道 | 准入 | 稳定性 | 适合 |
|---|---|---|---|
| 免费公开池（Kilo 免密） | 无需账号或 Key | 共享、不稳定 | 先跑通链路 |
| EAC 协付池 | GitHub 登录并 star 上游仓库 | 协付共享 | 桌面端需要更好的模型 |
| 账号绑定池 | 本人注册并登录对应服务 | 最可控 | 日常长期使用 |

## 车道一：免费公开池（Kilo 免密池）

接入：`/bfy-ofm onboard` 默认就是它，无需账号或 Key。OFM 设置页"免费模型"可见当前清单（鱼缸水位 = 可用模型占比）。

可用模型：清单由上游 `isFree` 实时拉取、动态增减，含 `kilo-auto/free` 自动路由；已知条目如 DeepSeek V4.1 Flash、GLM 5.3 Flash（OpenCode 公共车道）与 `recursive/flint-v1.0:free` 等，以目录实际为准。模型卡带 Kilo 徽章。

局限：

- 共享免费服务：繁忙时排队、429、超时或暂时不可用。
- 上游在模型卡中声明 prompt 可能被记录用于改进服务——不要发敏感内容。
- 清单会增减、下线或改变能力；存在不保证本次成功，不能承诺永久免费或无限量。
- 可用性取决于本机网络出口、地区和上游策略；换网络后应在 OFM 中刷新或重新探测。
- 没有账号，账号轮换不适用。部分上游端点强制思考或对关闭请求返回 400，两个自动路由不透传关闭。

## 车道二：EAC 协付池（GitHub 关注解锁，桌面端专属）

接入：OFM 设置页"EAC 渠道授权"一键发起 GitHub 登录（自动开浏览器，无需复制粘贴），服务端校验"已登录 + 已 star 上游仓库"后放行；未授权时模型卡带锁标记。

可用模型（条目带 EAC 前缀）：DeepSeek V4.1 Flash（1M 上下文、视觉，思考档位 none–max 全档）、DeepSeek V4.1 Flash Highspeed 与 GLM 5.3 Flash Highspeed（OpenCode 免费车道经中转，输出上限比同款紧）、GLM 5.3（1M，无视觉）、GLM 5.3 Flash、Kimi K2.6（262k）、Kimi K3（1M）、GPT-OSS 20B（131k，默认 medium）、Mistral Large 4 1T A52B（262k、视觉，仅 Off/High 两档）。

局限：

- 只在 DeepSeek Harness 桌面端 / DSHEAC AIO 桌面端存在；本插件的主要场景（SnowLuma + qq-bridge + DSH Web）和 CLI 里这条车道不存在，模型目录看不到。
- 协付池由共享资源支撑（水位 = 协付池压力），繁忙时同样可能失败。
- 思考档位按各模型接受的枚举校验，模型之间不同，不接受的档位会 400。
- GitHub 授权状态可能过期，过期后车道重新上锁。

EAC 模型不需要本插件接入：授权后它们就是宿主模型目录里的普通条目，手动选模或桥接直接选即可，本插件不限制也不代办授权。

## 车道三：绑定自己账号的池（十个渠道）

渠道：Qoder / QoderCN / TRAE / ZCode / Gemini / Cline / Loomy / Raccoon / LobsterAI / MiniMax。

接入：DSH"设置 → Our Free Model"的"白嫖模型接入"页（十张渠道卡），选择自己有权使用的服务按官方流程登录或添加账号；凭据加密存于宿主库。登录授权由本人完成，不把密码、Cookie 或 token 发给 Agent，也不导入别人提供的账号。

可用模型（本插件已知车道与思考档位）：`qodercn/dfmodel`（none/low/high/max）、`qoder/qfmodel`（none/low/medium/xhigh）、`trae/deepseek-v4.1-flash`（light/high/extra_high）；其余渠道以 doctor 输出的目录为准。每个渠道卡可单独开关模型、领取积分。

局限：

- 额度、限频与有效期随各服务套餐而定：qodercn 日额度耗尽后冷却到 UTC+8 次日零点；TRAE 凭证靠 refresh_token 续期、可能次日到期；ZCode 无 refresh、过期需重登。以 OFM 面板与实际回执为准，不把预检当成余额事实。
- 添加账号不等于所有模型免费；先核对该服务的套餐、剩余额度、积分与付费余额。
- 账号轮换只在同一渠道存在至少两个可选择的有效账号时才可能发生；各渠道各一个账号不是轮换，公开池没有账号轮换。

---

# 旧版接口说明（CLI 兼容参考）

0.3.0 默认只选择 DeepSeek，主入口为 `/bfy-ofm onboard`，指定本人账号为 `/bfy-ofm onboard qodercn` 等；旧 setup/独立 smoke 不替代新流程。免费池没有账号轮换；同一渠道至少两个可选择的有效账号只是就绪条件，实际切换还需调用回执。思考档位保持原值，低档位更快只是建议。

首次接入运行 setup 即可：从当前 OFM 目录选择公开免费模型作为主备，不要求先注册账号。默认只使用 our-free-model 下的直接公开模型，不把 EAC 前缀、账号渠道或用户编辑的聚合链自动加入。目录没有可确认的公开候选时会解释原因，停止等待，不静默切到付费账号。

## 免费公开池的限制

- 这是上游共享服务：并发、速率和使用量可能受限，繁忙时可能排队、429、超时或暂时不可用。
- 可用模型会增减、下线或改变能力；清单存在不保证本次请求成功，不能承诺永久免费或无限量。
- 可用性取决于你这台机器的网络出口、地区和上游策略；换网络后应在 OFM 中刷新或重新探测。
- 不适合作为重要业务的唯一保障。需要更可控的额度时，添加自己的账号并明确配置备用；不会自动替你购买或借用他人账号。
- 公开池请求仍会发送给对应上游。不要因为免费就提交敏感资料；查看 OFM 当前说明，确认实际服务来源和规则。

共享限制没有统一固定数值，本项目不编造每分钟次数或每日额度。失败时以实际错误和 OFM 面板为准。

## 添加自己的账号渠道

1. 打开 DSH 的“设置 → Our Free Model”，进入账号/渠道页面（当前上游称“白嫖模型接入”，名称可能随版本变化）。
2. 选择自己有权使用的服务，例如 TRAE 或 Qoder 中国版，按插件提供的官方流程登录或添加账号。登录及授权由本人完成，不把密码、Cookie 或 token 发给 Agent，也不导入别人提供的账号池。
3. 核对该服务的套餐、剩余额度、是否会消耗积分或付费余额；在 OFM 中启用所需模型并刷新目录。添加账号不等于所有模型免费。
4. 运行 doctor 查看实际 provider/model，再显式选择：

```sh
npm run doctor -- --use-local-session
npm run setup -- --config ./my-account-config.json --lanes trae/deepseek-v4.1-flash --use-local-session
npm run smoke -- --config ./my-account-config.json --allow-model-call --use-local-session
```

账号示例必须与本机目录一致。使用新配置路径可保留原公开池配置；如果要正式替换共享配置，先检查并人工合并，setup 不会悄悄覆盖。

也可把公开池放前面、自己的账号放后面，用 --lanes 明确排列完整链。但上游生成失败后不会自动重放未知结果；提交前选模失败和下一次新任务会按冷却选择备用。

原生插件同样支持 `/bfy-ofm setup` 默认公开池；指定账号渠道时使用 `/bfy-ofm setup provider/model`，已有不同配置需先合并。Qoder CN 的 dfmodel 需提供已核实的有效期限，见 integration.md。

OFM [上游使用和渠道说明](https://github.com/Ebony-Vinyl/dsh-our-free-model#使用说明)是账号流程与权益核对的来源，本项目不提供账号或替代官方授权。
