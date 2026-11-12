import { OpenApiError } from "../net/openapi-client.js";
import { WindowsPathError } from "../domain/paths.js";
import { syncRestrictionError } from "./quota.js";

export type SyncErrorCategory = "network" | "space" | "membership" | "cloud-capacity" | "quota-unknown" | "permission" | "occupied" | "authentication" | "destination" | "windows-path" | "unknown";

export interface SyncErrorGuidance {
  category: SyncErrorCategory;
  title: string;
  detail: string;
}

function safeRawErrorDetail(value: string): string | undefined {
  // Some call sites persist an already user-facing detail and the classifier
  // adds the label again. Strip any existing labels before adding one below.
  const trimmed = value.trim().replace(/^(?:具体原因\s*[：:]\s*)+/u, "").trim();
  if (!trimmed || trimmed === "Error" || trimmed === "[object Object]") return undefined;
  // Error messages can occasionally contain a request URL. Keep the useful
  // server/client detail while preventing credentials from appearing in the UI.
  const sanitized = trimmed
    .replace(/([?&](?:access_token|oauth_code|token|cloud_token|sign)=)[^&\s]+/gi, "$1***")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1***");
  return sanitized || undefined;
}

function isInternalDirectoryCleanupError(value: string): boolean {
  return /(?:eisdir|enotdir|path is a directory|not a directory|is a directory|rm returned)/i.test(value);
}

export function classifySyncError(error: unknown): SyncErrorGuidance {
  const raw = error instanceof Error ? error.message : String(error);
  const errno = error instanceof OpenApiError ? error.errno : (raw.match(/\(errno: (-?\d+)\)/)?.[1] ?? raw.match(/错误码 (-?\d+)/)?.[1]);
  const trace = error instanceof OpenApiError ? error.traceId : (raw.match(/\(trace_id: ([\w.:-]+)\)/)?.[1] ?? raw.match(/追踪编号 ([\w.:-]+)/)?.[1]);
  let guidance: SyncErrorGuidance;
  if (Number(errno) === 3028) guidance = { category: "unknown", title: "文件内容不符合云端规则", detail: "云端判定文件包含违规内容，无法上传。请确认文件内容后再重试。" };
  else if (Number(errno) === 3128) guidance = { category: "unknown", title: "文件受到服务端限制", detail: "云端因法律法规或服务规则限制了该文件操作，无法上传。请更换文件或联系云盘支持。" };
  else guidance = classifyError(error);
  // Persisted failures contain the backend references in their message. Remove
  // those machine-formatted copies before adding one readable Chinese suffix.
  guidance.detail = guidance.detail
    .replace(/\s*\(errno:\s*-?\d+\)/gi, "")
    .replace(/\s*\(trace_id:\s*[\w.:-]+\)/gi, "")
    .replace(/\s*[（(]错误码\s*-?\d+，?\s*追踪编号\s*[\w.:-]+[）)]/gu, "")
    .trim();
  const references = [errno === undefined || guidance.detail.includes(`错误码 ${errno}`) ? "" : `错误码 ${errno}`,
    !trace || guidance.detail.includes(`追踪编号 ${trace}`) ? "" : `追踪编号 ${trace}`].filter(Boolean);
  const path = raw.match(/^读取云端目录失败：(.+?)。/u)?.[1];
  if (path && !guidance.detail.includes(path)) guidance.detail += ` 路径及操作：${path}。`;
  if (references.length) guidance.detail += `（${references.join("，")}）`;
  return guidance;
}

