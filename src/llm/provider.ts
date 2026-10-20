import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { DedupeMatch, GithubIssue, LlmTurn, Report } from "../types.js";
import { logger } from "../logger.js";
import { extractJsonObject, sleep } from "../util/text.js";
import {
  DEDUPE_SYSTEM_PROMPT,
  TURN_SYSTEM_PROMPT,
  buildDedupeUserPrompt,
  buildTurnUserPrompt,
} from "./prompts.js";
import { DedupeResultSchema, LlmTurnSchema } from "./schemas.js";

export interface TurnOptions {
  quick?: boolean;
}

export interface LlmProvider {
  readonly name: string;
  init(): Promise<void>;
  runTurn(
    report: Report,
    maxUserTurns: number,
    options?: TurnOptions,
  ): Promise<LlmTurn>;
  findDuplicates(report: Report, issues: GithubIssue[]): Promise<DedupeMatch[]>;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  private async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

abstract class BaseProvider implements LlmProvider {
  abstract readonly name: string;
  protected readonly limit = new Semaphore(2);

  abstract init(): Promise<void>;
  protected abstract completeTurn(
    report: Report,
    maxUserTurns: number,
    options?: TurnOptions,
  ): Promise<string>;
  protected abstract completeDedupe(
    report: Report,
    issues: GithubIssue[],
  ): Promise<string>;

  async runTurn(
    report: Report,
    maxUserTurns: number,
    options?: TurnOptions,
  ): Promise<LlmTurn> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const text = await this.limit.run(() =>
          this.completeTurn(report, maxUserTurns, options),
        );
        return parseTurn(text);
      } catch (error) {
        lastError = error;
        logger.warn(`LLM turn attempt ${attempt + 1} failed`, String(error));
        if (attempt === 0) await sleep(500);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "LLM turn failed"));
  }

  async findDuplicates(
    report: Report,
    issues: GithubIssue[],
  ): Promise<DedupeMatch[]> {
    if (issues.length === 0) return [];
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const text = await this.limit.run(() =>
          this.completeDedupe(report, issues),
        );
        return parseMatches(text, issues);
      } catch (error) {
        lastError = error;
        logger.warn(
          `LLM duplicate check attempt ${attempt + 1} failed`,
          String(error),
        );
        if (attempt === 0) await sleep(500);
      }
    }
    logger.warn(`Duplicate check failed: ${String(lastError)}`);
    return [];
  }
}

function parseTurn(text: string): LlmTurn {
  const json = extractJsonObject(text);
  if (!json) {
    throw new Error(`LLM did not return JSON: ${text.slice(0, 300)}`);
  }
  const result = LlmTurnSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `LLM returned invalid report JSON: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

function parseMatches(text: string, issues: GithubIssue[]): DedupeMatch[] {
  const json = extractJsonObject(text);
  if (!json) {
    throw new Error(`LLM did not return duplicate JSON: ${text.slice(0, 300)}`);
  }
  const result = DedupeResultSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `LLM returned invalid duplicate JSON: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  return result.data.matches
    .filter((match) => match.same_bug && match.confidence >= 0.5)
    .map((match): DedupeMatch | null => {
      const issue = byNumber.get(match.number);
      return issue
        ? {
            number: match.number,
            confidence: match.confidence,
            sameBug: match.same_bug,
            reason: match.reason,
            title: issue.title,
            state: issue.state,
          }
        : null;
    })
    .filter((match): match is DedupeMatch => match !== null)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new Error(
            `${command} timed out after ${options.timeoutMs}ms${stderr ? `\n${stderr.slice(-2000)}` : ""}`,
          ),
        ),
      );
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 20 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`${command} produced too much output`)));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 2 * 1024 * 1024) {
        stderr = stderr.slice(-2 * 1024 * 1024);
      }
    });
    child.on("error", (error) => {
      finish(() => reject(new Error(`${command} failed: ${error.message}`)));
    });
    child.on("exit", (code, signal) => {
      // Wait a tick for the last stdout chunk, then stop waiting on pipes.
      // `--standalone` can leave a child server holding them open.
      setTimeout(() => {
        if (code === 0) {
          finish(() => resolve({ stdout, stderr }));
        } else {
          const detail = stderr.trim() || stdout.trim();
          finish(() =>
            reject(
              new Error(
                `${command} failed (${signal ?? code})${detail ? `\n${detail.slice(-2000)}` : ""}`,
              ),
            ),
          );
        }
      }, 50);
    });
  });
}

export class OpenCodeCliProvider extends BaseProvider {
  readonly name = "opencode-cli";
  private readonly workDir: string;
  private readonly configDir: string;
  private readonly configPath: string;

  constructor(private readonly config: AppConfig) {
    super();
    this.workDir = join(config.dataDir, "llm-workdir");
    this.configDir = join(config.dataDir, "opencode-config");
    this.configPath = join(this.configDir, "opencode.json");
  }

