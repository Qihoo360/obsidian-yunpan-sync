export const RELOGIN_MESSAGE = "请重新登录";

export type StatusBarDestination = "settings" | "status";

export function statusBarDestination(authenticated: boolean, statusMessage: string): StatusBarDestination {
  return !authenticated || statusMessage === RELOGIN_MESSAGE ? "settings" : "status";
}