function classifyError(error: unknown): SyncErrorGuidance {
  const detail = error instanceof Error ? error.message : String(error);
  const value = detail.toLowerCase();
  if (/download cache recovery failed|downloadcacheerror/.test(value) || detail === "同步失败，请点击重试。") return {
    category: "unknown", title: "同步失败", detail: "同步失败，请点击重试。",
  };
  if (detail.startsWith("同步请求未成功")) return { category: "unknown", title: "同步失败", detail };
  if (/request\s+frequently|too many requests|请求频繁/.test(value)) return {
    category: "network", title: "云端请求频繁", detail: "云端请求频繁，正在等待后自动重试。",
  };
  if (/interrupted by shutdown|同步已停止|同步已暂停/.test(value)) return {
    category: "unknown", title: "同步已暂停", detail: "同步已暂停，恢复后将继续未完成的任务。",
  };
  const waiting = value.match(/(\d+)\s+sync tasks? (?:is|are) still queued/);
  if (waiting) return { category: "unknown", title: "仍有任务待处理", detail: `还有 ${waiting[1]} 个任务待处理，请查看任务状态。` };
  if (/父节点不存在|parent.*(?:not exist|not found)/.test(value)) return {
    category: "destination", title: "云端父目录不存在", detail: "云端父目录不存在，请重新检测目录后重试。",
  };
  const restriction = syncRestrictionError(error);
  if (restriction) return { category: restriction.kind === "membership" ? "membership" : restriction.kind === "capacity" ? "cloud-capacity" : "quota-unknown",
    title: restriction.kind === "membership" ? "会员已过期" : restriction.kind === "capacity" ? "套餐容量不足" : "无法确认同步容量",
    detail: restriction.message };
  if (/无法确认.*容量/.test(detail)) return { category: "quota-unknown", title: "无法确认同步容量", detail };
  if ((error instanceof OpenApiError && error.errno === 3009) || /dest(?:ination)? node not exist|目标(?:云端)?文件夹不存在/.test(value)) {
    return { category: "destination", title: "目标云端文件夹不存在", detail: "目标云端文件夹不存在，请确认目标文件夹后重试。" };
  }
  if (error instanceof WindowsPathError) {
    if (error.issue === "invalid-character") {
      if (!error.characters.length) return { category: "windows-path", title: "文件名不合法", detail: error.message };
      const characters = error.characters.join(" ");
      return { category: "windows-path", title: "文件名不兼容 Windows",
        detail: `文件名包含 Windows 不支持的字符：${characters}` };
    }
    if (error.issue === "emoji") {
      const emoji = error.characters.join(" ");
      return { category: "windows-path", title: "文件名不兼容 Windows",
        detail: emoji ? `文件名不能包含 emoji：${emoji}` : "文件名不能包含 emoji 表情符号，请重命名后再同步。" };
    }
    if (error.issue === "reserved-name") return { category: "windows-path", title: "文件名不兼容 Windows",
      detail: `Windows 不支持保留设备名：${error.segment}` };
    if (error.issue === "trailing-space-or-dot") return { category: "windows-path", title: "文件名不兼容 Windows",
      detail: "文件名不能以空格或句点结尾。" };
    if (error.issue === "segment-too-long") return { category: "windows-path", title: "文件名不兼容 Windows",
      detail: error.message.includes("字节") ? "文件名超过文件系统支持的 255 字节，请缩短名称后重试。" : "Windows 路径段超过 255 个字符。" };
  }
  if (/enametoolong|file ?name too long|路径过长|文件名过长/.test(value)) return {
    category: "windows-path", title: "文件名或路径过长", detail: "请缩短云端文件或父目录名称，再点击重试重新检测。",
  };
  if ((error instanceof Error && error.name === "WindowsPathError") ||
      /远端路径不兼容 windows|windows 不支持|保留设备名|文件名不能以空格或句点结尾|路径段超过 255/.test(value)) {
    const invalid = detail.match(/文件名包含 Windows 不支持的字符[：:](.+)$/u);
    return { category: "windows-path", title: "文件名不兼容 Windows",
      detail: invalid ? `文件名包含 Windows 不支持的字符：${invalid[1]}` : "云端路径包含 Windows 不支持的文件名，请重命名后再同步。" };
  }
  if (/enospc|no space|空间不足|容量不足|quota/.test(value)) {
    return { category: "space", title: "本地存储空间不足", detail: "本地磁盘空间不足，请清理设备存储后重试。" };
  }
  if (/eacces|eperm|permission|forbidden|http 403|无权限|权限不足/.test(value)) {
    return { category: "permission", title: "文件或云端权限不足", detail: "无法读写相关文件，请检查文件权限后重试。" };
  }
  if (/ebusy|eagain|being used|in use|文件占用|正在使用|被占用|local rename destination already exists|本地重命名目标已存在/.test(value)) {
    return { category: "occupied", title: "文件正在被占用", detail: "文件正在被其他程序使用，请关闭占用程序后重试。" };
  }
  if (isInternalDirectoryCleanupError(value)) {
    return {
      category: "unknown", title: "同步失败",
      detail: "同步失败，请点击重试。",
    };
  }
  if (/oauth|access.?token|unauthorized|http 401|登录|授权/.test(value)) {
    return { category: "authentication", title: "登录授权已失效", detail: "登录状态已失效，请重新登录 360AI 云盘。" };
  }
  if (/network|timeout|timed out|offline|econn|dns|http 429|http 5\d\d|网络/.test(value)) {
    return { category: "network", title: "网络连接异常", detail: "网络连接异常，请检查网络后重试。" };
  }
  const failedTasks = value.match(/(\d+)\s+sync (?:tasks?|files?) failed/);
  if (failedTasks) return {
    category: "unknown",
    title: "部分文件同步失败",
    detail: `有 ${failedTasks[1]} 个文件同步失败，请检查失败文件后重试。`,
  };
  if (/hash verification failed|checksum|校验失败/.test(value)) return {
    category: "unknown",
    title: "文件校验失败",
    detail: "文件传输后校验失败，请重新同步该文件。",
  };
  if (/case-insensitive path collision/.test(value)) return {
    category: "unknown",
    title: "存在同名文件",
    detail: "同一目录中存在仅大小写不同的同名文件，请重命名后再同步。",
  };
  const rawDetail = safeRawErrorDetail(detail);
  if (rawDetail) {
    if (/local file (?:changed|appeared|disappeared)/i.test(rawDetail)) return {
      category: "unknown", title: "本地文件已变化", detail: "同步期间本地文件发生变化，已保留文件，请重新检测后重试。",
    };
    if (/invalid.*(?:file ?name|metadata|response)|无效的文件名/i.test(rawDetail)) return {
      category: "unknown", title: "文件名或云端数据无效", detail: /无效的文件名|file ?name/i.test(rawDetail)
        ? "文件名无效，请重命名对应文件或目录后重试。" : "云端返回的数据不完整，请重新检测后重试。",
    };
    const codes = error instanceof OpenApiError ? [error.errno !== undefined ? `错误码 ${error.errno}` : "", error.traceId ? `追踪编号 ${error.traceId}` : ""].filter(Boolean).join("，") : "";
    return { category: "unknown", title: "同步失败", detail: /[\u3400-\u9fff]/u.test(rawDetail)
      ? `具体原因：${rawDetail}` : `同步请求未成功，请稍后重试${codes ? `（${codes}）` : "。"}` };
  }
  return {
    category: "unknown",
    title: "同步失败",
    detail: "同步过程中出现错误，请稍后重试。若问题持续出现，请稍后重试或检查同步状态。",
  };
}
