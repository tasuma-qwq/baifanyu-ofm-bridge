# DSH 插件市场收录核查

核查日期：2026-10-31（Asia/Tokyo）。实际申请前重新核对规则。

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
  en: 'Selects configured OFM model lanes and task effort levels, with cooldown tracking and a local DSH connection check.'
  zh: '为已配置的 OFM 渠道选择模型与任务档位，提供冷却记录和本机 DSH 接入验证。'
```

## 其他发现入口

- [DSH Marketplace](https://dshmarketplace.dev/submit) 是独立项目，说明 dsh-plugin topic 可触发后续同步；投稿与精选另有流程，不隶属 DeepSeek。
- [DSH Plugin Hub](https://github.com/dshplugin/dsh-plugin-hub) 是另一社区市场，指向 [dsh-plugin.org 提交页](https://dsh-plugin.org/zh/submit)，也说明用 dsh-plugin topic 发现。

一个目录收录不代表其他市场已经审核。本轮仅核查可行性并准备材料，没有修改 Topics、提交第三方 PR 或填表。代码提交授权不扩展为向第三方发送申请。
