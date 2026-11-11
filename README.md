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
- **会员状态刷新**：每次进入云盘设置页拉取最新个人信息；会员过期时可点击刷新图标，续费生效后更新显示并清除过期提示。刷新失败保留上次信息，可再次重试。
- **冲突内容不会静默覆盖**：两端同时修改时保留本地冲突副本，再应用云端版本。
- **大文件传输可恢复**：支持分块上传、缺失块补传、哈希校验和持久任务队列。
- **登录状态自动续期**：Access Token 失效后使用已保存的 OAuth Code 自动获取新 Token；只有 OAuth Code 也失效时才要求重新登录。

### 快速开始

需要 Obsidian **1.11.4 或更高版本**（Desktop、Android、iOS）。市场提示 `No appropriate version found.` 时，请检查 Obsidian 版本并升级；插件获准加载后也会对低版本显示“版本过低，请先升级 obsidian”。

1. 将 `main.js`、`manifest.json` 和 `styles.css` 放入 Vault 的 `.obsidian/plugins/yunpan-sync/` 目录。
2. 在 Obsidian 的 **设置 → 第三方插件** 中启用 **360AI Cloud Sync**。
3. 打开插件设置，点击 **登录**，在浏览器中完成 360AI 云盘授权。
4. 在云端目录选择器中选择已有文件夹，或创建一个新文件夹作为当前 Vault 的同步目录。
5. 新安装默认使用 **自动** 模式；也可以点击左侧功能区的同步图标，或从命令面板运行 **360AI Cloud Sync: 立即同步**。
6. 自动模式会主动检测并弹出首次同步任务列表；弹窗显示后倒计时 10 秒，超时按当前勾选项继续，也可立即继续或取消。取消后本次打开 Obsidian 期间不再自动弹出，可点击“立即同步”重新确认。

移动端进入设置页会先显示“准备登录…”，准备好后点击“登录”直接打开授权链接。若浏览器未打开，仍可使用“打开授权页面”或复制授权链接；准备失败时点击“重试准备”。

> [!IMPORTANT]
> 首次同步前请备份 Vault。双向同步会传播删除操作；如果同一路径在两端都有不同内容，插件会保留冲突副本，但备份仍是最稳妥的恢复方式。

### 同步模式

| 模式 | 行为 | 适合场景 |
| --- | --- | --- |
| **手动** | 只在点击“立即同步”或运行命令时同步 | 按需同步 |
| **自动**（新安装默认） | 本地变化后防抖约 1.5 秒触发同步，同时约每 3 分钟检查云端变化 | 多设备持续同步 |
| **低频自动** | 按设置的分钟间隔执行完整同步，可设 4–1440 分钟，默认 30 分钟 | 希望降低后台请求频率 |

所有模式都保留 **立即同步** 命令。你也可以随时暂停或恢复同步。

### 同步过程与恢复

- **远端索引**：首次及后续检测只读取绑定云端目录及其子目录的元数据，每页 200 项、顺序分页，不遍历账号其他目录，不下载文件内容。后续先检查轻量账号版本，版本未变化时复用绑定目录索引；版本变化时只重新读取绑定目录。分页前后校验版本，完整读取后原子切换，失败或停止保留上次完整索引；升级时保留同步基线、任务和上传恢复信息。
- **任务预览**：首次同步展示上传、下载、新建目录、删除、重命名和移动等计划任务，每页 100 条；搜索防抖 150ms，跨页保留勾选，“全选”覆盖全部搜索结果。首次确认弹窗倒计时 10 秒后自动按当前勾选项执行（包括勾选的删除操作），点击取消可停止。
- **传输进度**：同步弹窗、状态栏和右侧面板统一显示本轮全部上传、下载的总进度；百分比独立显示，等待、同步中、失败和完成具有明确文字与图标。同步中文件优先，已完成文件放到底部折叠区，两区各自分页；切换文件不重置同步图标动画。
- **失败重试**：可重试单个失败文件或全部失败任务；持久任务会在插件重新启动后恢复。
- **过滤规则**：可按文件名、目录或通配符包含或排除内容，支持启停、调整顺序和区分大小写；规则按列表从上到下匹配，最后命中的规则生效，同时作用于上传、下载和本地变更监听。
- **完整性校验**：上传和下载使用文件哈希及分块哈希校验，下载完成后再替换目标文件。
- **同步状态**：状态栏展示当前阶段，内容无变化时会明确提示“本地与云端已是最新”。
- **响应与阶段**：本地扫描、索引处理和任务生成按最多 100 项或约 8ms 让出主线程；展示云端请求、索引处理、本地扫描、任务生成、传输、校验和保存阶段，以及绑定目录已读取/比较项数、本地当前路径和已处理字节。界面更新合并为最多每 200ms 一次，完成、停止及错误立即刷新。本地数据库仅保留最近一次运行的阶段耗时、数量和最长处理批次，不保存文件内容或认证 URL。
- **桌面大文件**：哈希与上传按 512 KiB 分块读取，下载范围请求每次最多 1 MiB，逐块写入临时文件并校验后再替换目标；处理中本地文件变化会中止该任务。上传最多 5 个文件并发，下载、索引请求和结构操作各 1 个；上传会话可恢复，下载失败后从头重试。

