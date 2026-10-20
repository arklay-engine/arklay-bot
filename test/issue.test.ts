import { describe, expect, it } from "vitest";
import { composeIssue, issueLabels } from "../src/github/issue.js";
import type { AppConfig } from "../src/config.js";
import { emptySlots, type Report } from "../src/types.js";

const config = {
  github: {
    repo: "IntelOrca/arklay-rs",
    dry_run: true,
    labels: ["from-discord"],
    bug_label: "bug",
    enhancement_label: "enhancement",
    include_reporter: false,
    include_thread_link: true,
  },
} as AppConfig;

function report(): Report {
  const slots = emptySlots();
  slots.summary = "Game crashes when entering the save room.";
  slots.game = "RE1";
  slots.release = "Steam";
  slots.version = "0.1.0 (c0b288a)";
  slots.os = "Windows 11";
  slots.steps = "Load the save and walk into the save room.";
  slots.expected = "The save room opens.";
  slots.actual = "The game closes immediately.";
  slots.logs = "thread 'main' panicked at src/room.rs:42";
  return {
    id: "report-1",
    threadId: "thread-1",
    starterMessageId: "message-1",
    channelId: "channel-1",
    guildId: "guild-1",
    userId: "user-1",
    userName: "tester",
    status: "collecting",
    slots,
    transcript: [],
    attachments: [],
    draft: null,
    duplicateMatches: [],
    issueNumber: null,
    issueUrl: null,
    dryRun: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("composeIssue", () => {
  it("uses the repo's terse section style", () => {
    const issue = composeIssue(report(), config);
    expect(issue.title).toBe("Game crashes when entering the save room");
    expect(issue.body).toContain("### Summary");
    expect(issue.body).toContain("- Game: RE1");
    expect(issue.body).toContain("- Release: Steam");
    expect(issue.body).toContain("### Steps to reproduce");
    expect(issue.body).toContain("<details>");
    expect(issue.body).toContain("Discord thread:");
    expect(issue.body).toContain("<!-- arklay-bot-report: report-1 -->");
  });

  it("does not include the reporter by default", () => {
    expect(composeIssue(report(), config).body).not.toContain("Reported by");
  });

  it("renders enhancements with a proposed behavior section", () => {
    const enhancement = report();
    enhancement.slots = {
      ...emptySlots(),
      report_type: "enhancement",
      area: "enhancement",
      summary: "Add widescreen support.",
      game: "RE1",
      expected: "Allow 16:9 with the inventory relaid out.",
      notes: "The current crop cuts off the item box.",
    };
    const issue = composeIssue(enhancement, config);
    expect(issue.body).toContain("### Proposed behavior");
    expect(issue.body).toContain("### Why");
    expect(issue.body).not.toContain("### Actual behavior");
    expect(issue.body).not.toContain("### Logs");
    expect(issueLabels(config, enhancement.slots)).toEqual([
      "from-discord",
      "enhancement",
    ]);
  });

  it("labels bugs separately from enhancements", () => {
    expect(issueLabels(config, report().slots)).toEqual([
      "from-discord",
      "bug",
    ]);
  });

  it("includes uploaded screenshots and save files", () => {
    const withAttachments = report();
    withAttachments.attachments = [
      {
        kind: "screenshot",
        name: "glitch.png",
        url: "https://github.com/user-attachments/assets/123",
        discordUrl: "https://cdn.discordapp.com/attachments/1/2/glitch.png",
        contentType: "image/png",
        size: 100,
      },
      {
        kind: "save",
        name: "savedat1.dat",
        url: "https://github.com/user-attachments/assets/456",
        discordUrl: "https://cdn.discordapp.com/attachments/1/2/savedat1.dat",
        contentType: "application/octet-stream",
        size: 100,
      },
    ];
    const issue = composeIssue(withAttachments, config);
    expect(issue.body).toContain("![glitch.png](https://github.com/user-attachments/assets/123)");
    expect(issue.body).toContain("[savedat1.dat](https://github.com/user-attachments/assets/456)");
  });

  it("keeps quick reports terse and links the source message", () => {
    const quick = report();
    quick.slots = {
      ...emptySlots(),
      summary: "No sound plays when changing page in a file.",
      actual: "No sound plays when changing page in a file",
    };
    const issue = composeIssue(quick, config, { quick: true });
    expect(issue.title).toBe("No sound plays when changing page in a file");
    expect(issue.body).not.toContain("### Environment");
    expect(issue.body).not.toContain("### Actual behavior");
    expect(issue.body).not.toContain("Not provided");
    expect(issue.body).toContain("Quick report via Discord.");
    expect(issue.body).toContain("Discord message:");
  });
});
