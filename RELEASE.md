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

## 1.0.3 — 登录重试与移动端界面修复 / Login recovery and mobile layout fixes

- PC 和移动端登录等待期间支持“重新登录”和“取消登录”，无需等待 180 秒超时；取消不清除已有有效凭据。
- 隔离每次登录尝试，忽略取消后的网络返回与旧授权回调；桌面端取消时关闭本地 OAuth 回调服务。
- 移动端同步确认表格保留完整四列并支持横向滚动，避免表头被挤到下一行。
- 云端文件夹选择器将新建区域移到目录列表上方，并支持弹窗纵向滚动。
- 小于 1 GiB 的存储容量按 MB 显示，保留两位小数。

验证：325 项自动化测试、生产构建、公开内容检查通过。本次改动已提供本地安装包，尚未记录新版 PC、Android 和 iOS 真机验收结果；下方 1.0.0 的真机记录不代表本版已验收。

## 1.0.4 — 安装兼容与统一界面 / Installation compatibility and unified settings

- 最低 Obsidian 版本调整为 `1.11.4`，与凭据存储 API 引入版本一致；使用该版 API 编译，修复 Android `1.12.7` 因旧门槛 `1.14.4` 无法从市场安装的问题。历史版本要求保持不变。
- 插件获准加载后检查 API 版本，过低时提示“版本过低，请先升级 obsidian”，不初始化凭据、数据库和同步。市场安装前的提示由 Obsidian 控制。
- PC 与移动端统一设置分组、目录选择和新建交互；目录选择器每次从根目录打开，新建成功后留在父目录。版本信息在页面底部居中显示。
- 规则编辑及目录新建使用浏览器视口与 Obsidian 原生键盘高度调整弹窗，保持操作栏可访问；在插件设置页和编辑弹窗轻触空白可收起键盘，不拦截控件或滑动手势。
- 配置不存在的新安装会清除残留的当前及旧插件登录凭据与待完成授权；正常重启、升级和重新启用保留登录态。
- 本地简介增加连续中文品牌词 `360AI云盘`。官方目录修改材料见 `docs/community-directory-update.md`；本次没有向官方目录发起 PR，发布插件不会直接改变市场搜索词。

验证：使用 Obsidian `1.11.4` API 完成类型检查；368 项自动化测试通过，覆盖版本门槛、模拟键盘视口与原生高度、轻触/滑动、目录交互和安装登录态。完整 `npm run verify`、发布附件检查与 `git diff --check` 均通过。

设备状态：用户确认 Android Obsidian `1.12.7`、iPhone Obsidian `1.15.0` 的此前手动安装可用；这不是 `1.0.4` 的市场安装或多机型键盘验收。本次未记录 `1.0.4` 真机市场安装和键盘显示/收起验收，模拟测试结果不代表真机通过。

## 构建与发布 / Build and publish

使用 Node.js 22，在仓库根目录执行：

```bash
npm ci --ignore-scripts
npm run verify
npm run check:release -- --tag=1.0.4
```

`npm run verify` 包含公开内容检查、测试和生产构建，成功后会生成 `main.js`。

完成下方发布检查后，将本版本提交推送至仓库默认分支，再打开 [创建 GitHub Release](https://github.com/Qihoo360/obsidian-yunpan-sync/releases/new)：

1. 选择包含本次版本修改的提交，创建标签 `1.0.4`，不要添加 `v` 前缀。
2. Release 标题填写 `1.0.4`，说明使用上方版本说明，并保留实际验证状态和已知限制。
3. 将构建自同一提交的 `main.js`、`manifest.json`、`styles.css` 作为独立附件上传，同时附上 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。
4. 确认标签、默认分支及附件中的 `manifest.json` 版本均为 `1.0.4`，附件齐全后发布 Release。

Obsidian 按 `manifest.json` 的版本号下载同名 GitHub Release 中的安装文件，只有源码或自动生成的源码压缩包不能替代上述附件。

## 发布检查 / Release checklist

1. 使用 Node.js 22，执行 `npm ci --ignore-scripts` 和 `npm run verify`。
2. 在真实 Obsidian Desktop、Android 和 iOS 上分别验收生产账号授权、首次任务确认、双向增删改、冲突、断网恢复和退出登录。模拟测试只验证受控协议；未验证平台不得宣称通过。
3. 首次使用前备份 Vault。生产迁移会清除旧环境登录态与同步基线，并要求重新登录和确认目录，不删除笔记。
4. 确认版本更新记录、已知限制和[隐私说明](PRIVACY.md)与本次行为相符，并检查仓库和服务链接可用。
5. 构建后执行 `npm run check:release -- --tag=1.0.4`。版本标签必须与 manifest 完全一致，不加 `v` 前缀。
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
