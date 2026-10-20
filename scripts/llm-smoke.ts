import "dotenv/config";
import { mkdirSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { createLlmProvider } from "../src/llm/provider.js";
import { GitHubClient } from "../src/github/client.js";
import { emptySlots, type Report } from "../src/types.js";
import { randomUUID } from "node:crypto";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const llm = await createLlmProvider(config);

  const args = process.argv.slice(2).filter((arg) => arg !== "--dedupe");
  const text =
    args.join(" ") ||
    "The game crashes when I enter the save room in RE1. I'm on the Steam version.";
  const report: Report = {
    id: randomUUID(),
    threadId: "smoke-thread",
    starterMessageId: "smoke-message",
    channelId: "smoke-channel",
    guildId: "smoke-guild",
    userId: "smoke-user",
    userName: "Smoke Tester",
    status: "collecting",
    slots: emptySlots(),
    transcript: [
      {
        role: "user",
        content: text,
        at: Date.now(),
        userId: "smoke-user",
        userName: "Smoke Tester",
      },
    ],
    attachments: [],
    draft: null,
    duplicateMatches: [],
    issueNumber: null,
    issueUrl: null,
    dryRun: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const turn = await llm.runTurn(report, config.behavior.max_user_turns);
  for (const [key, value] of Object.entries(turn.slots)) {
    if (value) report.slots[key as keyof typeof report.slots] = value;
  }
  console.log(JSON.stringify(turn, null, 2));

  if (process.argv.includes("--dedupe")) {
    const github = new GitHubClient(config.github.repo, undefined);
    const issues = await github.listIssues(config.github.max_issues_for_dedupe);
    const matches = await llm.findDuplicates(report, issues);
    console.log(JSON.stringify({ matches }, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
