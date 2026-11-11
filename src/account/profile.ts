export interface AccountProfile {
  displayName: string;
  qid: string;
  nickname?: string;
  username?: string;
  mobile?: string;
  email?: string;
  isVip: boolean;
  vipLabel: string;
  membershipIconUrl?: string;
  packageId?: string;
  expiresAt?: number;
  usedBytes?: number;
  totalBytes?: number;
  availableBytes?: number;
  enterpriseUsedBytes?: number;
  enterpriseTotalBytes?: number;
  enterpriseAvailableBytes?: number;
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function epochMilliseconds(value: unknown): number | undefined {
  const result = nonNegativeNumber(value);
  if (!result) return undefined;
  return result > 1_000_000_000_000 ? result : result * 1000;
}

function truthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function usableIdentity(value: unknown, qid: string): string | undefined {
  const result = text(value);
  return result && result !== qid && result !== "云盘用户" ? result : undefined;
}

export function normalizeAccountProfile(data: Record<string, unknown>, qid: string): AccountProfile {
  const displayName = text(data.name) ?? text(data.nickName) ?? text(data.nickname)
    ?? text(data.userName) ?? text(data.username) ?? qid;
  const nickname = usableIdentity(data.nickName, qid)
    ?? usableIdentity(data.nickname, qid)
    ?? usableIdentity(data.name, qid);
  const username = usableIdentity(data.userName, qid) ?? usableIdentity(data.username, qid);
  const isVip = truthyFlag(data.is_vip);
  const usedBytes = nonNegativeNumber(data.used_size);
  const totalBytes = nonNegativeNumber(data.total_size);
  const availableBytes = nonNegativeNumber(data.available_size);
  const enterprise = data.enterprise && typeof data.enterprise === "object"
    ? data.enterprise as Record<string, unknown> : undefined;
  const enterpriseUsedBytes = nonNegativeNumber(enterprise?.used_size) ?? nonNegativeNumber(data.e_used_size);
  const enterpriseTotalBytes = nonNegativeNumber(enterprise?.total_size) ?? nonNegativeNumber(data.e_total_size);
  const enterpriseAvailableBytes = nonNegativeNumber(enterprise?.available_size) ?? nonNegativeNumber(data.e_available_size);
  return {
    displayName,
    qid,
    nickname,
    username,
    mobile: text(data.mobile),
    email: text(data.email),
    isVip,
    vipLabel: isVip ? text(data.vip_desc) ?? "会员" : "普通用户",
    membershipIconUrl: text(data.paymember_level_icon) ?? text(data.vip_icon) ?? text(data.headimage),
    packageId: text(data.package_id),
    expiresAt: epochMilliseconds(data.expire),
    usedBytes,
    totalBytes,
    ...(availableBytes === undefined ? {} : { availableBytes }),
    ...(enterpriseUsedBytes === undefined ? {} : { enterpriseUsedBytes }),
    ...(enterpriseTotalBytes === undefined ? {} : { enterpriseTotalBytes }),
    ...(enterpriseAvailableBytes === undefined ? {} : { enterpriseAvailableBytes }),
  };
}

export function maskMobile(mobile: string): string {
  const value = mobile.trim();
  if (value.length <= 4) return "****";
  if (value.length <= 7) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

export function accountDisplayIdentity(
  profile: Pick<AccountProfile, "displayName" | "mobile" | "email" | "qid">
    & Partial<Pick<AccountProfile, "nickname" | "username">>,
): string {
  const nickname = usableIdentity(profile.nickname, profile.qid)
    ?? (profile.nickname === undefined && profile.username === undefined
      ? usableIdentity(profile.displayName, profile.qid)
      : undefined);
  if (nickname) return nickname;
  const mobile = text(profile.mobile);
  if (mobile) return maskMobile(mobile);
  const email = text(profile.email);
  if (email) return email;
  const username = usableIdentity(profile.username, profile.qid);
  if (username) return username;
  return "云盘用户";
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${Number(value.toFixed(unit === 0 ? 0 : 2))}${units[unit]}`;
}

export function formatStorageCapacity(bytes: number | undefined): string {
  return formatBytes(bytes);
}
