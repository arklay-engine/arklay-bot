import type { GithubIssue } from "../types.js";
import type { GitHubAppAuth } from "./app-auth.js";
import { logger } from "../logger.js";

const API = "https://api.github.com";
const USER_AGENT = "arklay-bot/0.1";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export class GitHubClient {
  private issueCache: {
    at: number;
    issues: GithubIssue[];
    max: number;
  } | null = null;
  private repoId: number | null = null;

  constructor(
    private readonly repo: string,
    private readonly token: string | undefined,
    private readonly appAuth: GitHubAppAuth | undefined = undefined,
  ) {}

  get hasAuth(): boolean {
    return Boolean(this.token || this.appAuth);
  }

  private async getToken(): Promise<string | undefined> {
    return this.appAuth ? this.appAuth.getToken() : this.token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
      ...(init.headers as Record<string, string> | undefined),
    };
    const token = await this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${API}${path}`, { ...init, headers });
    const text = await response.text();
    if (!response.ok) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (response.status === 403 && remaining === "0") {
        throw new GitHubError(
          "GitHub API rate limit reached",
          response.status,
          text,
        );
      }
      throw new GitHubError(
        `GitHub API ${response.status}: ${text.slice(0, 500)}`,
        response.status,
        text,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async getRepoId(): Promise<number> {
    if (this.repoId) return this.repoId;
    const repo = await this.request<{ id: number }>(`/repos/${this.repo}`);
    this.repoId = repo.id;
    return repo.id;
  }

  async listIssues(max = 150): Promise<GithubIssue[]> {
    if (
      this.issueCache &&
      this.issueCache.max >= max &&
      Date.now() - this.issueCache.at < 5 * 60 * 1000
    ) {
      return this.issueCache.issues.slice(0, max);
    }

    const collected: GithubIssue[] = [];
    for (let page = 1; collected.length < max; page += 1) {
      const batch = await this.request<
        Array<{
          number: number;
          title: string;
          body: string | null;
          state: string;
          labels: Array<{ name: string }>;
          html_url: string;
          pull_request?: unknown;
        }>
      >(
        `/repos/${this.repo}/issues?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
      );
      if (batch.length === 0) break;
      for (const issue of batch) {
        if (issue.pull_request) continue;
        collected.push({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          state: issue.state,
          labels: issue.labels.map((label) => label.name),
          htmlUrl: issue.html_url,
        });
        if (collected.length >= max) break;
      }
      if (batch.length < 100) break;
    }

    this.issueCache = { at: Date.now(), issues: collected, max };
    logger.debug(`Fetched ${collected.length} GitHub issues for dedupe`);
    return collected;
  }

  async getIssue(number: number): Promise<GithubIssue> {
    const issue = await this.request<{
      number: number;
      title: string;
      body: string | null;
      state: string;
      labels: Array<{ name: string }>;
      html_url: string;
    }>(`/repos/${this.repo}/issues/${number}`);
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      labels: issue.labels.map((label) => label.name),
      htmlUrl: issue.html_url,
    };
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<GithubIssue> {
    if (!this.hasAuth) {
      throw new GitHubError(
        "No GitHub authentication is configured; cannot create an issue",
        401,
        "",
      );
    }

    try {
      return await this.createIssueRequest(input);
    } catch (error) {
      if (
        error instanceof GitHubError &&
        error.status === 422 &&
        /label/i.test(error.body)
      ) {
        logger.warn(
          `A configured label does not exist; retrying issue without labels`,
        );
        return this.createIssueRequest({ ...input, labels: [] });
      }
      throw error;
    }
  }

  private async createIssueRequest(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<GithubIssue> {
    const issue = await this.request<{
      number: number;
      title: string;
      body: string | null;
      state: string;
      labels: Array<{ name: string }>;
      html_url: string;
    }>(`/repos/${this.repo}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    this.issueCache = null;
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      labels: issue.labels.map((label) => label.name),
      htmlUrl: issue.html_url,
    };
  }

  async commentIssue(number: number, body: string): Promise<void> {
    if (!this.hasAuth) {
      throw new GitHubError(
        "No GitHub authentication is configured; cannot comment on an issue",
        401,
        "",
      );
    }
    await this.request(`/repos/${this.repo}/issues/${number}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
  }

  async addReaction(number: number, content = "+1"): Promise<void> {
    if (!this.hasAuth) return;
    await this.request(`/repos/${this.repo}/issues/${number}/reactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ content }),
    });
  }
}
