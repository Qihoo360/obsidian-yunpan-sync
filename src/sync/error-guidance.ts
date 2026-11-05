import { OpenApiError } from "../net/openapi-client.js";
import { WindowsPathError } from "../domain/paths.js";

export type SyncErrorCategory = "network" | "space" | "permission" | "occupied" | "authentication" | "destination" | "windows-path" | "unknown";

export interface SyncErrorGuidance {
  category: SyncErrorCategory;
  title: string;
  detail: string;
}

export function classifySyncError(error: unknown): SyncErrorGuidance {
  const detail = error instanceof Error ? error.message : String(error);
  const value = detail.toLowerCase();
  if ((error instanceof OpenApiError && error.errno === 3009) || /dest(?:ination)? node not exist|目标(?:云端)?文件夹不存在/.test(value)) {
    return { category: "destination", title: "目标云端文件夹不存在", detail: "目标云端文件夹不存在，请确认目标文件夹后重试。" };
  }
  if (error instanceof WindowsPathError) {
    if (error.issue === "invalid-character") {
      const characters = error.characters.length > 0 ? error.characters.join(" ") : "未知";
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
      detail: "Windows 路径段超过 255 个字符。" };
  }
  if ((error instanceof Error && error.name === "WindowsPathError") ||
      /远端路径不兼容 windows|windows 不支持|保留设备名|文件名不能以空格或句点结尾|路径段超过 255/.test(value)) {
    const invalid = detail.match(/文件名包含 Windows 不支持的字符[：:](.+)$/u);
    return { category: "windows-path", title: "文件名不兼容 Windows",
      detail: invalid ? `文件名包含 Windows 不支持的字符：${invalid[1]}` : "云端路径包含 Windows 不支持的文件名，请重命名后再同步。" };
  }
  if (/enospc|no space|空间不足|容量不足|quota/.test(value)) {
    return { category: "space", title: "存储空间不足", detail: "存储空间不足，请清理不需要的文件或扩容后重试。" };
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
  if (/[\u3400-\u9fff]/u.test(detail)) return { category: "unknown", title: "同步失败", detail };
  return {
    category: "unknown",
    title: "同步失败",
    detail: "同步过程中出现错误，请稍后重试。若问题持续出现，请稍后重试或检查同步状态。",
  };
}
