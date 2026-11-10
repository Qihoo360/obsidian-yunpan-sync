# 隐私说明 / Privacy

本插件把当前 Vault 中符合过滤规则的文件与用户选择的 360AI 云盘目录双向同步。请求包含文件路径、名称、大小、哈希、时间、内容及必要的账号标识和授权凭据。删除会双向传播，首次同步前应备份 Vault。

生产服务包括：`https://openapi.eyun.360.cn/intf.php`、`https://yunpan.com/index/oauthCode`、`https://mcp.yunpan.com`，以及官网、会员续费与反馈页面 `https://www.yunpan.com`。上传下载使用 OpenAPI 返回并校验的 HTTPS Store 地址，域名须位于 `.yunpan.360.cn`、`.yunpan.com` 或 `.yunpan.cn`。会员图标可从校验后的公共 `qhimg.com` 域名加载。桌面和移动端 OAuth 使用 MCP 动态注册、PKCE 与 `obsidian://yunpan-sync` 协议回跳；桌面授权后展示 HTTPS 完成页，不再启动本机 HTTP 回调服务。

Access Token、云盘 Token、OAuth Code 和待完成的桌面及移动授权信息存储于 Obsidian Secret Storage；普通偏好由 Obsidian 保存。索引、任务、失败信息、冲突及最后成功时间保存在插件目录的 `sync.sqlite`。插件自身目录排除在同步范围之外。

插件不采集或发送独立的客户端遥测、分析或崩溃报告。云盘服务的数据处理受其[隐私政策](https://www.yunpan.com/index/privateagreement)和服务条款约束。云盘容量及会员可能收费，本插件不是 Obsidian 官方 Sync 服务。

This plugin sends selected vault files and required metadata and credentials to the production 360AI Cloud Disk services listed above. OAuth credentials remain in Obsidian Secret Storage; local task state stays in the excluded plugin directory. The plugin sends no independent client telemetry. Cloud storage and membership may incur service charges. Back up your vault before enabling two-way synchronization.
