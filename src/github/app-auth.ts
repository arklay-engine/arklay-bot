import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { logger } from "../logger.js";

const API = "https://api.github.com";
const USER_AGENT = "arklay-bot/0.1";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface InstallationToken {
  token: string;
  expiresAt: number;
}

export class GitHubAppAuth {
  private readonly privateKey: string;
  private installationId: number | null;
  private cached: InstallationToken | null = null;

  constructor(
    private readonly appId: string,
    privateKeyPath: string,
    private readonly repo: string,
    installationId = "",
  ) {
    this.privateKey = readFileSync(privateKeyPath, "utf8");
    this.installationId = installationId.trim()
      ? Number(installationId.trim())
      : null;
    if (
      this.installationId !== null &&
      (!Number.isInteger(this.installationId) || this.installationId <= 0)
    ) {
      throw new Error(`Invalid github.installation_id: ${installationId}`);
    }
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iat: now - 60,
        exp: now + 9 * 60,
        iss: this.appId,
      }),
    ).toString("base64url");
    const signature = createSign("RSA-SHA256")
      .update(`${header}.${payload}`)
      .sign(this.privateKey)
      .toString("base64url");
    return `${header}.${payload}.${signature}`;
  }

  private async request<T>(
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub App request ${path} failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async discoverInstallationId(): Promise<number> {
    const data = await this.request<{ id: number }>(
      `/repos/${this.repo}/installation`,
      this.jwt(),
    );
    if (!data.id) {
      throw new Error(
        `The GitHub App is not installed on ${this.repo}. Install it on that repository first.`,
      );
    }
    logger.info(`GitHub App installation ${data.id} on ${this.repo}`);
    return data.id;
  }

  async getToken(): Promise<string> {
    if (
      this.cached &&
      this.cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()
    ) {
      return this.cached.token;
    }

    if (!this.installationId) {
      this.installationId = await this.discoverInstallationId();
    }

    const data = await this.request<{
      token: string;
      expires_at: string;
    }>(`/app/installations/${this.installationId}/access_tokens`, this.jwt(), {
      method: "POST",
    });

    this.cached = {
      token: data.token,
      expiresAt: Date.parse(data.expires_at),
    };
    logger.debug("Refreshed GitHub App installation token");
    return this.cached.token;
  }
}
