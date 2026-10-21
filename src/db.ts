import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Report,
  ReportAttachment,
  ReportSlots,
  ReportStatus,
  TranscriptEntry,
} from "./types.js";
import { emptySlots } from "./types.js";

interface ReportRow {
  id: string;
  thread_id: string;
  starter_message_id: string | null;
  channel_id: string;
  guild_id: string;
  user_id: string;
  user_name: string;
  status: string;
  slots_json: string;
  transcript_json: string;
  attachments_json: string | null;
  draft_json: string | null;
  duplicate_json: string | null;
  issue_number: number | null;
  issue_url: string | null;
  dry_run: number;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToReport(row: ReportRow): Report {
  return {
    id: row.id,
    threadId: row.thread_id,
    starterMessageId: row.starter_message_id ?? null,
    channelId: row.channel_id,
    guildId: row.guild_id,
    userId: row.user_id,
    userName: row.user_name,
    status: row.status as ReportStatus,
    slots: { ...emptySlots(), ...parseJson<Partial<ReportSlots>>(row.slots_json, {}) },
    transcript: parseJson<TranscriptEntry[]>(row.transcript_json, []),
    attachments: parseJson<ReportAttachment[]>(row.attachments_json, []),
    draft: parseJson<Report["draft"]>(row.draft_json, null),
    duplicateMatches: parseJson<Report["duplicateMatches"]>(row.duplicate_json, []),
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
    dryRun: row.dry_run === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ReportStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "arklay-bot.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        thread_id TEXT UNIQUE NOT NULL,
        starter_message_id TEXT,
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        status TEXT NOT NULL,
        slots_json TEXT NOT NULL,
        transcript_json TEXT NOT NULL,
        attachments_json TEXT,
        draft_json TEXT,
        duplicate_json TEXT,
        issue_number INTEGER,
        issue_url TEXT,
        dry_run INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reports_user_created
        ON reports(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reports_thread
        ON reports(thread_id);
    `);
    try {
      this.db.exec("ALTER TABLE reports ADD COLUMN starter_message_id TEXT");
    } catch {
      // Column already exists.
    }
    try {
      this.db.exec("ALTER TABLE reports ADD COLUMN attachments_json TEXT");
    } catch {
      // Column already exists.
    }
  }

  createReport(input: {
    threadId: string;
    starterMessageId: string | null;
    channelId: string;
    guildId: string;
    userId: string;
    userName: string;
    dryRun: boolean;
    initialMessage: string;
  }): Report {
    const now = Date.now();
    const report: Report = {
      id: randomUUID(),
      threadId: input.threadId,
      starterMessageId: input.starterMessageId,
      channelId: input.channelId,
      guildId: input.guildId,
      userId: input.userId,
      userName: input.userName,
      status: "collecting",
      slots: emptySlots(),
      transcript: [
        {
          role: "user",
          content: input.initialMessage,
          at: now,
          userId: input.userId,
          userName: input.userName,
        },
      ],
      attachments: [],
      draft: null,
      duplicateMatches: [],
      issueNumber: null,
      issueUrl: null,
      dryRun: input.dryRun,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO reports (
          id, thread_id, starter_message_id, channel_id, guild_id, user_id,
          user_name, status, slots_json, transcript_json, attachments_json,
          draft_json, duplicate_json, issue_number, issue_url, dry_run,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        report.threadId,
        report.starterMessageId,
        report.channelId,
        report.guildId,
        report.userId,
        report.userName,
        report.status,
        JSON.stringify(report.slots),
        JSON.stringify(report.transcript),
        JSON.stringify(report.attachments),
        null,
        null,
        null,
        null,
        report.dryRun ? 1 : 0,
        report.createdAt,
        report.updatedAt,
      );
    return report;
  }

  getReport(id: string): Report | null {
    const row = this.db
      .prepare("SELECT * FROM reports WHERE id = ?")
      .get(id) as ReportRow | undefined;
    return row ? rowToReport(row) : null;
  }

  getReportByThread(threadId: string): Report | null {
    const row = this.db
      .prepare("SELECT * FROM reports WHERE thread_id = ?")
      .get(threadId) as ReportRow | undefined;
    return row ? rowToReport(row) : null;
  }

  getReportByStarterMessage(messageId: string): Report | null {
    const row = this.db
      .prepare("SELECT * FROM reports WHERE starter_message_id = ?")
      .get(messageId) as ReportRow | undefined;
    return row ? rowToReport(row) : null;
  }

  saveReport(report: Report): void {
    report.updatedAt = Date.now();
    this.db
      .prepare(
        `UPDATE reports SET
          status = ?, slots_json = ?, transcript_json = ?, attachments_json = ?,
          draft_json = ?, duplicate_json = ?, issue_number = ?, issue_url = ?,
          dry_run = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        report.status,
        JSON.stringify(report.slots),
        JSON.stringify(report.transcript),
        JSON.stringify(report.attachments),
        report.draft ? JSON.stringify(report.draft) : null,
        report.duplicateMatches.length
          ? JSON.stringify(report.duplicateMatches)
          : null,
        report.issueNumber,
        report.issueUrl,
        report.dryRun ? 1 : 0,
        report.updatedAt,
        report.id,
      );
  }

  countUserReportsSince(userId: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM reports
         WHERE user_id = ? AND created_at >= ? AND status != 'cancelled'`,
      )
      .get(userId, since) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
