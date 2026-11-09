<h1 align="center">360AI Cloud Sync</h1>

<p align="center">
  <a href="#zh">中文</a> ·
  <a href="#en">English</a>
</p>

<p align="center">
  <strong>在 Obsidian Desktop 与 360AI 云盘之间可靠地双向同步整个笔记库。</strong><br>
  <em>Reliable two-way synchronization between Obsidian Desktop and 360AI Cloud Disk.</em>
</p>

---

<a id="zh"></a>

360AI Cloud Sync 是面向 360AI 云盘用户的 Obsidian Desktop、Android 和 iOS 双向同步插件。它会比较上次同步基线、本地文件和云端文件，只传输真正发生变化的内容，并妥善处理删除、重命名和双边修改冲突。

### 为什么使用 360AI Cloud Sync

- **完整的双向同步**：同步文件和文件夹的新增、修改、删除、重命名与移动。
- **增量同步**：首次建立远端索引和同步基线，后续只处理本地或云端发生的变化。
- **重要操作看得见**：首次同步前可检查并选择待执行任务；同步过程中可查看总体进度和每个文件的进度。
- **冲突内容不会静默覆盖**：两端同时修改时保留本地冲突副本，再应用云端版本。
- **大文件传输可恢复**：支持分块上传、缺失块补传、哈希校验和持久任务队列。
- **登录状态自动续期**：Access Token 失效后使用已保存的 OAuth Code 自动获取新 Token；只有 OAuth Code 也失效时才要求重新登录。

### 快速开始

需要 Obsidian **1.11.4 或更高版本**（Desktop、Android、iOS）。市场提示 `No appropriate version found.` 时，请检查 Obsidian 版本并升级；插件获准加载后也会对低版本显示“版本过低，请先升级 obsidian”。

1. 将 `main.js`、`manifest.json` 和 `styles.css` 放入 Vault 的 `.obsidian/plugins/yunpan-sync/` 目录。
2. 在 Obsidian 的 **设置 → 第三方插件** 中启用 **360AI Cloud Sync**。
3. 打开插件设置，点击 **登录**，在浏览器中完成 360AI 云盘授权。
4. 在云端目录选择器中选择已有文件夹，或创建一个新文件夹作为当前 Vault 的同步目录。
5. 保持默认的 **手动** 模式，点击左侧功能区的同步图标，或从命令面板运行 **360AI Cloud Sync: 立即同步**。
6. 首次同步时检查任务列表，确认无误后继续。

移动端进入设置页会先显示“准备登录…”，准备好后点击“登录”直接打开授权链接。若浏览器未打开，仍可使用“打开授权页面”或复制授权链接；准备失败时点击“重试准备”。

> [!IMPORTANT]
> 首次同步前请备份 Vault。双向同步会传播删除操作；如果同一路径在两端都有不同内容，插件会保留冲突副本，但备份仍是最稳妥的恢复方式。

### 同步模式

| 模式 | 行为 | 适合场景 |
| --- | --- | --- |
| **手动** | 只在点击“立即同步”或运行命令时同步 | 首次安装、按需同步 |
| **自动** | 本地变化后防抖约 1.5 秒触发同步，同时约每 3 分钟检查云端变化 | 多设备持续同步 |
| **低频自动** | 按设置的分钟间隔执行完整同步，可设 4–1440 分钟，默认 30 分钟 | 希望降低后台请求频率 |

所有模式都保留 **立即同步** 命令。你也可以随时暂停或恢复同步。

### 同步过程与恢复

- **远端索引**：首次同步读取完整云端目录，后续使用增量游标获取变化；云端文件未显示或同步状态异常时，可在设置中使用“一键自动修复”重新检查。
- **任务预览**：首次同步展示上传、下载、新建目录、删除、重命名和移动等计划任务，可取消不希望执行的项目。
- **传输进度**：同步弹窗、设置页和右侧状态面板展示总体状态、队列数量以及每个文件的进度条。
- **失败重试**：可重试单个失败文件或全部失败任务；持久任务会在插件重新启动后恢复。
- **过滤规则**：可按文件名、目录或通配符包含或排除内容，支持启停、调整顺序和区分大小写；规则按列表从上到下匹配，最后命中的规则生效，同时作用于上传、下载和本地变更监听。
- **完整性校验**：上传和下载使用文件哈希及分块哈希校验，下载完成后再替换目标文件。
- **同步状态**：状态栏展示当前阶段，内容无变化时会明确提示“本地与云端已是最新”。

### 冲突处理

当本地和云端从同一同步基线开始都发生变化时，插件不会静默覆盖本地内容：