### 冲突处理

当本地和云端从同一同步基线开始都发生变化时，插件不会静默覆盖本地内容：

1. 本地版本会被保存为 `文件名 (conflict-设备名-时间).扩展名`。
2. 云端版本会写回原路径；如果云端已经删除该文件，则原路径会按云端状态删除。
3. 冲突副本会继续参与后续同步。
4. 可在右侧同步状态面板中打开原文件和冲突副本，并在检查后标记为已处理。

### 文件范围与过滤

- 默认同步当前 Vault 中除 `.obsidian` 以外、符合过滤规则和大小范围的文件和文件夹。
- PC 和手机默认单文件大小范围为 **0–30 MB**，1 MB = 1024² 字节，包含边界。设置中可修改上下限，输入 0–500 的整数，且下限必须小于上限；输入框失焦后自动保存。大小未知或不在范围内的文件会在状态面板中说明跳过原因，不读取内容，不删除两端原文件或同步基线；包含排除内容的目录不会被递归删除或移动。
- 手机默认排除工程/建模文件、音视频、压缩包和安装包；**Office、PDF、笔记和图片保留**，仍受大小范围及自定义规则限制。这些手机默认规则在升级时补充一次，原有规则优先；以后关闭或删除默认规则不会再次补回。PC 的默认格式规则不变。
- 移动端同步跟随 Obsidian 的在线/离线事件，前台运行，切到后台暂停；插件不配置或判断 Wi-Fi/蜂窝网络类型，因为 Obsidian 移动端没有向第三方插件提供可靠的网络传输类型接口。
- 网络限制覆盖同步元数据、传输、请求重试及同步触发的凭据续期，不限制用户主动登录和查看账号。切换到不允许的网络后不发起新的同步请求；Obsidian 已发出的请求无法可靠取消，可能仍产生少量尾部流量。
- 可选择同步 `.obsidian` 配置目录；插件自身目录始终排除，避免同步本地数据库、凭据和设备状态。
- `.trash`、`.yunpan-sync`、系统文件和常见临时文件始终排除。
- 可按路径和通配符设置“排除”或“包含”规则，例如排除 `Private/**` 后包含 `Private/keep/**`；规则同时作用于上传和下载。
- 每个 Vault 绑定一个独立的 360AI 云盘目录，可在可视化目录选择器中选择或新建目录。


- 使用本插件必须拥有 360AI 云盘账号并连接网络。插件本身不收费；云盘容量、会员权益与续费由 360AI 云盘提供并可能产生费用，设置页的续费按钮会打开云盘网页。
- 为完成同步，插件会向上述服务发送文件路径、名称、大小、哈希、修改时间、文件内容，以及账号 `qid` 和必要的 OAuth/访问凭据。除用户选择绑定的云端目录外，插件不会把 Vault 文件发送给其他服务。
- 登录后在设置页展示账号、手机号或邮箱、会员状态、到期时间和存储空间，并提供续费入口。
- Access Token 失效时自动使用原 OAuth Code 续期，不会频繁打开浏览器要求重新授权。

### 使用前须知

