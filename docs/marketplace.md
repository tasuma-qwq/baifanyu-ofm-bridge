# 插件市场同步状态

核对日期：2026-11-09（UTC）。

## 当前发布与同步

- **npm / GitHub：0.3.3 已发布。** npm 发布时间 2026-11-09T05:02:58Z，`latest` 为 0.3.3，registry 上的版本是 0.0.0-stage、0.2.0、0.3.1、0.3.3。0.3.2 只发过 GitHub Release，没有进 npm；tag `v0.3.3` 与 main 同为 `2d925fe`，已包含 v0.3.2 的全部提交。入口：[npm 0.3.3](https://www.npmjs.com/package/baifanyu-ofm/v/0.3.3)、[GitHub Release](https://github.com/tasuma-qwq/baifanyu-ofm-bridge/releases/tag/v0.3.3)。
- **匿名下载完整性已核对。** tarball 57394 字节、30 个文件，sha1 `60c406dfb4b99ca00338a5fc95742394ac02628f`，sha512 与 registry 的 `dist.integrity` 一致；依赖只有 `ws` 与 `js-yaml`，不再把上游 OFM 当作自身依赖。发布前在干净检出上 `npm ci` 后 83 项回归全部通过。
- **主市场：简介已刷新，版本仍是 0.3.1。** 收录 [PR #10790](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10790) 与简介更新 [PR #11549](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11549) 都已合并，[公开索引](https://awesome-dsh-plugin.com/plugins.json) 的中英文描述与当前功能一致；但索引的 capabilityCheckedAt 为 2026-11-09T04:07:01Z，目录载体 `dsh-plugin-catalog@2026.1109.17642` 构建于 04:49:06Z，都早于 05:02:58Z 的 npm 发布，所以版本字段还没跟上，要等下一轮扫描与站点构建。
- **Hub 申请本轮未更新：[Issue #552](https://github.com/dshplugin/dsh-plugin-hub/issues/552)。** 安装命令与验证说明仍停在 0.3.1，保留原有已完成状态，不重复创建申请。
- **仓库公开简介已更新。** 为自动读取 GitHub metadata 的市场提供当前功能描述。

## 版本与简介怎样更新

主市场的 YAML 条目只维护仓库、分类及简介等字段。根据其 [贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，npm 包映射从 registry 自动采集，条目不能手写 npm 字段；版本也应由市场生成。npm package.json 的 repository 已指向本仓库。

因此两条链路分别是：简介通过更新 PR 合并，版本通过市场正常扫描和站点构建刷新。PR 提交、CI 通过、维护者合并和站点可见是不同阶段；没有维护权限时不能强制更新对方主分支或部署。

## 当前安装

```sh
dsh plugin --profile web add baifanyu-ofm@0.3.3
```

安装到 qq-bridge 实际连接的 DSH Web profile。桌面端使用应用插件管理器。遵守宿主供应链等待期及正常安装机制：发布未满 24 小时时 pnpm 的 `minimumReleaseAge` 会拦下新版本，pnpm 11.28.5 会把 `baifanyu-ofm@0.3.3` 自动追加进 profile 的 `minimumReleaseAgeExclude`。

免费池只是默认入口；0.3.1 起已移除全局模型拦截和创建/恢复聊天时的自动改选，用户手动或桥接选择的模型正常生效。0.3.3 新增 `bfy_ofm_switch` 工具与 `/bfy-ofm switch [provider[/model]]` 命令：只执行用户点名的切换，保留思考档位，不翻转 OFM 总开关，失败后也不自动重试或自动换车道。

## 本机宿主核对

- Web profile 已升到 0.3.3：声明版本、已安装版本、lockfile integrity 与发布 sha512 三者一致。上游 OFM 渠道包仍固定在原 GitHub commit（2.8.0），没有被降级；0.3.3 移除该依赖后，对应的 scoped lockfile 条目随之剪除。
- 宿主重启后运行已安装产物自带的 `bfy-ofm doctor --use-local-session`：ok:true、slash-rpc、38 个候选模型。

未验证：doctor 只读模型目录，没有调用任何模型，事件流也未探测；真实宿主上的 `switch` 复测与 QQ 会话回归仍未做。
