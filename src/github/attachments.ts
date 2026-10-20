import { randomUUID } from "node:crypto";

const USER_AGENT = "arklay-bot/0.1";

export interface AttachmentUploader {
  upload(
    buffer: Buffer,
    name: string,
    contentType: string,
    reportId: string,
  ): Promise<string>;
}

/** GitHub's user-attachments endpoint. Good for images, not arbitrary files. */
export class GitHubUserAttachmentUploader implements AttachmentUploader {
  constructor(
    private readonly token: string,
    private readonly repoId: number,
  ) {}

  async upload(
    buffer: Buffer,
    name: string,
    contentType: string,
  ): Promise<string> {
    const url =
      "https://uploads.github.com/user-attachments/assets" +
      `?name=${encodeURIComponent(name)}` +
      `&content_type=${encodeURIComponent(contentType)}` +
      `&repository_id=${this.repoId}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: buffer,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub attachment upload failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    const data = JSON.parse(text) as { url?: string };
    if (!data.url) {
      throw new Error(
        `GitHub attachment upload returned no URL: ${text.slice(0, 300)}`,
      );
    }
    return data.url;
  }
}

/**
 * Uploads into a dedicated attachments repository. Supports images, save
 * files, and any other binary file.
 */
export class GitHubRepoAttachmentUploader implements AttachmentUploader {
  constructor(
    private readonly token: string,
    private readonly repo: string,
    private readonly branch = "main",
  ) {}

  async upload(
    buffer: Buffer,
    name: string,
    _contentType: string,
    reportId: string,
  ): Promise<string> {
    const safeName =
      name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "attachment";
    const path = `reports/${reportId}/${randomUUID().slice(0, 8)}-${safeName}`;
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");

    const response = await fetch(
      `https://api.github.com/repos/${this.repo}/contents/${encodedPath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          message: `Add Discord attachment ${name}`,
          content: buffer.toString("base64"),
          branch: this.branch,
        }),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub attachment upload failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    const data = JSON.parse(text) as {
      content?: { download_url?: string; html_url?: string };
    };
    const url = data.content?.download_url ?? data.content?.html_url;
    if (!url) {
      throw new Error(
        `GitHub attachment upload returned no URL: ${text.slice(0, 300)}`,
      );
    }
    return url;
  }
}