  async init(): Promise<void> {
    mkdirSync(this.workDir, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });
    const agentConfig = {
      agents: {
        "arklay-reporter": {
          description: "Arklay bug report interviewer. JSON only, no tools.",
          mode: "primary",
          system: TURN_SYSTEM_PROMPT,
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        },
        "arklay-dedupe": {
          description: "Arklay duplicate issue judge. JSON only, no tools.",
          mode: "primary",
          system: DEDUPE_SYSTEM_PROMPT,
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        },
      },
    };
    writeFileSync(this.configPath, JSON.stringify(agentConfig, null, 2));
    logger.info(`Using OpenCode CLI backend (${this.config.llm.model})`);
  }

  private async complete(
    agent: "arklay-reporter" | "arklay-dedupe",
    model: string,
    prompt: string,
  ): Promise<string> {
    const { stdout, stderr } = await runProcess(
      this.config.llm.opencode_command,
      [
        "run",
        "--standalone",
        "--model",
        model,
        "--agent",
        agent,
        "--format",
        "json",
        prompt,
      ],
      {
        cwd: this.workDir,
        env: {
          ...process.env,
          OPENCODE_CONFIG: this.configPath,
          OPENCODE_CONFIG_DIR: this.configDir,
          NO_COLOR: "1",
        },
        timeoutMs: this.config.llm.timeout_seconds * 1000,
      },
    );

    if (stderr.trim()) logger.debug("opencode stderr", stderr.trim().slice(-1000));

    const texts: string[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as {
          type?: string;
          error?: { message?: string };
          part?: { type?: string; text?: string };
        };
        if (event.type === "error") {
          throw new Error(event.error?.message ?? "opencode returned an error");
        }
        if (event.type === "text" && typeof event.part?.text === "string") {
          texts.push(event.part.text);
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }

    const text = texts.join("").trim();
    if (!text) throw new Error("opencode returned no text output");
    return text;
  }

  protected completeTurn(
    report: Report,
    maxUserTurns: number,
    options?: TurnOptions,
  ): Promise<string> {
    return this.complete(
      "arklay-reporter",
      this.config.llm.model,
      buildTurnUserPrompt(
        report,
        maxUserTurns,
        options?.quick,
        this.config.behavior.diagnostics_hint,
      ),
    );
  }

  protected completeDedupe(
    report: Report,
    issues: GithubIssue[],
  ): Promise<string> {
    return this.complete(
      "arklay-dedupe",
      this.config.llm.dedupe_model ?? this.config.llm.model,
      buildDedupeUserPrompt(report, issues),
    );
  }
}

export class OpenAIProvider extends BaseProvider {
  readonly name = "openai-compatible";

  constructor(private readonly config: AppConfig) {
    super();
  }

  async init(): Promise<void> {
    const key = process.env[this.config.llm.api_key_env];
    if (!key) {
      throw new Error(`Missing $${this.config.llm.api_key_env}`);
    }
    logger.info(
      `Using OpenAI-compatible backend ${this.config.llm.base_url} (${this.config.llm.model})`,
    );
  }

  private async complete(
    system: string,
    prompt: string,
    model: string,
    maxTokens: number,
  ): Promise<string> {
    const url = `${this.config.llm.base_url.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${process.env[this.config.llm.api_key_env] ?? ""}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "arklay-bot/0.1",
    };
    if (url.includes("opencode.ai")) {
      headers["x-opencode-session"] = randomUUID();
    }

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      temperature: this.config.llm.temperature,
      max_tokens: maxTokens,
    };
    if (this.config.llm.json_mode) {
      body.response_format = { type: "json_object" };
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.llm.timeout_seconds * 1000),
      });
      const text = await response.text();
      if (response.ok) {
        const data = JSON.parse(text) as {
          choices?: Array<{
            message?: { content?: string | Array<{ text?: string }> };
          }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content.map((part) => part.text ?? "").join("");
        }
        throw new Error("LLM response had no content");
      }

      lastError = new Error(
        `LLM request failed (${response.status}): ${text.slice(0, 500)}`,
      );
      if (response.status === 429 || response.status >= 500) {
        await sleep(1000);
        continue;
      }
      throw lastError;
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("LLM request failed");
  }

  protected completeTurn(
    report: Report,
    maxUserTurns: number,
    options?: TurnOptions,
  ): Promise<string> {
    return this.complete(
      TURN_SYSTEM_PROMPT,
      buildTurnUserPrompt(
        report,
        maxUserTurns,
        options?.quick,
        this.config.behavior.diagnostics_hint,
      ),
      this.config.llm.model,
      1400,
    );
  }

  protected completeDedupe(
    report: Report,
    issues: GithubIssue[],
  ): Promise<string> {
    return this.complete(
      DEDUPE_SYSTEM_PROMPT,
      buildDedupeUserPrompt(report, issues),
      this.config.llm.dedupe_model ?? this.config.llm.model,
      800,
    );
  }
}

export async function createLlmProvider(
  config: AppConfig,
): Promise<LlmProvider> {
  const provider =
    config.llm.backend === "openai"
      ? new OpenAIProvider(config)
      : new OpenCodeCliProvider(config);
  await provider.init();
  return provider;
}
