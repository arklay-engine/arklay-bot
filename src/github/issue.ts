import type { AppConfig } from "../config.js";
import { isEnhancement, type Report, type ReportAttachment } from "../types.js";
import {
  codeBlock,
  formatEnvironment,
  sanitizeIssueText,
  titleFromSummary,
  truncate,
} from "../util/text.js";

export interface ComposedIssue {
  title: string;
  body: string;
}

export function issueLabels(
  config: AppConfig,
  slots: Report["slots"],
): string[] {
  return [
    ...config.github.labels,
    isEnhancement(slots)
      ? config.github.enhancement_label
      : config.github.bug_label,
  ].filter((label) => label.trim());
}

export interface ComposeIssueOptions {
  possiblyRelated?: number[];
  quick?: boolean;
  titleOverride?: string;
}

export function composeIssue(
  report: Report,
  config: AppConfig,
  options: ComposeIssueOptions = {},
): ComposedIssue {
  const slots = report.slots;
  const enhancement = isEnhancement(slots);
  const title = titleFromSummary(
    options.titleOverride ||
      report.draft?.title ||
      slots.summary ||
      report.transcript[0]?.content ||
      "",
  );

  const summaryRaw = sanitizeIssueText(slots.summary, 4000);
  const summary = summaryRaw || "Not provided.";
  const environment = formatEnvironment(slots);
  const steps = sanitizeIssueText(slots.steps, 8000);
  const expected = sanitizeIssueText(slots.expected, 4000);
  const actual = sanitizeIssueText(slots.actual, 6000);
  const diagnostics = sanitizeIssueText(slots.diagnostics, 20000);
  const logs = slots.logs.trim()
    ? `<details>\n<summary>Logs</summary>\n\n${codeBlock(slots.logs, 20000)}\n\n</details>`
    : "";

  const screenshots = report.attachments.filter(
    (attachment) => attachment.kind === "screenshot",
  );
  const saves = report.attachments.filter(
    (attachment) => attachment.kind === "save",
  );
  const otherFiles = report.attachments.filter(
    (attachment) => attachment.kind === "file",
  );

  const normalize = (value: string): string =>
    value
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[.!?;:]+$/, "")
      .toLowerCase();
  const sameAsSummary = (value: string): boolean =>
    Boolean(summaryRaw) && normalize(value) === normalize(summaryRaw);

  const context: string[] = [];
  if (slots.frequency.trim()) {
    context.push(`- Frequency: ${sanitizeIssueText(slots.frequency, 500)}`);
  }
  if (slots.attachments.trim() && otherFiles.length === 0) {
    context.push(`- Attachments: ${sanitizeIssueText(slots.attachments, 1000)}`);
  }
  if (slots.notes.trim() && !enhancement) {
    context.push(sanitizeIssueText(slots.notes, 4000));
  }
  if (options.possiblyRelated?.length) {
    context.push(
      `Possibly related: ${options.possiblyRelated
        .map((number) => `#${number}`)
        .join(", ")}`,
    );
  }
  if (config.github.include_thread_link) {
    context.push(
      options.quick
        ? `Discord message: https://discord.com/channels/${report.guildId}/${report.channelId}/${report.threadId}`
        : `Discord thread: https://discord.com/channels/${report.guildId}/${report.threadId}`,
    );
  }
  if (config.github.include_reporter) {
    context.push(
      `Reported by \`${sanitizeIssueText(report.userName, 100)}\` on Discord.`,
    );
  }

  const sections: string[] = ["### Summary", summary];

  if (enhancement) {
    if (expected) sections.push("", "### Proposed behavior", expected);
    if (actual && !sameAsSummary(actual)) {
      sections.push("", "### Current behavior", actual);
    }
    if (slots.notes.trim()) {
      sections.push("", "### Why", sanitizeIssueText(slots.notes, 4000));
    }
    if (environment) sections.push("", "### Environment", environment);
  } else {
    if (environment) sections.push("", "### Environment", environment);
    if (steps && !sameAsSummary(steps)) {
      sections.push("", "### Steps to reproduce", steps);
    }
    if (expected && !sameAsSummary(expected)) {
      sections.push("", "### Expected behavior", expected);
    }
    if (actual && !sameAsSummary(actual)) {
      sections.push("", "### Actual behavior", actual);
    }
    if (logs) sections.push("", "### Logs", logs);
  }

  if (screenshots.length || (slots.screenshots.trim() && !screenshots.length)) {
    const lines = screenshots.map((attachment) =>
      attachmentLine(attachment, true),
    );
    if (!screenshots.length) {
      lines.push(sanitizeIssueText(slots.screenshots, 2000));
    }
    sections.push("", "### Screenshots", lines.join("\n"));
  }

  if (saves.length || (slots.save_file.trim() && !saves.length)) {
    const lines = saves.map((attachment) => attachmentLine(attachment, false));
    if (!saves.length) {
      lines.push(sanitizeIssueText(slots.save_file, 2000));
    }
    sections.push("", "### Save file", lines.join("\n"));
  }

  if (otherFiles.length) {
    sections.push(
      "",
      "### Files",
      otherFiles.map((attachment) => attachmentLine(attachment, false)).join("\n"),
    );
  }

  if (diagnostics) {
    sections.push(
      "",
      "### Diagnostics",
      `<details>\n<summary>Diagnostics</summary>\n\n${codeBlock(diagnostics, 20000)}\n\n</details>`,
    );
  }

  if (options.quick) {
    context.push("Quick report via Discord.");
  } else {
    context.push("Drafted from a Discord conversation with an AI assistant.");
  }

  if (context.length) {
    sections.push("", "### Additional context", context.join("\n"));
  }
  sections.push("", `<!-- arklay-bot-report: ${report.id} -->`);

  return {
    title: truncate(title, 120, ""),
    body: truncate(sections.join("\n"), 60000, "\n\n[truncated]"),
  };
}

