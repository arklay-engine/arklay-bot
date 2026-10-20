import "dotenv/config";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, githubToken } from "./config.js";
import { ReportStore } from "./db.js";
import { GitHubClient } from "./github/client.js";
import { GitHubAppAuth } from "./github/app-auth.js";
import {
  GitHubRepoAttachmentUploader,
  GitHubUserAttachmentUploader,
} from "./github/attachments.js";
import { createLlmProvider } from "./llm/provider.js";
import { logger } from "./logger.js";
import { startBot } from "./discord/bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const appAuth =
    config.github.auth === "app"
      ? new GitHubAppAuth(
          config.github.app_id,
          resolve(config.github.private_key_path),
          config.github.repo,
          config.github.installation_id,
        )
      : undefined;
  if (appAuth) {
    // Verify the key, installation, and permissions before Discord starts.
    await appAuth.getToken();
  }

  const store = new ReportStore(config.dataDir);
  const github = new GitHubClient(
    config.github.repo,
    githubToken(config),
    appAuth,
  );
  const llm = await createLlmProvider(config);

  const attachmentToken = process.env[config.github.attachment_token_env];
  const uploader = attachmentToken
    ? config.github.attachment_repo
      ? new GitHubRepoAttachmentUploader(
          attachmentToken,
          config.github.attachment_repo,
          config.github.attachment_branch,
        )
      : new GitHubUserAttachmentUploader(
          attachmentToken,
          await github.getRepoId(),
        )
    : undefined;
  if (!uploader) {
    logger.warn(
      "No attachment token: screenshots and save files will be referenced but not uploaded to GitHub.",
    );
  } else if (config.github.attachment_repo) {
    logger.info(
      `Attachment uploads go to ${config.github.attachment_repo} (${config.github.attachment_branch})`,
    );
  } else {
    logger.info("Attachment uploads use GitHub user-attachments (images only).");
  }

  logger.info(
    `Starting arklay-bot: repo=${config.github.repo} ` +
      `github=${config.github.auth} dry_run=${config.github.dry_run} ` +
      `llm=${llm.name} channel=#${config.discord.channel_name}`,
  );
  if (!github.hasAuth) {
    logger.warn(
      "No GitHub authentication: duplicate checks use the public API and issue creation is disabled.",
    );
  }

  const client = await startBot(config, store, llm, github, uploader);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    await client.destroy();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("unhandledRejection", (error) => {
  logger.error("Unhandled rejection", String(error));
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", String(error));
  process.exit(1);
});

main().catch((error) => {
  logger.error("Fatal startup error", String(error));
  process.exit(1);
});