1. 本地版本会被保存为 `文件名 (conflict-设备名-时间).扩展名`。
2. 云端版本会写回原路径；如果云端已经删除该文件，则原路径会按云端状态删除。
3. 冲突副本会继续参与后续同步。
4. 可在右侧同步状态面板中打开原文件和冲突副本，并在检查后标记为已处理。

### 文件范围与过滤

- 默认同步当前 Vault 中除 `.obsidian` 以外的全部文件和文件夹。
- 可选择同步 `.obsidian` 配置目录；插件自身目录始终排除，避免同步本地数据库、凭据和设备状态。
- `.trash`、`.yunpan-sync`、系统文件和常见临时文件始终排除。
- 可按路径和通配符设置“排除”或“包含”规则，例如排除 `Private/**` 后包含 `Private/keep/**`；规则同时作用于上传和下载。
- 每个 Vault 绑定一个独立的 360AI 云盘目录，可在可视化目录选择器中选择或新建目录。


- 使用本插件必须拥有 360AI 云盘账号并连接网络。插件本身不收费；云盘容量、会员权益与续费由 360AI 云盘提供并可能产生费用，设置页的续费按钮会打开云盘网页。
- 为完成同步，插件会向上述服务发送文件路径、名称、大小、哈希、修改时间、文件内容，以及账号 `qid` 和必要的 OAuth/访问凭据。除用户选择绑定的云端目录外，插件不会把 Vault 文件发送给其他服务。
- 登录后在设置页展示账号、手机号或邮箱、会员状态、到期时间和存储空间，并提供续费入口。
- Access Token 失效时自动使用原 OAuth Code 续期，不会频繁打开浏览器要求重新授权。

### 使用前须知

