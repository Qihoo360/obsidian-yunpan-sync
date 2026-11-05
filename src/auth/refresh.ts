import { OauthCodeExpiredError } from "./oauth.js";
import type { CloudAuth } from "./secrets.js";


export class ReloginRequiredError extends Error {
  constructor(message: string, readonly traceId?: string) {
    super(message);
    this.name = "ReloginRequiredError";
  }
}

export class OAuthCodeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthCodeUnavailableError";
  }
}

export class AuthRefreshCoordinator {
  private pending?: Promise<void>;

  constructor(
    private readonly getAuth: () => CloudAuth | undefined,
    private readonly setAuth: (auth: CloudAuth) => void,
    private readonly exchange: (oauthCode: string) => Promise<CloudAuth>,
  ) {}

  refresh(): Promise<void> {
    if (!this.pending) {
      this.pending = this.refreshNow().finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  private async refreshNow(): Promise<void> {
    const startedAt = Date.now();
    
    const current = this.getAuth();
    if (!current?.oauthCode) {
      
      throw new OAuthCodeUnavailableError("请重新登录");
    }
    let renewed: CloudAuth;
    try {
      renewed = await this.exchange(current.oauthCode);
    } catch (error) {
      if (error instanceof OauthCodeExpiredError) {
        
        throw new ReloginRequiredError("请重新登录", error.traceId);
      }
      
      throw error;
    }
    if (renewed.qid !== current.qid) {
      throw new ReloginRequiredError("请重新登录");
    }
    this.setAuth({ ...renewed, oauthCode: current.oauthCode });
    
  }
}
