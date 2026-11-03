# 插件市场同步状态

核对日期：2026-11-03（Asia/Tokyo）。

## 当前发布与同步

- **npm / GitHub：0.3.1 已发布。** 已验证官方 registry 的 latest、匿名下载完整性及独立目录安装。入口：[npm 0.3.1](https://www.npmjs.com/package/baifanyu-ofm/v/0.3.1)、[GitHub Release](https://github.com/tasuma-qwq/baifanyu-ofm-bridge/releases/tag/v0.3.1)。
- **主市场：项目已收录。** 原收录 [PR #10790](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10790) 已合并。核查时 [公开索引](https://awesome-dsh-plugin.com/plugins.json) 仍显示 0.2.0 和旧简介，不能把 npm 发布成功写成市场已经刷新。
- **新版简介更新已提交：[PR #11549](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11549)。** 只修改 data/plugins/tasuma-qwq__baifanyu-ofm-bridge.yml 的描述，说明 Web / qq-bridge、默认免费池、官方依赖装载、自有账号及保留手动选模；不改生成的 README 或其他插件。
- **Hub 申请已更新：[Issue #552](https://github.com/dshplugin/dsh-plugin-hub/issues/552)。** 安装命令、使用入口、兼容条件、CI 与验证说明均更新到 0.3.1，保留原有已完成状态，不重复创建申请。
- **仓库公开简介已更新。** 为自动读取 GitHub metadata 的市场提供当前功能描述。

## 版本与简介怎样更新

主市场的 YAML 条目只维护仓库、分类及简介等字段。根据其 [贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，npm 包映射从 registry 自动采集，条目不能手写 npm 字段；版本也应由市场生成。npm package.json 的 repository 已指向本仓库。

因此两条链路分别是：简介通过更新 PR 合并，版本通过市场正常扫描和站点构建刷新。PR 提交、CI 通过、维护者合并和站点可见是不同阶段；没有维护权限时不能强制更新对方主分支或部署。

## 当前安装

```sh
dsh plugin --profile web add baifanyu-ofm@0.3.1
```

安装到 qq-bridge 实际连接的 DSH Web profile。桌面端使用应用插件管理器。遵守宿主供应链等待期及正常安装机制。

免费池只是默认入口；0.3.1 已移除全局模型拦截和创建/恢复聊天时的自动改选。用户手动或桥接选择的模型正常生效。