- Desktop、Android 和 iOS 均支持手动、自动和低频自动同步，默认使用手动模式。移动端自动同步和低频自动仅在 Obsidian 前台运行，离开前台或锁屏后会暂停并保存任务；回到 Obsidian 后会继续按所选模式工作。
- 移动端 OAuth 登录已通过真实设备验证，详见 [验证记录](RELEASE.md#真实设备验证记录)。
- Android 和 iOS 登录通过 MCP 选择移动授权页，未登录云盘时先登录，再确认授权并返回 Obsidian；桌面端沿用原授权页。
- 首次同步需要扫描本地与云端；文件较多时会比后续增量同步耗时更长。
- 删除会双向传播。删除前请确认其他设备上的修改已经完成同步。
- 被过滤的文件不会上传，也不会从云端下载，因此两端可能有意保持不同。
- 同步进行时请尽量避免由其他程序持续改写同一批文件；失败任务可以在状态面板中重试。
- 本插件不是 Obsidian 官方 Sync 服务。
- 本插件也不是 Obsidian 官方发布或背书的产品；云端数据处理受 360AI 云盘服务条款与隐私政策约束。

---

<a id="en"></a>

360AI Cloud Sync is an Obsidian plugin for Desktop, Android, and iOS. It compares the last synchronized baseline with local and remote state, transfers only what changed, and handles deletion, rename, move, and concurrent-edit conflicts.

### Why 360AI Cloud Sync

- **Complete two-way sync**: Synchronize file and folder creation, modification, deletion, rename, and move operations.
- **Incremental updates**: Build a remote index and baseline on the first run, then process only local or cloud changes.
- **Visible operations**: Review and select planned tasks before the first sync, then follow overall and per-file progress while it runs.
- **No silent conflict overwrite**: Preserve a local conflict copy before applying the cloud version when both sides change.
- **Recoverable large-file transfers**: Use block upload, missing-block recovery, hash verification, and a persistent task queue.
- **Automatic session renewal**: Reuse the saved OAuth Code when the Access Token expires; ask for browser authorization again only after the OAuth Code itself expires.

### Quick Start

Requires Obsidian **1.11.4 or later** on Desktop, Android, and iOS. If the community installer reports `No appropriate version found.`, check and upgrade your Obsidian version. The plugin also checks the API version when it is allowed to load.

1. Place `main.js`, `manifest.json`, and `styles.css` in `.obsidian/plugins/yunpan-sync/` inside your vault.
2. Enable **360AI Cloud Sync** under **Settings → Community plugins** in Obsidian.
3. Open the plugin settings and click **Sign in** to authorize 360AI Cloud Disk in your browser.
4. Choose an existing cloud folder, or create a new folder to bind to the current vault.
5. Keep the default **Manual** mode for the first run. Click the sync ribbon icon, or run **360AI Cloud Sync: Sync now** from the command palette.
6. Review the planned tasks and continue when they look correct.

On mobile, wait for sign-in preparation to finish, then tap **登录** to open the authorization link directly. If the browser does not open, use **打开授权页面** or copy the link. If preparation fails, tap **重试准备** to retry.

> [!IMPORTANT]
> Back up your vault before the first sync. Two-way sync propagates deletions. The plugin preserves a conflict copy when both sides contain different content at the same path, but a backup remains the safest recovery option.

### Sync Modes

| Mode | Behavior | Best for |
| --- | --- | --- |
| **Manual** | Sync only when you click **Sync now** or run the command | First-time setup and on-demand sync |
| **Automatic** | Sync local changes after about 1.5 seconds of debounce and check remote changes about every 3 minutes | Continuous multi-device sync |
| **Scheduled** | Run a full sync every 4–1440 minutes as configured; defaults to 30 minutes | Reducing background request frequency |

The **Sync now** command remains available in every mode. Synchronization can also be paused and resumed at any time.

### Progress and Recovery

- **Remote index**: Read the complete cloud directory during initial setup, then use incremental cursors; rebuild the index when a cursor becomes invalid.
- **Task review**: Preview planned uploads, downloads, directory creation, deletion, rename, and move operations before the first sync, and deselect unwanted tasks.
- **Transfer progress**: See the overall status, queue counts, and a progress bar for each file in the sync dialog, settings page, and right-side status view.
- **Retry and resume**: Retry one failed file or all failed tasks; persistent tasks recover after the plugin restarts.
- **Integrity checks**: Verify whole-file and block hashes during transfer, and replace a downloaded target only after validation succeeds.
- **Clear outcomes**: The status bar reports the current phase and explicitly says when local and cloud content are already up to date.

### Conflict Handling

When both local and remote content have changed since the same baseline, the plugin does not silently overwrite the local version:

1. The local version is saved as `name (conflict-device-timestamp).ext`.
2. The cloud version is written to the original path. If the cloud copy was deleted, the original path follows that remote deletion.
3. The conflict copy remains part of future synchronization.
4. Use the right-side sync status view to open both files and mark the conflict as resolved after review.

### Scope and Filters

- By default, the entire vault is synchronized except for `.obsidian`.
- You may enable `.obsidian` synchronization. The plugin's own directory is always excluded so its database, credentials, and device state never enter the sync set.
- `.trash`, `.yunpan-sync`, operating-system metadata, and common temporary files are always excluded.
- Include or exclude paths and wildcards; rules are evaluated from top to bottom and the last match wins. The filter applies to both uploads and downloads.
- Each vault binds to one 360AI Cloud Disk folder, selected or created through the visual cloud directory picker.


- A 360AI Cloud Disk account and a network connection are required. The plugin itself does not charge a fee. Cloud storage, membership benefits, and renewal are provided by 360AI Cloud Disk and may be paid services; the renewal button opens the provider's website.
- To synchronize your vault, the plugin sends file paths, names, sizes, hashes, modification times, file contents, account `qid`, and the OAuth/access credentials required by those services. It does not send vault files to services other than the cloud folder you choose to bind.
- After sign-in, the settings page shows account details, membership status, expiration, and storage usage, with a renewal link.
- An expired Access Token is renewed with the existing OAuth Code instead of repeatedly opening browser authorization.

### Before You Sync

- Desktop, Android, and iOS support manual, automatic, and scheduled synchronization, with manual mode as the default. On mobile, automatic and scheduled synchronization run only while Obsidian is in the foreground; backgrounding or locking the device pauses and saves the queue, then resumes the selected mode when Obsidian returns to the foreground.
- Mobile OAuth login has passed real-device validation; see the [verification record](RELEASE.md#真实设备验证记录).
- Android and iOS request the mobile authorization page through MCP. Sign in to Yunpan, approve access, then return to Obsidian. Desktop keeps its existing authorization page.
- The initial run scans both local and cloud content and may take longer than later incremental runs for a large vault.
- Deletions propagate in both directions. Make sure changes from other devices have synchronized before deleting important content.
- Filtered files are neither uploaded nor downloaded, so the two sides may intentionally differ.
- Avoid having another application continuously rewrite the same files during synchronization. Failed tasks can be retried from the status view.
- This plugin is not the official Obsidian Sync service.
- This plugin is not published or endorsed by Obsidian. Cloud-side data processing is governed by the 360AI Cloud Disk terms and privacy policy.

---

## Development / 开发

```bash
npm install
npm test
npm run build
```

The production build generates `main.js`. A complete manual installation consists of:

- `main.js`
- `manifest.json`
- `styles.css`






## Public build / 公开版本

仅连接生产服务；不提供环境切换。使用 Node.js 22，执行 `npm ci --ignore-scripts`、`npm run verify`。标准安装文件为 `main.js`、`manifest.json` 和 `styles.css`。

See [Privacy](PRIVACY.md), [release checks and device verification](RELEASE.md), [MIT License](LICENSE), and [third-party notices](THIRD_PARTY_NOTICES.md). Real device production verification remains recorded separately in RELEASE.md.