- Desktop、Android 和 iOS 均支持手动、自动和低频自动同步，新安装默认自动，升级保留已有有效模式。自动同步需完成登录、目录绑定及首次任务确认。移动端自动同步和低频自动仅在 Obsidian 前台运行，离开前台或锁屏后会暂停并保存任务；回到 Obsidian 后会继续按所选模式工作。
- 历史版本移动端 OAuth 的真实设备验证见 [验证记录](RELEASE.md#真实设备验证记录)；各版本新增改动的验证状态见发布说明。
- Android 和 iOS 登录通过 MCP 选择移动授权页；桌面端使用桌面授权页并在 HTTPS 完成页返回 Obsidian。两端均使用 PKCE 和协议回跳。
- 同步前刷新会员与容量信息。会员过期、上传预计新增占用超过剩余容量，或无法可靠获取上传容量时暂停本次同步并保留任务；续费或扩容后可重试。
- 首次同步需要扫描本地与云端；文件较多时会比后续增量同步耗时更长。
- 桌面端大文件使用分块读写。Android 和 iOS 本次仍通过适配器整文件读写，处理大视频、图片时依然受设备可用内存限制。
- 删除会双向传播。删除前请确认其他设备上的修改已经完成同步。
- 被过滤的文件不会上传，也不会从云端下载，因此两端可能有意保持不同。
- 云端文件或父目录改名后，可点击失败文件的“重新检测”或“重试失败任务”。重试重新读取云端元数据，按节点身份更新任务，不继续使用旧名称；不会自动截断或替换非法名称。扫描阶段的文件名错误也支持重试。
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
5. New installations default to **Automatic** mode. You can also click the sync ribbon icon or run **360AI Cloud Sync: Sync now** from the command palette.
6. Review the planned tasks and continue when they look correct.

On mobile, wait for sign-in preparation to finish, then tap **登录** to open the authorization link directly. If the browser does not open, use **打开授权页面** or copy the link. If preparation fails, tap **重试准备** to retry.

> [!IMPORTANT]
> Back up your vault before the first sync. Two-way sync propagates deletions. The plugin preserves a conflict copy when both sides contain different content at the same path, but a backup remains the safest recovery option.

### Sync Modes

| Mode | Behavior | Best for |
| --- | --- | --- |
| **Manual** | Sync only when you click **Sync now** or run the command | On-demand sync |
| **Automatic** (default for new installations) | Sync local changes after about 1.5 seconds of debounce and check remote changes about every 3 minutes | Continuous multi-device sync |
| **Scheduled** | Run a full sync every 4–1440 minutes as configured; defaults to 30 minutes | Reducing background request frequency |

The **Sync now** command remains available in every mode. Synchronization can also be paused and resumed at any time.

### Progress and Recovery

- **Remote index**: Build account-wide metadata before filtering the bound folder. Full and incremental requests read sequential pages of 200 nodes; detection never downloads file contents. Publish the index and cursor atomically, retain the previous complete index on failure or cancellation, and rebuild when a cursor expires.
- **Task review**: Preview planned operations in pages of 100. Search uses a 150ms debounce; selection persists across pages and select-all covers every search result.
- **Transfer progress**: The dialog, status bar, and sidebar share overall progress across all uploads and downloads. Percentages remain fully visible, and file states use explicit text and icons. Active files come first; completed files move into a collapsed history section with separate pagination. Switching files does not restart the sync icon animation.
- **Retry and resume**: Retry one failed file or all failed tasks; persistent tasks recover after the plugin restarts.
- **Integrity checks**: Verify whole-file and block hashes during transfer, and replace a downloaded target only after validation succeeds.
- **Clear outcomes**: The status bar reports the current phase and explicitly says when local and cloud content are already up to date.
- **Responsive processing**: Scanning, indexing, and planning yield after at most 100 items or about 8ms. Progress distinguishes cloud requests, index processing, local scanning, planning, transfer, verification, and saving. It reports account-wide and bound-folder counts, the current local path, and processed bytes. UI refreshes are coalesced to at most once per 200ms, with immediate final, stopped, and error updates. The local database retains only the latest run's phase timings, counts, and longest processing batch, without content or authenticated URLs.
- **Desktop large files**: Hashing and upload read 512 KiB blocks. Download ranges are capped at 1 MiB and written to a temporary file, then verified before replacing the target. Local changes during processing stop the task. Uploads run up to five files at once; downloads, index requests, and structural operations run one at a time. Upload sessions resume; failed downloads restart from the beginning.

### Conflict Handling

When both local and remote content have changed since the same baseline, the plugin does not silently overwrite the local version:

1. The local version is saved as `name (conflict-device-timestamp).ext`.
2. The cloud version is written to the original path. If the cloud copy was deleted, the original path follows that remote deletion.
3. The conflict copy remains part of future synchronization.
4. Use the right-side sync status view to open both files and mark the conflict as resolved after review.

### Scope and Filters

- By default, vault files outside `.obsidian` participate when their paths and sizes satisfy the sync rules.
- Desktop and mobile use an inclusive **0–30 MB** per-file range by default (1 MB = 1024² bytes). Both limits accept integers from 0 to 500, and the minimum must be smaller than the maximum; values save when the input loses focus. Unknown or excluded sizes are skipped without deleting either copy or its baseline. Directories containing excluded content are protected from recursive deletion and moves.
- Mobile adds editable exclusions for engineering/modeling files, audio/video, archives and installers once on upgrade. **Office, PDF, notes and images remain included**, subject to size limits and custom rules. Existing custom rules retain priority; removed defaults are not re-added. Desktop format defaults stay unchanged.
- Mobile synchronization follows Obsidian online/offline events, runs in the foreground, and pauses in the background. The plugin does not configure or infer Wi-Fi versus cellular because Obsidian mobile does not expose a reliable transport-type API to third-party plugins.
- Retrying a filename error refreshes remote metadata and resolves tasks by stable node identity, including parent renames and moves. Scan-only errors also have a retry action. Invalid names are never truncated or replaced automatically.
- You may enable `.obsidian` synchronization. The plugin's own directory is always excluded so its database, credentials, and device state never enter the sync set.
- `.trash`, `.yunpan-sync`, operating-system metadata, and common temporary files are always excluded.
- Include or exclude paths and wildcards; rules are evaluated from top to bottom and the last match wins. The filter applies to both uploads and downloads.
- Each vault binds to one 360AI Cloud Disk folder, selected or created through the visual cloud directory picker.


- A 360AI Cloud Disk account and a network connection are required. The plugin itself does not charge a fee. Cloud storage, membership benefits, and renewal are provided by 360AI Cloud Disk and may be paid services; the renewal button opens the provider's website.
- To synchronize your vault, the plugin sends file paths, names, sizes, hashes, modification times, file contents, account `qid`, and the OAuth/access credentials required by those services. It does not send vault files to services other than the cloud folder you choose to bind.
- After sign-in, the settings page shows account details, membership status, expiration, and storage usage, with a renewal link.
- An expired Access Token is renewed with the existing OAuth Code instead of repeatedly opening browser authorization.

### Before You Sync

- Desktop, Android, and iOS support manual, automatic, and scheduled synchronization. New installations default to automatic mode; upgrades preserve a saved valid mode. Automatic mode starts initial detection and opens a task preview after sign-in. The initial preview automatically confirms the current selection after 10 seconds, including selected deletions; cancel to stop. Cancellation suppresses automatic prompts for that binding until Obsidian is reopened; manual sync can reopen the preview. On mobile, automatic and scheduled synchronization run only while Obsidian is in the foreground; backgrounding or locking the device pauses and saves the queue, then resumes the selected mode when Obsidian returns to the foreground.
- Historical mobile OAuth device validation is documented in the [verification record](RELEASE.md#真实设备验证记录); see the release notes for validation of newer changes.
- Android and iOS request the mobile authorization page through MCP. Desktop uses the desktop authorization page and an HTTPS completion page. Both return through the Obsidian protocol with PKCE protection.
- Every sync refreshes membership and quota information. Expired membership, insufficient remaining storage, or unreliable upload quota information pauses the run without discarding tasks; retry after renewal or expansion.
- The initial run scans both local and cloud content and may take longer than later incremental runs for a large vault.
- Desktop uses chunked file IO. Android and iOS still use whole-file adapter reads and writes in this update, so large videos and images remain limited by available device memory.
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
