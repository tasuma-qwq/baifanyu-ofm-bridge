# DSH 插件市场收录核查

核查日期：2026-10-31（Asia/Tokyo）。实际申请前重新核对规则。

## 已提交的申请

- [社区注册表 PR #10790](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10790)：新增一份 model 分类条目，申请和审核状态以 PR 为准。
- [DSH Plugin Hub 收录申请 #552](https://github.com/dshplugin/dsh-plugin-hub/issues/552)：维护者已回复按定期扫描自动拾取，应用内插件中心要求 npm 分发。项目使用 npm 包名 `baifanyu-ofm`，GitHub 仓库地址保留 `tasuma-qwq/baifanyu-ofm-bridge`。
- 仓库已添加 dsh-plugin、deepseek-harness、ofm、model-routing Topics，供各社区目录后续发现。

申请已发送不等于已收录。注册表的年龄检查若暂未达标，其 [regate 工作流](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/.github/workflows/regate.yml)会在后续定期扫描中重新评估；不需要反复开 PR 或推送空提交。

## npm 安装与仓库映射

```sh
dsh plugin --profile web add baifanyu-ofm
```

npm 包的 repository 字段指回本仓库，供市场将 npm 分发与已提交的仓库条目关联。版本和可下载状态以 [npm 包页面](https://www.npmjs.com/package/baifanyu-ofm)为准；npm 发布不等于市场扫描已完成。原生 bundle 加载 `baifanyu-ofm/plugin`。

v0.2.0 有 dsh.bundle、cordis.patch.yml 与实际 /bfy-ofm 命令，可按 model 分类准备申请。功能是确认后的渠道策略、任务档位、冷却与接入验证，不提供模型源、账号或完整 QQ bot。

## 应用内市场的社区注册表

[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的[贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)要求：公开且活跃的真实可用代码、dsh.bundle manifest、仓库创建满一天、dsh-plugin topic。PR 只新增 data/plugins/<owner>__<repo>.yml；README 自动生成。自动检查通过后仍有人工审核，描述必须与实际功能一致。

仓库创建于 2026-10-30 04:25:12 UTC，满一天是 **2026-10-31 13:25:12（日本时间）/ 12:25:12（北京时间）**。核查时尚未满一天。

可使用的申请条目：

```yaml
url: https://github.com/tasuma-qwq/baifanyu-ofm-bridge
name: tasuma-qwq/baifanyu-ofm-bridge
category: model
description:
  en: 'Adds OFM lane and effort selection, with public-pool setup, cooldown tracking, and a local DSH connection check.'
  zh: '提供 OFM 渠道与档位选择、免费公开池配置、冷却记录和本机 DSH 接入验证。'
```

## 其他发现入口

- [DSH Marketplace](https://dshmarketplace.dev/submit) 是独立项目，说明 dsh-plugin topic 可触发后续同步；投稿与精选另有流程，不隶属 DeepSeek。
- [DSH Plugin Hub](https://github.com/dshplugin/dsh-plugin-hub) 是另一社区市场，指向 [dsh-plugin.org 提交页](https://dsh-plugin.org/zh/submit)，也说明用 dsh-plugin topic 发现。

一个目录收录不代表其他市场已经审核；自动发现、申请开放、测试通过与 npm 可下载分别核对，不将其中任何一项表述为市场审核通过。
