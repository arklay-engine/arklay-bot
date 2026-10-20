import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

const ConfigSchema = z.object({
  discord: z.object({
    guild_id: z.string().default(""),
    channel_id: z.string().default(""),
    channel_name: z.string().default("report-a-bug"),
    triage_channel_id: z.string().default(""),
    quick_role_name: z.string().default("umbrella"),
    quick_role_id: z.string().default(""),
    needs_info_tag: z.string().default("needs-info"),
    filed_tag: z.string().default("filed"),
    duplicate_tag: z.string().default("duplicate"),
    maintainer_user_ids: z.array(z.string()).default([]),
  }),
  github: z.object({
    repo: z.string().regex(/^[^/]+\/[^/]+$/, "github.repo must be owner/name"),
    auth: z.enum(["token", "app"]).default("token"),
    token_env: z.string().default("GITHUB_TOKEN"),
    app_id: z.string().default(""),
    installation_id: z.string().default(""),
    private_key_path: z.string().default(""),
    attachment_token_env: z.string().default("GITHUB_ATTACHMENT_TOKEN"),
    attachment_repo: z.string().default(""),
    attachment_branch: z.string().default("main"),
    dry_run: z.boolean().default(true),
    labels: z.array(z.string()).default(["from-discord"]),
    bug_label: z.string().default("bug"),
    enhancement_label: z.string().default("enhancement"),
    include_reporter: z.boolean().default(false),
    include_thread_link: z.boolean().default(true),
    max_issues_for_dedupe: z.number().int().positive().default(150),
  }),
  llm: z.object({
    backend: z.enum(["opencode-cli", "openai"]).default("opencode-cli"),
    model: z.string().min(1),
    dedupe_model: z.string().min(1).optional(),
    base_url: z.string().default("https://opencode.ai/inference/go/openai/v1"),
    api_key_env: z.string().default("OPENCODE_API_KEY"),
    json_mode: z.boolean().default(true),
    opencode_command: z.string().default("opencode"),
    timeout_seconds: z.number().int().positive().default(90),
    temperature: z.number().min(0).max(2).default(0.2),
  }),
  behavior: z.object({
    approval_required: z.boolean().default(false),
    max_user_turns: z.number().int().positive().default(8),
    max_reports_per_user_per_day: z.number().int().positive().default(5),
    archive_after_file: z.boolean().default(false),
    privacy_notice: z.boolean().default(true),
    diagnostics_hint: z.string().default(""),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema> & {
  configPath: string;
  dataDir: string;
};

export function loadConfig(): AppConfig {
  const configPath = resolve(process.env.CONFIG_PATH ?? "config.toml");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `Could not read ${configPath}. Copy config.example.toml to config.toml first.`,
    );
  }

  let parsedToml: unknown;
  try {
    parsedToml = parse(raw);
  } catch (error) {
    throw new Error(`Could not parse ${configPath}: ${String(error)}`);
  }

  const result = ConfigSchema.safeParse(parsedToml);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid ${configPath}:\n${issues}`);
  }

  const config = result.data;
  const dataDir = resolve(process.env.DATA_DIR ?? "data");

  if (config.github.auth === "app") {
    if (!config.github.app_id.trim()) {
      throw new Error("github.auth is \"app\" but github.app_id is empty.");
    }
    if (!config.github.private_key_path.trim()) {
      throw new Error(
        "github.auth is \"app\" but github.private_key_path is empty.",
      );
    }
    if (!existsSync(resolve(config.github.private_key_path))) {
      throw new Error(
        `GitHub App private key not found at ${resolve(config.github.private_key_path)}.`,
      );
    }
  } else if (config.github.dry_run === false) {
    const token = process.env[config.github.token_env];
    if (!token) {
      throw new Error(
        `github.dry_run is false but $${config.github.token_env} is not set. ` +
          `Set it, or set github.dry_run = true in config.toml.`,
      );
    }
  }

  if (config.llm.backend === "openai") {
    const key = process.env[config.llm.api_key_env];
    if (!key) {
      throw new Error(
        `llm.backend is "openai" but $${config.llm.api_key_env} is not set.`,
      );
    }
  }

  if (config.behavior.approval_required && !config.discord.triage_channel_id) {
    throw new Error(
      "behavior.approval_required is true but discord.triage_channel_id is empty.",
    );
  }

  return { ...config, configPath, dataDir };
}

export function githubToken(config: AppConfig): string | undefined {
  return process.env[config.github.token_env];
}
