import type { ReportSlots } from "../types.js";

export function truncate(value: string, max: number, suffix = "\n…"): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function stripCodeFences(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) return trimmed;
  const withoutOpen = trimmed.slice(firstNewline + 1);
  const lastFence = withoutOpen.lastIndexOf("```");
  return (lastFence === -1 ? withoutOpen : withoutOpen.slice(0, lastFence)).trim();
}

export function extractJsonObject(value: string): unknown | null {
  const candidates = [value.trim(), stripCodeFences(value)];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the outermost object next.
    }
  }

  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function sanitizeIssueText(value: string, max = 20000): string {
  return truncate(
    value
      .replace(/\u0000/g, "")
      .replace(/@everyone/gi, "@\u200beveryone")
      .replace(/@here/gi, "@\u200bhere")
      .replace(/\r\n/g, "\n")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim(),
    max,
  );
}

export function codeBlock(value: string, max = 20000): string {
  const text = sanitizeIssueText(value, max);
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((maxRun, run) => Math.max(maxRun, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

export function titleFromSummary(summary: string): string {
  const firstLine = oneLine(summary)
    .replace(/^\[bug\]\s*/i, "")
    .replace(/^bug:\s*/i, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/[.!?;:]+$/g, "")
    .trim();
  return truncate(firstLine || "Bug report", 120, "");
}

export function formatEnvironment(slots: ReportSlots): string {
  const rows: Array<[string, string]> = [
    ["Game", slots.game],
    ["Release", slots.release],
    ["Arklay", slots.version],
    ["OS", slots.os],
    ["GPU", slots.gpu],
    ["Renderer", slots.renderer],
    ["Mods", slots.mods],
  ];
  return rows
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `- ${label}: ${oneLine(value)}`)
    .join("\n");
}

export function formatSlots(slots: ReportSlots): string {
  const rows = Object.entries(slots)
    .filter(([, value]) => value.trim())
    .map(([key, value]) => `${key}: ${oneLine(value)}`);
  return rows.length ? rows.join("\n") : "(nothing collected yet)";
}

export function parseQuickCommand(content: string): string | null {
  const match = /^\\quick(?:\s+([\s\S]*))?$/i.exec(content.trim());
  if (!match) return null;
  return (match[1] ?? "").trim();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
