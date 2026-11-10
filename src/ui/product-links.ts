import type { Environment } from "../settings.js";

export interface ProductLinks {
  renewal: string;
  capacity: string;
  officialSite: string;
  download: string;
}

export type ProductLinkKind = keyof ProductLinks;
export type ExternalOpener = (url: string, target: string, features: string) => unknown;

const DOWNLOAD_URL = "https://yunpan.360.cn/disk/download1.html";
const FEEDBACK_URL = "https://www.yunpan.com/resource/html/feedback.html";

const LINKS: Readonly<Record<Environment, Readonly<ProductLinks>>> = {
  production: {
    renewal: "https://www.yunpan.com/file/index?default_show_renew=1",
    capacity: "https://www.yunpan.com/mapp/pay",
    officialSite: "https://www.yunpan.com/",
    download: DOWNLOAD_URL,
  },
};

export function productLinks(environment: Environment): Readonly<ProductLinks> {
  return LINKS[environment];
}

export function membershipPaymentUrl(environment: Environment, mobile: boolean): string {
  return productLinks(environment)[mobile ? "capacity" : "renewal"];
}

export function openMembershipPayment(environment: Environment, mobile: boolean,
  opener: ExternalOpener = window.open.bind(window)): void {
  opener(membershipPaymentUrl(environment, mobile), "_blank", "noopener,noreferrer");
}

export function openProductLink(
  environment: Environment,
  kind: ProductLinkKind,
  opener: ExternalOpener = window.open.bind(window),
): true {
  opener(productLinks(environment)[kind], "_blank", "noopener,noreferrer");
  return true;
}

export function feedbackUrl(qid: string): string {
  const url = new URL(FEEDBACK_URL);
  url.searchParams.set("qid", qid);
  return url.toString();
}

export function openFeedbackLink(
  qid: string,
  opener: ExternalOpener = window.open.bind(window),
): true {
  opener(feedbackUrl(qid), "_blank", "noopener,noreferrer");
  return true;
}
