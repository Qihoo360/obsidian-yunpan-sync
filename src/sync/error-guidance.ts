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

export function classifySyncError(error: unknown): SyncErrorGuidance {
  const detail = error instanceof Error ? error.message : String(error);
  const value = detail.toLowerCase();
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
  if (rawDetail) return { category: "unknown", title: "同步失败", detail: `具体原因：${rawDetail}` };
  return {
    category: "unknown",
    title: "同步失败",
    detail: "同步过程中出现错误，请稍后重试。若问题持续出现，请稍后重试或检查同步状态。",
  };
}
