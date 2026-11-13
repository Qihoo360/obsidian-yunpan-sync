# 隐私说明 / Privacy

本插件把当前 Vault 中符合过滤规则的文件与用户选择的 360AI 云盘目录双向同步。请求包含文件路径、名称、大小、哈希、时间、内容及必要的账号标识和授权凭据。删除会双向传播，首次同步前应备份 Vault。

生产服务包括：`https://openapi.eyun.360.cn/intf.php`、`https://yunpan.com/index/oauthCode`、`https://mcp.yunpan.com`，以及官网、会员续费与反馈页面 `https://www.yunpan.com`。上传下载使用 OpenAPI 返回并校验的 HTTPS Store 地址，域名须位于 `.yunpan.360.cn`、`.yunpan.com` 或 `.yunpan.cn`。会员图标可从校验后的公共 `qhimg.com` 域名加载。桌面和移动端 OAuth 使用 MCP 动态注册、PKCE 与 `obsidian://yunpan-sync` 协议回跳；桌面授权后展示 HTTPS 完成页，不再启动本机 HTTP 回调服务。

Access Token、云盘 Token、OAuth Code 和待完成的桌面及移动授权信息存储于 Obsidian Secret Storage；普通偏好由 Obsidian 保存。索引、任务、失败信息、冲突及最后成功时间保存在插件目录的 `sync.sqlite`。插件自身目录排除在同步范围之外。

插件向雷达统计服务 `https://ps.s.360.cn/pstat/plog.php` 发送安装后首次加载、启动、登录、同步结果及相关操作事件。上报信息包括事件时间、插件版本、平台、语言、屏幕尺寸、时区、设备名称与标识，以及可用的账号标识、套餐、会员状态、账号渠道和已用空间。同步结果还包含同步类型、配置同步开关、最多 10 条文件名称与 KB 大小（重命名或移动可包含源、目标路径）、失败数量和错误分类；不向统计服务发送文件正文或授权凭据，不写入本地 `radar.log`。当前没有关闭统计的设置。云盘服务的数据处理受其[隐私政策](https://www.yunpan.com/index/privateagreement)和服务条款约束。云盘容量及会员可能收费，本插件不是 Obsidian 官方 Sync 服务。

This plugin sends selected vault files and required metadata and credentials to the production 360AI Cloud Disk services listed above. OAuth credentials remain in Obsidian Secret Storage; local task state stays in the excluded plugin directory. Usage events are sent to `https://ps.s.360.cn/pstat/plog.php`, including timestamps, plugin and device details, available account identifiers, membership and channel information, and storage usage. Sync events include the sync type, configuration sync setting, up to 10 file names and sizes in KB (with source and destination paths for renames or moves), failure counts and error categories. Analytics does not include file contents or authorization credentials, and no local `radar.log` is written. There is currently no analytics opt-out setting. Cloud storage and membership may incur service charges. Back up your vault before enabling two-way synchronization.
