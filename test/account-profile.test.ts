import { describe, expect, it } from "vitest";
import {
  accountDisplayIdentity,
  formatStorageCapacity,
  maskMobile,
  normalizeAccountProfile,
} from "../src/account/profile.js";
import {
  hasActiveMembership,
  membershipDisplay,
  membershipIcon,
} from "../src/ui/account-membership.js";

describe("account profile", () => {
  it("normalizes account, membership, expiry, and storage fields", () => {
    expect(normalizeAccountProfile({
      nickName: "云盘用户",
      userName: "cloud-user",
      mobile: "13800000000",
      email: "user@example.com",
      is_vip: 1,
      vip_desc: "超级会员",
      vip_icon: "https://p5.ssl.qhimg.com/member/super.png",
      package_id: 210,
      expire: 1_800_000_000,
      used_size: "1024",
      total_size: "4096",
    }, "42")).toEqual({
      displayName: "云盘用户",
      qid: "42",
      nickname: undefined,
      username: "cloud-user",
      mobile: "13800000000",
      email: "user@example.com",
      isVip: true,
      vipLabel: "超级会员",
      membershipIconUrl: "https://p5.ssl.qhimg.com/member/super.png",
      packageId: "210",
      expiresAt: 1_800_000_000_000,
      usedBytes: 1024,
      totalBytes: 4096,
    });
  });

  it("falls back safely for a non-member account with partial fields", () => {
    expect(normalizeAccountProfile({ userName: "fallback-name", is_vip: false }, "7")).toMatchObject({
      displayName: "fallback-name",
      qid: "7",
      nickname: undefined,
      username: "fallback-name",
      isVip: false,
      vipLabel: "普通用户",
    });
  });

  it("uses nickname before the other identity fields", () => {
    expect(accountDisplayIdentity({
      displayName: "备用昵称", nickname: "真实昵称", username: "user-name",
      qid: "3475472618", mobile: "13800000000", email: "user@example.com",
    })).toBe("真实昵称");
  });

  it("falls back from the backend placeholder nickname to a masked mobile", () => {
    expect(maskMobile("13800000000")).toBe("138****0000");
    expect(accountDisplayIdentity({
      displayName: "云盘用户", nickname: "云盘用户", qid: "3475472618", mobile: "13800000000",
    })).toBe("138****0000");
  });

  it("uses email when nickname and mobile are unavailable", () => {
    expect(accountDisplayIdentity({
      displayName: "云盘用户", nickname: "云盘用户", qid: "3475472618",
      email: "user@example.com", username: "user-name",
    })).toBe("user@example.com");
  });

  it("uses username when nickname, mobile, and email are unavailable", () => {
    expect(accountDisplayIdentity({
      displayName: "云盘用户", nickname: "云盘用户", qid: "3475472618",
      username: "user-name",
    })).toBe("user-name");
  });

  it("uses a neutral account label rather than qid when all identity fields are unavailable", () => {
    expect(accountDisplayIdentity({
      displayName: "云盘用户", nickname: "云盘用户", username: "3475472618", qid: "3475472618",
    })).toBe("云盘用户");
  });

  it("places renewal on the membership status row and hides the package id", () => {
    const display = membershipDisplay({
      displayName: "云盘用户", qid: "42", isVip: true, vipLabel: "超级会员",
      packageId: "230", expiresAt: 2_027_548_800_000, usedBytes: 1024, totalBytes: 4096,
    });

    expect(display.status).toEqual({ label: "会员状态", value: "超级会员", renewal: true });
    expect(display.details.map((item) => item.label)).toEqual(["到期时间", "存储空间"]);
    expect(JSON.stringify(display)).not.toContain("套餐 ID");
    expect(JSON.stringify(display)).not.toContain("230");
  });

  it("formats account storage with the same compact GB and TB units as the web client", () => {
    expect(formatStorageCapacity(8.62 * 1024 ** 3)).toBe("8.62GB");
    expect(formatStorageCapacity(6 * 1024 ** 4)).toBe("6TB");
    expect(formatStorageCapacity(undefined)).toBe("未知");
  });

  it("treats an expired membership as a normal account", () => {
    expect(hasActiveMembership({
      displayName: "user", qid: "1", isVip: true, vipLabel: "超级会员", expiresAt: 1000,
    }, 2000)).toBe(false);
    expect(hasActiveMembership({
      displayName: "user", qid: "1", isVip: true, vipLabel: "超级会员", expiresAt: 3000,
    }, 2000)).toBe(true);
  });

  it("uses the membership icon selected by the backend for the account type", () => {
    const profile = normalizeAccountProfile({
      is_vip: 1,
      vip_desc: "专业会员",
      paymember_level_icon: "https://p4.ssl.qhimg.com/member/professional.png",
      vip_icon: "https://p5.ssl.qhimg.com/member/fallback.png",
    }, "42");

    expect(membershipIcon(profile, true)).toEqual({
      src: "https://p4.ssl.qhimg.com/member/professional.png",
      alt: "专业会员图标",
    });
    expect(membershipIcon(profile, false)).toBeUndefined();
  });

  it("falls back to the active web membership icons when the backend omits an icon", () => {
    const senior = membershipIcon({
      displayName: "user", qid: "1", isVip: true, vipLabel: "高级会员", packageId: "210",
    }, true);
    const professional = membershipIcon({
      displayName: "user", qid: "1", isVip: true, vipLabel: "专业会员", packageId: "220",
    }, true);
    const superVip = membershipIcon({
      displayName: "user", qid: "1", isVip: true, vipLabel: "超级会员", packageId: "230",
    }, true);

    expect(senior?.src).toMatch(/^data:image\/png;base64,/);
    expect(senior?.alt).toBe("高级会员图标");
    expect(professional?.src).toMatch(/^data:image\/png;base64,/);
    expect(superVip?.src).toMatch(/^data:image\/png;base64,/);
    expect(new Set([senior?.src, professional?.src, superVip?.src]).size).toBe(3);
    expect(membershipIcon({
      displayName: "user", qid: "1", isVip: true, vipLabel: "超级会员", packageId: "legacy",
    }, true)?.src).toBe(superVip?.src);
    expect(membershipIcon({
      displayName: "user", qid: "1", isVip: true, vipLabel: "会员", packageId: "unknown",
    }, true)).toBeUndefined();
  });

  it("accepts only trusted HTTPS membership icon URLs", () => {
    for (const icon of [
      "http://p5.ssl.qhimg.com/member.png",
      "data:image/svg+xml,<svg></svg>",
      "https://attacker.example/member.png",
      "not-a-url",
    ]) {
      const profile = normalizeAccountProfile({ is_vip: 1, vip_icon: icon }, "42");
      expect(membershipIcon(profile, true)).toBeUndefined();
    }
  });
});
