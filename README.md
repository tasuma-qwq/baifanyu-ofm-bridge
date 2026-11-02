# 白饭鱼 OFM · DeepSeek 一句话接入

让 DSH／大肥鱼继续使用 DeepSeek，把后续模型调用交给 OFM 免费池或本人已有账号，并检查账号轮换。保留用户原有思考档位，默认拦截官方余额及 API 渠道；官方兜底必须由用户主动确认。

**0.3.0 新增一句话接入与费用守卫。** 升级后使用下列 onboard 流程；旧版 0.2.0 不具备这些完整行为。

## 装好后说一句话

> 帮大肥鱼继续使用 DeepSeek，先走 OFM 免费池，保持现在的思考档位，并检查账号轮换。

本插件注册 `bfy_ofm_onboard` 工具供模型发现，也提供无需模型推理的命令：

```text
/bfy-ofm onboard
/bfy-ofm onboard qodercn
/bfy-ofm status
```

默认免费公开池没有账号门槛，但可能限流、拥堵或受地区网络影响；**公开池没有账号可轮换**。需要账号轮换时，显式指定本人已有的 qoder、qodercn、trae 等账号渠道，在同一渠道准备至少两个可用账号。不同渠道各一个账号不能当作同渠道账号池轮换通过。

低档位思考通常更快，但本流程不主动改变档位；目标不支持原档位时会停止说明。模型始终限定为当前目录能确认的 DeepSeek，不静默改用 GLM、MiMo 或未知内容的聚合模型。

## 自动装载 OFM

缺少 OFM 时随本包安装官方 `@ebony-vinyl/dsh-our-free-model@2.8.0` 并装载；已有实例则复用。不会安装来源不同的裸名 npm 包，也不会复制他人账号。账号池、冷却、配额切换和上游恢复继续由 OFM 自己管理。

通过当前宿主的插件管理器安装 `baifanyu-ofm@0.3.0`。纯 web 示例：

```sh
dsh plugin --profile web add baifanyu-ofm@0.3.0
```

也可从本仓库打包后安装：

```sh
npm ci --ignore-scripts
npm test
npm pack --ignore-scripts
dsh plugin --profile web add /绝对路径/baifanyu-ofm-0.3.0.tgz
```

桌面端使用应用的插件管理器，避免 CLI 改写 Electron 管理的 desktop profile。已安装旧版本时按宿主正常升级或卸载/重装，不修改供应链等待期设置来绕过安装门槛。

## 如何判断完成

结果分别报告：当前模型是否确认是 DS、原会话是否有 OFM 调用回执、账号池是否能选备用以及是否观察到实际切换。缺少任一证据，都给出原因和下一步，不能用“选模成功”代替真实调用，也不能用两个账号条目代替线上轮换。

实际轮换观察只记录不同账号的数量和切换布尔值，不保存账号标识、凭据或正文；不会另起一套调度器，也不会人为耗尽配额。一次宿主提交可能有多次上游恢复，物理请求数和扣款保持未知，面板等价 API 估值不当作账单。

## 官方兜底由用户选择

默认拒绝官方模型调用。近期 OFM 不可用、额度、认证或连接故障时，可以先阅读后果，再由用户主动确认：

```text
/bfy-ofm fallback --confirm-official-billing
```

兜底仍使用 DeepSeek，但可能扣官方余额、套餐或 API 费用；不会重放结果未知的旧任务。重新 onboard 回到 OFM 并关闭兜底。规则作用于安装本插件的 profile，不能撤销生效前已发出的调用或控制其他应用。

[完整接入与验收契约](docs/deepseek-onboarding.md) · [账号配置](docs/public-pool-and-accounts.md) · [验证记录](docs/validation.md)

## 来源与许可

Our Free Model 属于 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)。本仓库提供接入与宿主约束，不提供模型服务、账号或完整 QQ bot。MIT；保留 [LICENSE](LICENSE)、[NOTICE](NOTICE.md) 和 [qq-bridge 来源许可](third_party/qq-bridge-LICENSE)。本包只声明 OFM 依赖，不复制其代码或渠道包到本包。
