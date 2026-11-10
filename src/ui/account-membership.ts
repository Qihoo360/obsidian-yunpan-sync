import { formatStorageCapacity, type AccountProfile } from "../account/profile.js";

export interface MembershipDisplayRow {
  label: string;
  value: string;
}

export interface MembershipDisplay {
  status: MembershipDisplayRow & { renewal: true };
  details: MembershipDisplayRow[];
}

export interface MembershipIcon {
  src: string;
  alt: string;
}

const TRUSTED_ICON_HOST_SUFFIXES = [".qhimg.com", ".qhmsg.com", ".yunpan.com", ".yunpan.360.cn"];
const WEB_MEMBERSHIP_ICONS: Readonly<Record<string, string>> = {
  "210": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAeGVYSWZNTQAqAAAACAAEARoABQAAAAEAAAA+ARsABQAAAAEAAABGASgAAwAAAAEAAgAAh2kABAAAAAEAAABOAAAAAAAAAJAAAAABAAAAkAAAAAEAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAFKADAAQAAAABAAAAFAAAAABgUEhcAAAACXBIWXMAABYlAAAWJQFJUiTwAAAD1ElEQVQ4Ec2SbUxbZRTH/8/tvW1HByuwdmCHVohsk20xpZYNFccgyyAmouJeYnQL6Ie5EJag08Q5pyb6ZX7RhckS4weSgXYOp44FB6NsNY6JBNSwbOg2UHkZm7CWpr2vj89zC4Zl6kfjyc099zk5z+/8z7kH+L8bWSiQUrpINfC8JOBuGJoBsAeUp1B2Zrk8xGNmnICQnzEZayY5OXGexE1Murm3ob092PVRw8X+LgiCYLIoB1LzPeeTZ93QsdZfisKS6nx2+6V5zl9AhdJ1V37o3NXyQT0SCZkVN3lzUJNl3mFsUzP334fbYbeS3XSmt5U4i/p4gglkrYq6PLOvu+29FFmWIVqtXBJhd7g405JKk+dkiEJWVHSeOGJPtU28wRhVhBA9qVBXHh8IBzcPnD8Ni2SFpqmEGgzBbhKBsPZFU5XB5qepOguyh7VgEUX89OMQvB6xUrsZqmCVvxIZOS124/Kr3Z83WjRNh3uZF5ueboAgWk3YyKU+dH/RxP6FAZvdgYqtL8K9PA/TE6NoDx6CokRxvveikGl3vjn25V1nRGh/vNAXavUPDw1AsoqYGhuh8dkpUr61wWzVYbPg1CeHaZbHQ57d/RYKijfDiM/i8Dt1iEWjrLCAsSkFo+M2X27OqloBWjwjFrkOnW0CGxtUTSOXB7qByBUgdg2JyDjy8leQ+tcOosDng3pjGB8f3IPec19DsBDw0aga2KjcSHHkugTo0+/7A0X9hQEfk68m5wY2p8QkMPs78rzZ2PPy68jOTgeN/IqjTe8i1HkKoiRwFhKKgfW+ApQWl/U7nbmNAlm8ZjJNulVdXlY4WLDKA4VVo4YKaFFAjSIjIxWpS1IAPY4TwWZ0ne7gMF6YJGQDD/kLUbOtZtDtuX8LCeydYNsLLFpZd1UyhquKH0j5Nv8eC2uBKRTYDAS+IMyLBCfbjqHts2OUt8mNwx4OFKHmmV3nHGkrniRrdv7C4yaQf9xbEbqWaRuvKg3knF19n4spYDAOtEsIn+lEsLWFZVFzN+MJgz6yvhg1O+p77K68LWTtY2zgSUuWmz8xP3H8CbfgWPqpa+W6R+FIR184jA8PNUKWE+buKTJF6YaN2PFcXY/dkbmdeEvGF1znK3qnRTsOuBe7s4K/RadL9h/YD0VWzT8qM1h52SbsrN17VrI4txGv/zbYnaQFEXrhZFb0u+ZQ0ysbafWDoE/5QZv2VVJl9JsQnRrKXpB62+ffKpzPoNcvZKmRWy3tHcENOhtnZVVtj922bDtxef9R2b8COZjOjKRDUGshSBIMyxGStvzmfMH/xP8JCIaqE6utsZoAAAAASUVORK5CYII=",
  "220": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAeGVYSWZNTQAqAAAACAAEARoABQAAAAEAAAA+ARsABQAAAAEAAABGASgAAwAAAAEAAgAAh2kABAAAAAEAAABOAAAAAAAAAJAAAAABAAAAkAAAAAEAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAFKADAAQAAAABAAAAFAAAAABgUEhcAAAACXBIWXMAABYlAAAWJQFJUiTwAAAD8UlEQVQ4Ec2UW0wcZRTH/9/clt2FZdnCLveLUrCCBSwlplb6YGNDU0zjpXHDCzYkVZOaGG20xAfjQ9M0RhPRpA/yYG1Boa0opnVTIbbaWlK6LSxRWkuRcissC8sCZdmdmc8za5bQtPHR+CVnzpdv5vzm/M85M8D/fbG1CXLOLYiGXwLjadDAIZDRBbpKFgWi5NVl8ivkNbqn9bPsku61jPuAamimuaejbe/QQB8kUYRILJExiNBjbMNLxl7X6JyjqOxJLbvosXpW/tzxOHQVyFV1l/dMe8eRerdo5KVIlBt5kZ5MUACZNrLIIEsCZOEfn5WVhRdfe/Mvmzm5iu3c6zegFAaQ1ITFkcGDnU1HRJlOzAkKZ7rKcvMLUFVdjfTMDEiCAEoWAl0EWcFw3xX0dnswcKErf8v2HW8RptFgxYCY/LO+5+TxLUN912AxK4YkVlJZhfoDB5GYmQUw0h5fBjWygt6fzsQKcenSb8h7dP0+3tl0jNXuH5T4bZ8rcKP/7XOtX8JMOhWqTVpONuoaP0Ribj4mfddwx3eV6inEjCkmzE9PYuTG7+CCiODiIi5fvOh4PtX5Hil9VcLsyOHzp1oLAxNjSLSawaMrfHPNbpZSupm6GcHU3bsYHx4Co3xCE6MY+6MfOqcqyQrTjA0T0dvvQ3Hx46+UnvrkMwmhmfLA6DBMVHWF2sq4wBw5BVRIO3UhjPK6N2IGrtPkqPju/X3wdn4NRjBN16HqwFI4jHsLIRMiWoaEpcV3dtfWfBMOBddNjE9wkyKzgR9akZ5XAFuqCzrNoDnJDkuKA0KCBSkZORSnM0HQuapzFo5GUfVEKR7JzunCgnYhNjb8+6aawPjYiY5vT6fMBPxQaCxEMgOgajq2uRtQUbuHyhFBc+N+DF69TPMkYTmiorKoEDu3Pn3elZq7h73+wXQMaDSQt39UEwwEvgpbk9cxs5UUkkQyxWyBw5UBwWLF9Z+70PL5xySTI6yqqMjPxY7KTd25zlQ3O3B02uCsAmPQlkPbNFFuF1OdaUYGoM5S+WNj0uf1ov3EMSwsLZFkzsuy09mzpRs86+1ONzvcMmfEG+s+oHGwfPTdamK0+W7ddI1O+WPDPO0P4NbwbUSiGqLE3+hyoLow78cck6Muudkza8TF1wNA48bsoYZnRu+MnDzbc8U5NjdPidJfgoZ7haRuSrPhqUynx26R3XktvtXM4sA1n0D8CHA0fvFLmkl+eXtxwVSGLRErJCRMP5cymwmVSaaz9ui9h8IMwkMzjKNvvrChemxuts07FXTZ6NUlVsmTJEvujb/OP5BZPOZfgcZDPVutZVB5A33CfnlZ+bTiejAYD/5P/N/QAJDuEl5qdAAAAABJRU5ErkJggg==",
  "230": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAeGVYSWZNTQAqAAAACAAEARoABQAAAAEAAAA+ARsABQAAAAEAAABGASgAAwAAAAEAAgAAh2kABAAAAAEAAABOAAAAAAAAAJAAAAABAAAAkAAAAAEAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAFKADAAQAAAABAAAAFAAAAABgUEhcAAAACXBIWXMAABYlAAAWJQFJUiTwAAAD/UlEQVQ4Ec2SW0xcRRjH/3Mu7GGXxXLb5bZLKagk2gJGl4AQriWlJhASFVYTSKHxRVEbrJf40gZNmpj61tqY9kVDm9LUWzFNKIVQiyC2Ql1oC9hqLXKHUurezpk945xttqlafTROcs73nTnf/OY/3/yB//sg9wu8yVh0EvSdIgSnrkOHcN9f/W7OeKA8D4YgBDX8FFrDJw4H8UcqpUhiRLuOjlNHBttH+n4EkTlRoGBCCIxoPOeRf4fAH0Kh6kHkFxejYFtdNl+6O8K5p9DHfEXj38ycaat5z+wP/A4mU67EDw1+kCgOF1UOVcFEA86jRBGlKGjbdziw6ani8tpMMmxAwwoZ65f8VHm7c3+3OaB6IccQpoZUkpLtRE7V00jISEP4+ETnahkkWcTE8FkMnzqJ053Hla0xae/2M1ZfTggNA1dQVtt3dHD7+Z7vIEUDWshHHincjMaOdiSm2yFEeskbSHiuBYFvvzgKSbDi2sgYTJbO7aO9idu4wG5pmrHY61Orb3Ud6BYpCfA5igRnPF56/zUkZ9pxZdSD8YvfcxADERmiTNFYnl3AL+NXIQoxICEF04OjAlPoXiC1T1pZRsvZ44OuqbEJiBaCgOZjZXW1JG9LGqgK3L4xibnJMX4ZQczM/IqrnmkIzMxMURsIYQrATKBeLturP+F62NUqLd3R4+eW1nmzjYYT6DolDkcCbCYgwOt2tD4bfhg/rqZSvNO+B1+e6AV0DtN5EY9UlZGTtQkZDnOSWNO2d8JP1cq1uZmU9eVZbg0Ny6uLsKWkIuDXsDC3AtXHIItmmGQBU1d+w/D5S0QSLAwhhWhBEY9nP4rKotwfMp05r4dts7OjK3PW4/l89uKFXOheblofv38KJUbm7tbR0rwLjY0vQlV17HrlTVwY8vANYqEGRBTlueCuq7hkt8XVFzRt/PmeD7Oyqh3aurdzR3NriauoEJrGW8B0RJutSEtxwmKV0XO6D/v3fQiuDCpXVllQhrYm90hq6ga3vYpcN3woGi9j3Lp1bT1JSOx+yGIvyNtSkpHuzEJiQjKs5ngEeDP7egdw6MBBrkrgm4msLL+CvOpuGnCkxj5nqyY371K4rSJJJL5R/4Ftc+6TXV5RKx3yDEIiChbnFzE1OQ1dkxCiUSh5rAItNS8MbIy3Nma+TOYja434N6AxOf/ZHduNlbWugyc/Ku0Z6oEixXOwFZQKKMraCnep+5wlNqahfM+fYf8INH5c/pSlrMx4j3389aHSc5f7wwZ2pVejPt89kKRYG6oOkwWj7q/jgQojRf27WfLS0u1jvZ4zZVQlKHRUDNikuIa6rx4MM9b9K9Ao6HyGxYkymrl7ZMGEI8+fIKvG/H82/gDk6qD7+kjkKAAAAABJRU5ErkJggg==",
};
const WEB_MEMBERSHIP_PACKAGE_BY_LABEL: Readonly<Record<string, string>> = {
  "高级会员": "210",
  "专业会员": "220",
  "超级会员": "230",
};

function trustedMembershipIconUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value)) return value;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !TRUSTED_ICON_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function membershipIcon(profile: AccountProfile, active = hasActiveMembership(profile)): MembershipIcon | undefined {
  if (!active) return undefined;
  const fallbackPackage = profile.packageId && WEB_MEMBERSHIP_ICONS[profile.packageId]
    ? profile.packageId
    : WEB_MEMBERSHIP_PACKAGE_BY_LABEL[profile.vipLabel];
  const src = trustedMembershipIconUrl(profile.membershipIconUrl)
    ?? trustedMembershipIconUrl(fallbackPackage ? WEB_MEMBERSHIP_ICONS[fallbackPackage] : undefined);
  return src ? { src, alt: `${profile.vipLabel}图标` } : undefined;
}

export function hasActiveMembership(profile: AccountProfile, now = Date.now()): boolean {
  return profile.isVip && (profile.expiresAt === undefined || profile.expiresAt > now);
}

export function hasExpiredMembership(profile: AccountProfile, now = Date.now()): boolean {
  return profile.expiresAt !== undefined && profile.expiresAt <= now;
}

export function membershipLabel(profile: AccountProfile, now = Date.now()): string {
  if (hasActiveMembership(profile, now)) return profile.vipLabel;
  if (hasExpiredMembership(profile, now)) return "会员已过期";
  return "普通用户";
}

export function membershipDisplay(profile: AccountProfile, now = Date.now()): MembershipDisplay {
  const usedBytes = profile.usedBytes ?? profile.enterpriseUsedBytes;
  const totalBytes = profile.totalBytes ?? profile.enterpriseTotalBytes;
  const storage = totalBytes === undefined
    ? formatStorageCapacity(usedBytes)
    : `${formatStorageCapacity(usedBytes)}/${formatStorageCapacity(totalBytes)}`;
  return {
    status: { label: "会员状态", value: membershipLabel(profile, now), renewal: true },
    details: [
      { label: "到期时间", value: profile.expiresAt ? new Date(profile.expiresAt).toLocaleString() : "无到期时间" },
      { label: "存储空间", value: storage },
    ],
  };
}