function attachmentLine(
  attachment: ReportAttachment,
  image: boolean,
): string {
  if (attachment.url) {
    return image
      ? `![${attachment.name}](${attachment.url})`
      : `[${attachment.name}](${attachment.url})`;
  }
  if (attachment.discordUrl) {
    return `- [${attachment.name}](${attachment.discordUrl}) (Discord link, may expire)`;
  }
  return `- ${attachment.name} (provided in the Discord thread)`;
}

export function duplicateComment(report: Report): string {
  const slots = report.slots;
  const lines = [
    `Also reported via the Arklay Discord bot.`,
    "",
    `- Summary: ${sanitizeIssueText(slots.summary, 1000) || "Not provided."}`,
  ];
  const environment = formatEnvironment(slots);
  if (environment) {
    lines.push("", environment);
  }
  if (slots.steps.trim()) {
    lines.push("", "Steps from the reporter:", sanitizeIssueText(slots.steps, 3000));
  }
  if (slots.logs.trim()) {
    lines.push("", "<details><summary>Logs</summary>", "", codeBlock(slots.logs, 12000), "", "</details>");
  }
  const screenshots = report.attachments.filter(
    (attachment) => attachment.kind === "screenshot",
  );
  if (screenshots.length) {
    lines.push(
      "",
      "Screenshots:",
      ...screenshots.map((attachment) => attachmentLine(attachment, true)),
    );
  }
  const saves = report.attachments.filter(
    (attachment) => attachment.kind === "save",
  );
  if (saves.length) {
    lines.push(
      "",
      "Save file:",
      ...saves.map((attachment) => attachmentLine(attachment, false)),
    );
  }
  if (slots.attachments.trim()) {
    lines.push("", `Attachments: ${sanitizeIssueText(slots.attachments, 1000)}`);
  }
  lines.push(
    "",
    `Discord thread: https://discord.com/channels/${report.guildId}/${report.threadId}`,
  );
  return truncate(lines.join("\n"), 20000);
}
