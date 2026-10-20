export interface ReportSlots {
  report_type: string;
  area: string;
  summary: string;
  game: string;
  release: string;
  version: string;
  os: string;
  gpu: string;
  renderer: string;
  mods: string;
  steps: string;
  expected: string;
  actual: string;
  frequency: string;
  logs: string;
  screenshots: string;
  save_file: string;
  diagnostics: string;
  attachments: string;
  notes: string;
}

export const SLOT_KEYS: Array<keyof ReportSlots> = [
  "report_type",
  "area",
  "summary",
  "game",
  "release",
  "version",
  "os",
  "gpu",
  "renderer",
  "mods",
  "steps",
  "expected",
  "actual",
  "frequency",
  "logs",
  "screenshots",
  "save_file",
  "diagnostics",
  "attachments",
  "notes",
];

export function emptySlots(): ReportSlots {
  return {
    report_type: "",
    area: "",
    summary: "",
    game: "",
    release: "",
    version: "",
    os: "",
    gpu: "",
    renderer: "",
    mods: "",
    steps: "",
    expected: "",
    actual: "",
    frequency: "",
    logs: "",
    screenshots: "",
    save_file: "",
    diagnostics: "",
    attachments: "",
    notes: "",
  };
}

export function isEnhancement(slots: ReportSlots): boolean {
  return /enhancement|feature/i.test(slots.report_type);
}

export interface ReportAttachment {
  kind: "screenshot" | "save" | "file";
  name: string;
  url: string;
  discordUrl: string;
  contentType: string;
  size: number;
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  content: string;
  at: number;
  userId?: string;
  userName?: string;
}

export type ReportStatus =
  | "collecting"
  | "awaiting_confirmation"
  | "awaiting_approval"
  | "filed"
  | "duplicate"
  | "cancelled";

export interface Draft {
  title: string;
  body: string;
}

export interface DedupeMatch {
  number: number;
  confidence: number;
  sameBug: boolean;
  reason: string;
  title?: string;
  state?: string;
}

export interface Report {
  id: string;
  threadId: string;
  starterMessageId: string | null;
  channelId: string;
  guildId: string;
  userId: string;
  userName: string;
  status: ReportStatus;
  slots: ReportSlots;
  transcript: TranscriptEntry[];
  attachments: ReportAttachment[];
  draft: Draft | null;
  duplicateMatches: DedupeMatch[];
  issueNumber: number | null;
  issueUrl: string | null;
  dryRun: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LlmTurn {
  reply: string;
  slots: Partial<ReportSlots>;
  missing: string[];
  ready: boolean;
  title: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  htmlUrl: string;
}
