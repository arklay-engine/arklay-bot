import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

function readExisting(): Map<string, string> {
  const path = resolve(".env");
  const values = new Map<string, string>();
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1]) values.set(match[1], match[2] ?? "");
  }
  return values;
}

async function hiddenQuestion(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string> {
  process.stdout.write(prompt);
  execFileSync("stty", ["-echo"], { stdio: "inherit" });
  try {
    return (await rl.question("")).trim();
  } finally {
    execFileSync("stty", ["echo"], { stdio: "inherit" });
    process.stdout.write("\n");
  }
}

async function main(): Promise<void> {
  const existing = readExisting();
  const rl = createInterface({ input, output, terminal: false });

  console.log("Arklay bot environment setup. Values are written to .env (0600).");
  console.log("Press Enter to keep an existing value.\n");

  const discord = await hiddenQuestion(
    rl,
    `Discord bot token${existing.get("DISCORD_TOKEN") ? " [keep existing]" : ""}: `,
  );
  const github = await hiddenQuestion(
    rl,
    `GitHub token (optional; Enter to skip)${existing.get("GITHUB_TOKEN") ? " [keep existing]" : ""}: `,
  );
  const attachment = await hiddenQuestion(
    rl,
    `GitHub attachment token (optional; Enter to skip)${existing.get("GITHUB_ATTACHMENT_TOKEN") ? " [keep existing]" : ""}: `,
  );
  rl.close();

  if (discord) existing.set("DISCORD_TOKEN", discord);
  if (github) existing.set("GITHUB_TOKEN", github);
  if (attachment) existing.set("GITHUB_ATTACHMENT_TOKEN", attachment);
  if (!existing.has("LOG_LEVEL")) existing.set("LOG_LEVEL", "info");

  const lines = [...existing.entries()].map(([key, value]) => `${key}=${value}`);
  writeFileSync(resolve(".env"), `${lines.join("\n")}\n`, { mode: 0o600 });
  console.log("\nWrote .env. Start the bot with: npm run dev");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
