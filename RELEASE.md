# 发布检查 / Release checklist

1. 使用 Node.js 22，执行 `npm ci --ignore-scripts` 和 `npm run verify`。
2. 在真实 Obsidian Desktop、Android 和 iOS 上分别验收生产账号授权、首次任务确认、双向增删改、冲突、断网恢复和退出登录。模拟测试只验证受控协议；未验证平台不得宣称通过。
3. 首次使用前备份 Vault。生产迁移会清除旧环境登录态与同步基线，并要求重新登录和确认目录，不删除笔记。
4. 确认版本更新记录、已知限制和隐私说明与本次行为相符。仓库地址确定后再设置实际 GitHub 链接。
5. 构建后执行 `npm run check:release -- --tag=版本号`。版本标签必须与 manifest 完全一致，不加 `v` 前缀。
6. GitHub Release 上传 `main.js`、`manifest.json`、`styles.css`，同时提供 LICENSE 和 THIRD_PARTY_NOTICES.md。不上传用户设置、数据库、Token 或构建缓存。

The MIT license covers this code. Cloud services, membership, trademarks, and service terms remain separate. The two protocol signing constants are intentionally public client parameters; user OAuth credentials must remain in Obsidian Secret Storage.

## 真实设备验证记录

| 平台 | 状态 | 版本 / 日期 / 验证人 / 结果 |
| --- | --- | --- |
| Desktop | not_evaluated | 发布前填写 |
| Android | not_evaluated | 发布前填写 |
| iOS | not_evaluated | 发布前填写 |
