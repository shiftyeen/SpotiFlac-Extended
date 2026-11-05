import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SignedSessionConfig {
  namespace: string;
  baseUrl: string;
  appVersion: string;
  platform: string;
  schemeLabel?: string;
  headerPrefix?: string;
  timeWindowSeconds?: number;
  endpoints?: {
    bootstrap?: string;
    challenge?: string;
    exchange?: string;
    refresh?: string;
  };
}

export interface SessionData {
  install_id: string;
  session_id: string | null;
  session_secret: string | null;
  expires_at: string | null;
  refresh_after?: string | null;
  capabilities?: string[];
}

export class SignedSessionClient {
  private config: SignedSessionConfig;
  private sessionData: SessionData;
  private sessionFilePath: string;
  private primaryDataDir: string;

  constructor(config: SignedSessionConfig, workspaceDir: string = process.cwd()) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      schemeLabel: config.schemeLabel || 'ZARZ-HMAC-V1',
      headerPrefix: config.headerPrefix || 'X-Zarz-',
      timeWindowSeconds: config.timeWindowSeconds || 300,
      endpoints: {
        bootstrap: '/bootstrap',
        challenge: '/challenge',
        exchange: '/session/exchange',
        refresh: '/session/refresh',
        ...(config.endpoints || {}),
      },
    };

    // Candidate directories
    this.primaryDataDir = path.resolve(workspaceDir, 'data', 'signed_sessions');
    if (!fs.existsSync(this.primaryDataDir)) {
      fs.mkdirSync(this.primaryDataDir, { recursive: true });
    }

    const scope = `${this.config.namespace}\n${this.config.baseUrl.toLowerCase()}\n${this.config.appVersion.toLowerCase()}\n${this.config.platform.toLowerCase()}`;
    const h = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 16);
    const fileName = `${this.config.namespace}-${h}.json`;

    this.sessionFilePath = path.join(this.primaryDataDir, fileName);

    // Check if session file exists in ~/.mornye/signed_sessions
    const mornyeDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.mornye', 'signed_sessions');
    const mornyePath = path.join(mornyeDir, fileName);
    const mornyeCommunityPath = path.join(mornyeDir, 'community_sessions.json');
    const localCommunityPath = path.join(this.primaryDataDir, 'community_sessions.json');

    this.sessionData = this.loadSession([this.sessionFilePath, mornyePath, localCommunityPath, mornyeCommunityPath]);
  }

  public getConfig(): SignedSessionConfig {
    return this.config;
  }

  public getSessionData(): SessionData {
    return { ...this.sessionData };
  }

  public setSessionData(data: Partial<SessionData>): void {
    this.sessionData = {
      ...this.sessionData,
      ...data,
    };
    this.saveSession();
  }

  private loadSession(candidatePaths: string[]): SessionData {
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, 'utf8');
          const data = JSON.parse(raw);
          if (data && (data.session_id || data.install_id)) {
            return {
              install_id: data.install_id || crypto.randomBytes(16).toString('hex'),
              session_id: data.session_id || null,
              session_secret: data.session_secret || null,
              expires_at: data.expires_at || null,
              refresh_after: data.refresh_after || null,
              capabilities: data.capabilities || [],
            };
          }
        } catch {}
      }
    }

    return {
      install_id: crypto.randomBytes(16).toString('hex'),
      session_id: null,
      session_secret: null,
      expires_at: null,
      refresh_after: null,
      capabilities: [],
    };
  }

  public saveSession(): void {
    try {
      const payload = JSON.stringify(this.sessionData, null, 2);
      fs.writeFileSync(this.sessionFilePath, payload, 'utf8');

      // Also mirror to ~/.mornye/signed_sessions if present
      const mornyeDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.mornye', 'signed_sessions');
      if (fs.existsSync(mornyeDir)) {
        const mornyeFile = path.join(mornyeDir, path.basename(this.sessionFilePath));
        fs.writeFileSync(mornyeFile, payload, 'utf8');
      }

      // If zarz-v2 namespace, also keep community_sessions.json up to date
      if (this.config.namespace === 'zarz-v2') {
        const commFile = path.join(this.primaryDataDir, 'community_sessions.json');
        fs.writeFileSync(commFile, payload, 'utf8');
        if (fs.existsSync(mornyeDir)) {
          fs.writeFileSync(path.join(mornyeDir, 'community_sessions.json'), payload, 'utf8');
        }
      }
    } catch (e) {
      console.warn('[SignedSession] Failed to save session:', e);
    }
  }

  public isAuthenticated(): boolean {
    if (!this.sessionData.session_id || !this.sessionData.session_secret) return false;
    if (this.sessionData.expires_at) {
      const exp = new Date(this.sessionData.expires_at).getTime();
      if (Date.now() > exp) return false;
    }
    return true;
  }

  public needsRefresh(): boolean {
    if (!this.isAuthenticated()) return false;
    const now = Date.now();
    if (this.sessionData.refresh_after) {
      const refTime = new Date(this.sessionData.refresh_after).getTime();
      if (!isNaN(refTime) && now >= refTime) return true;
    }
    if (this.sessionData.expires_at) {
      const exp = new Date(this.sessionData.expires_at).getTime();
      // Refresh if less than 15 minutes remaining
      if (!isNaN(exp) && exp - now < 15 * 60 * 1000) return true;
    }
    return false;
  }

  public async refreshSession(): Promise<boolean> {
    if (!this.sessionData.session_id || !this.sessionData.session_secret) return false;
    try {
      const ep = this.config.endpoints?.refresh || '/session/refresh';
      const bodyStr = JSON.stringify({
        install_id: this.sessionData.install_id,
        session_id: this.sessionData.session_id,
        app_version: this.config.appVersion,
        platform: this.config.platform,
      });
      const bodyBuf = Buffer.from(bodyStr);
      const signedHeaders = this.signHeaders('POST', ep, bodyBuf);

      const res = await fetch(`${this.config.baseUrl}${ep}`, {
        method: 'POST',
        headers: {
          ...signedHeaders,
          'Content-Type': 'application/json',
        },
        body: bodyBuf as any,
      });

      if (!res.ok) return false;
      const data: any = await res.json();
      if (data && data.session_id) {
        this.sessionData.session_id = data.session_id;
        if (data.session_secret) this.sessionData.session_secret = data.session_secret;
        if (data.expires_at) this.sessionData.expires_at = data.expires_at;
        if (data.refresh_after) this.sessionData.refresh_after = data.refresh_after;
        if (data.capabilities) this.sessionData.capabilities = data.capabilities;
        this.saveSession();
        console.log(`[SignedSession] Proactively refreshed session for ${this.config.appVersion}`);
        return true;
      }
    } catch {}
    return false;
  }

  public async bootstrap(): Promise<any> {
    const ep = this.config.endpoints?.bootstrap || '/bootstrap';
    const url = `${this.config.baseUrl}${ep}?install_id=${encodeURIComponent(this.sessionData.install_id)}&app_version=${encodeURIComponent(this.config.appVersion)}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': `SpotiFLAC-Mobile/${this.config.appVersion}`,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bootstrap failed: HTTP ${res.status} - ${text}`);
    }

    const data: any = await res.json();

    // If direct session returned
    if (data.session_id && data.session_secret) {
      this.sessionData.session_id = data.session_id;
      this.sessionData.session_secret = data.session_secret;
      this.sessionData.expires_at = data.expires_at;
      this.sessionData.refresh_after = data.refresh_after || null;
      this.sessionData.capabilities = data.capabilities || [];
      this.saveSession();
      return { success: true };
    }

    // If grant returned directly
    if (data.grant) {
      await this.exchangeGrant(data.grant);
      return { success: true };
    }

    return data;
  }

  public async exchangeGrant(grant: string): Promise<void> {
    const ep = this.config.endpoints?.exchange || '/session/exchange';
    const url = `${this.config.baseUrl}${ep}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `SpotiFLAC-Mobile/${this.config.appVersion}`,
      },
      body: JSON.stringify({
        grant: grant.trim(),
        install_id: this.sessionData.install_id,
        app_version: this.config.appVersion,
        platform: this.config.platform,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Exchange failed: HTTP ${res.status} - ${text}`);
    }

    const data: any = await res.json();
    this.sessionData.session_id = data.session_id;
    this.sessionData.session_secret = data.session_secret;
    this.sessionData.expires_at = data.expires_at;
    this.sessionData.refresh_after = data.refresh_after || null;
    this.sessionData.capabilities = data.capabilities || [];
    this.saveSession();
  }

  public signHeaders(method: string, relPath: string, bodyBuf: Buffer): Record<string, string> {
    const now = new Date();
    const ts = now.toISOString();
    const nonce = crypto.randomBytes(12).toString('hex');
    const bodyHash = crypto.createHash('sha256').update(bodyBuf).digest('hex');
    const window = Math.floor(Date.now() / 1000 / (this.config.timeWindowSeconds || 300));

    const rkBytes = crypto
      .createHmac('sha256', this.sessionData.session_secret || '')
      .update(`${window}:${this.sessionData.session_id || ''}`)
      .digest();
    const rkString = rkBytes.toString('base64url').replace(/=+$/, '');

    const fullUrl = `${this.config.baseUrl}${relPath}`;
    const parsedPath = new URL(fullUrl).pathname;
    const signingInput = `${this.config.schemeLabel}\n${method.toUpperCase()}\n${parsedPath}\n\n${bodyHash}\n${ts}\n${nonce}\n${this.sessionData.session_id}\n${this.config.appVersion}\n${this.config.platform}`;

    const sig = crypto
      .createHmac('sha256', rkString)
      .update(signingInput)
      .digest('base64url')
      .replace(/=+$/, '');

    const p = this.config.headerPrefix || 'X-Zarz-';
    return {
      [`${p}Session`]: this.sessionData.session_id || '',
      [`${p}Timestamp`]: ts,
      [`${p}Nonce`]: nonce,
      [`${p}Body-Sha256`]: bodyHash,
      [`${p}Signature`]: sig,
      [`${p}App-Version`]: this.config.appVersion,
      [`${p}Platform`]: this.config.platform,
      'User-Agent': `SpotiFLAC-Mobile/${this.config.appVersion}`,
    };
  }

  public async fetch(method: string, relPath: string, body: any, customHeaders: Record<string, string> = {}): Promise<any> {
    if (this.needsRefresh()) {
      await this.refreshSession().catch(() => {});
    }

    // If not authenticated, attempt bootstrap once
    if (!this.isAuthenticated()) {
      try {
        const boot = await this.bootstrap();
        if (!this.isAuthenticated()) {
          return {
            statusCode: 428,
            status: 428,
            ok: false,
            needsVerification: true,
            auth_url: boot?.auth_url || `https://api.zarz.moe/v2/challenge/${boot?.challenge_id || ''}`,
            challenge_id: boot?.challenge_id,
            error: `La extensión (${this.config.appVersion}) requiere resolver Turnstile en el navegador`,
          };
        }
      } catch (err: any) {
        return {
          statusCode: 500,
          status: 500,
          ok: false,
          error: `Bootstrap error: ${err.message}`,
        };
      }
    }

    const bodyBuf = body
      ? Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      : Buffer.alloc(0);

    const signedHeaders = this.signHeaders(method, relPath, bodyBuf);
    const headers: Record<string, string> = {
      ...signedHeaders,
      ...customHeaders,
    };

    if (bodyBuf.length > 0 && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }

    const targetUrl = `${this.config.baseUrl}${relPath}`;

    try {
      const res = await fetch(targetUrl, {
        method: method.toUpperCase(),
        headers,
        body: bodyBuf.length > 0 ? (bodyBuf as any) : undefined,
      });

      const resBody = await res.text();
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        resHeaders[k] = v;
      });

      // If token expired or rejected (401 / 403 / 428)
      if (res.status === 401 || res.status === 403 || res.status === 428) {
        // Clear cached session
        this.sessionData.session_id = null;
        this.sessionData.session_secret = null;
        this.saveSession();

        let bootResult: any = null;
        try {
          bootResult = await this.bootstrap();
        } catch {}

        return {
          statusCode: res.status,
          status: res.status,
          ok: false,
          url: targetUrl,
          body: resBody,
          headers: resHeaders,
          needsVerification: true,
          auth_url: bootResult?.auth_url || `https://api.zarz.moe/v2/challenge/${bootResult?.challenge_id || ''}`,
          error: 'Sesión de zarz.moe expirada o requiere Turnstile',
        };
      }

      return {
        statusCode: res.status,
        status: res.status,
        ok: res.ok,
        url: targetUrl,
        body: resBody,
        headers: resHeaders,
      };
    } catch (e: any) {
      return {
        statusCode: 0,
        status: 0,
        ok: false,
        error: e.message,
      };
    }
  }

  public async getChallengeUrl(callbackBaseUrl: string = 'http://127.0.0.1:3000', providerId: string = ''): Promise<{ challengeUrl: string; challengeId: string } | null> {
    const boot = await this.bootstrap();
    if (this.isAuthenticated()) return null;
    if (!boot || !boot.challenge_id) return null;

    const prov = providerId || this.config.appVersion;
    const cb = `${callbackBaseUrl}/api/auth/turnstile/callback?provider=${encodeURIComponent(prov)}&cb_version=v2grant&state=${encodeURIComponent(this.config.namespace || 'zarz-v2')}`;
    const ep = this.config.endpoints?.challenge || '/challenge';
    const challengeUrl = `${this.config.baseUrl}${ep}?id=${encodeURIComponent(boot.challenge_id)}&cb=${encodeURIComponent(cb)}`;

    return {
      challengeUrl,
      challengeId: boot.challenge_id,
    };
  }
}
