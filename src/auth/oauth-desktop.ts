import type { CloudAuth } from "./secrets.js";
import { MobileOAuth, type MobilePendingOAuth } from "./oauth-mobile.js";

export interface DesktopPendingOAuth extends MobilePendingOAuth { flow: "desktop" }
export interface PreparedDesktopOAuth { authorizationUrl: string; pending: DesktopPendingOAuth }

/** Native callback and PKCE transport shared with mobile, desktop presentation. */
export class DesktopOAuth {
  constructor(private readonly environment: "production", private readonly openApiUrl: string) {}

  async prepare(signal?: AbortSignal): Promise<PreparedDesktopOAuth> {
    const prepared = await new MobileOAuth(this.environment, this.openApiUrl, undefined, signal).prepare("desktop");
    return { ...prepared, pending: { ...prepared.pending, flow: "desktop" } };
  }

  complete(params: { action?: string; code?: string; state?: string; error?: string }, pending: DesktopPendingOAuth, signal?: AbortSignal): Promise<CloudAuth> {
    return new MobileOAuth(this.environment, this.openApiUrl, undefined, signal).complete(params, pending, "desktop");
  }
}
