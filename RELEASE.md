# 发布说明与检查 / Release notes and checklist

仓库：[Qihoo360/obsidian-yunpan-sync](https://github.com/Qihoo360/obsidian-yunpan-sync)

## 1.0.0 — 首次正式发布 / Initial stable release

本版本整理现有能力作为首次正式发布，插件 ID 为 `yunpan-sync`，最低 Obsidian 版本为 `1.14.4`。

- 双向同步 Vault 与选定的 360AI 云盘目录，处理文件和文件夹的新增、修改、删除、重命名与移动，并通过增量索引减少重复传输。
- 提供手动、自动和低频自动同步，首次同步可预览并选择任务，运行时显示总体及单文件进度。
- 通过浏览器完成 OAuth 授权，Access Token 失效时使用已保存的 OAuth Code 自动续期；凭据保存在 Obsidian Secret Storage。
- 两端同时修改时先保留本地冲突副本，再应用云端状态；支持查看冲突文件并标记处理结果。
- 使用持久任务队列、失败重试、分块上传和哈希校验恢复传输，插件重启后可继续处理已保存的任务。

Desktop、Android 和 iOS 真实设备验收均已通过，记录见本文末尾。移动端自动和低频自动同步仅在 Obsidian 前台运行。首次同步耗时取决于文件数量和网络情况。

## 1.0.1 — 社区目录兼容性修复 / Community directory compatibility fix

将社区目录描述调整为不包含 `Obsidian` 品牌词，并保留与 `1.0.0` 相同的插件功能和 Release 附件格式。

## 1.0.2 — 设置页标题兼容性修复 / Settings heading compatibility fix

使用 Obsidian `Setting` 组件渲染设置页分组标题，避免社区目录源码检查将直接创建 HTML 标题判定为错误。

## 构建与发布 / Build and publish

使用 Node.js 22，在仓库根目录执行：

```bash
npm ci --ignore-scripts
npm run verify
npm run check:release -- --tag=1.0.0
```

`npm run verify` 包含公开内容检查、测试和生产构建，成功后会生成 `main.js`。

完成下方发布检查后，将本版本提交推送至仓库默认分支，再打开 [创建 GitHub Release](https://github.com/Qihoo360/obsidian-yunpan-sync/releases/new)：

1. 选择包含本次版本修改的提交，创建标签 `1.0.0`，不要添加 `v` 前缀。
2. Release 标题填写 `1.0.0`，说明使用上方版本说明，并保留实际验证状态和已知限制。
3. 将构建自同一提交的 `main.js`、`manifest.json`、`styles.css` 作为独立附件上传，同时附上 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。
4. 确认标签、默认分支及附件中的 `manifest.json` 版本均为 `1.0.0`，附件齐全后发布 Release。

Obsidian 按 `manifest.json` 的版本号下载同名 GitHub Release 中的安装文件，只有源码或自动生成的源码压缩包不能替代上述附件。

## 发布检查 / Release checklist

1. 使用 Node.js 22，执行 `npm ci --ignore-scripts` 和 `npm run verify`。
2. 在真实 Obsidian Desktop、Android 和 iOS 上分别验收生产账号授权、首次任务确认、双向增删改、冲突、断网恢复和退出登录。模拟测试只验证受控协议；未验证平台不得宣称通过。
3. 首次使用前备份 Vault。生产迁移会清除旧环境登录态与同步基线，并要求重新登录和确认目录，不删除笔记。
4. 确认版本更新记录、已知限制和[隐私说明](PRIVACY.md)与本次行为相符，并检查仓库和服务链接可用。
5. 构建后执行 `npm run check:release -- --tag=1.0.0`。版本标签必须与 manifest 完全一致，不加 `v` 前缀。
6. GitHub Release 上传 `main.js`、`manifest.json`、`styles.css`，同时提供 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。不上传用户设置、数据库、Token 或构建缓存。

## 隐私与许可 / Privacy and licensing

双向同步会向用户选择的云盘目录发送文件内容及必要元数据，删除会双向传播。数据范围、生产服务、凭据与本地状态存储详见[隐私说明](PRIVACY.md)。插件不发送独立客户端遥测；云盘容量和会员可能收费，本插件不是 Obsidian 官方 Sync 服务。

The MIT license covers this code. Cloud services, membership, trademarks, and service terms remain separate. The two protocol signing constants are intentionally public client parameters; user OAuth credentials must remain in Obsidian Secret Storage.

## 真实设备验证记录

用户于 2026-11-05 确认以下平台均已完成真实设备验证并通过。该日期为结果确认日期，实际测试日期及验证人未单独记录。

| 平台 | 状态 | 发布版本 | 结果来源 |
| --- | --- | --- | --- |
| Desktop | passed（通过） | 1.0.0 | 用户确认 |
| Android | passed（通过） | 1.0.0 | 用户确认 |
| iOS | passed（通过） | 1.0.0 | 用户确认 |
