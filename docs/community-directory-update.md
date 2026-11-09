# 中文市场搜索的官方目录修改材料

状态：仅准备本地修改说明，尚未提交 PR，也未改变插件市场。

## 修改位置与内容

目标仓库：[obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)。
文件：`community-plugins.json`，仅修改 `id` 为 `yunpan-sync` 的条目的 `description` 字段。

建议简介：

```text
Sync a vault with 360AI Cloud Disk (360AI云盘) in both directions. - This plugin has not been manually reviewed by Obsidian staff.
```

保留名称 `360AI Cloud Sync`、作者、仓库及其他字段。简介末尾的审核提示由官方目录管理；应用修改前读取最新条目，保留当时的提示，不恢复已经由维护者移除的提示。

插件自己的 `manifest.json` 使用不含官方审核提示的简介：

```text
Sync a vault with 360AI Cloud Disk (360AI云盘) in both directions.
```

## 后续 PR 可用说明

标题：`Add Chinese product name to 360AI Cloud Sync description`

正文：

> Users searching for the Chinese product name `360AI云盘` cannot find `yunpan-sync`, because the community directory currently includes only the English product name. Add the Chinese name to the description while retaining the English name, plugin identity, repository, and existing review notice.

## 生效与验收

市场搜索使用官方目录中的名称、作者和简介，不使用已安装插件的本地简介。仅修改本仓库或发布插件版本不会更新官方目录中的搜索词。

官方目录更新需另按官方贡献流程更新条目并发起 PR；本次插件发布不包含该 PR。修改合并、目录缓存刷新后，在市场分别搜索 `360AI云盘`、`360AI 云盘` 和 `360AI Cloud Sync`，确认均能找到同一插件。

本材料随插件 `1.0.4` 提交和发布，仍仅为官方目录的后续修改说明，不代表目录已经更新。
