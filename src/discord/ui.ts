import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { AppConfig } from "../config.js";
import type { Report } from "../types.js";
import { isEnhancement } from "../types.js";
import type { ComposedIssue } from "../github/issue.js";
import { truncate } from "../util/text.js";

export const PRIVACY_NOTICE =
  "I’ll help turn this into a GitHub issue. I’m an AI assistant; don’t share personal information, game files, or `.akpak` packs. A maintainer will read the issue, and the finished report will be public.";

export function draftEmbed(
  report: Report,
  issue: ComposedIssue,
  config: AppConfig,
): EmbedBuilder {
  const description = [
    `**${issue.title}**`,
    "",
    truncate(
      issue.body
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
      3600,
    ),
  ].join("\n");

  const footerParts = ["Nothing has been posted to GitHub yet."];
  if (report.dryRun) footerParts.push("Dry run.");
  if (config.behavior.approval_required) {
    footerParts.push("A maintainer will approve it first.");
  }

  return new EmbedBuilder()
    .setColor(report.dryRun ? 0xfaa61a : 0x57f287)
    .setTitle(isEnhancement(report.slots) ? "Draft enhancement" : "Draft bug report")
    .setDescription(description)
    .setFooter({ text: footerParts.join(" ") });
}

export function duplicateEmbed(report: Report): EmbedBuilder {
  const matches = report.duplicateMatches;
  const lines = matches.map((match) => {
    const confidence = Math.round(match.confidence * 100);
    return `**#${match.number}: ${match.title ?? "Untitled"}** (${match.state ?? "unknown"}, ${confidence}%)\n${match.reason || "Similar report."}`;
  });

  return new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle("This might already be reported")
    .setDescription(
      truncate(
        `${lines.join("\n\n")}\n\nIs your problem the same as one of these?`,
        3900,
      ),
    )
    .setFooter({
      text: "Picking one adds your details to the existing issue instead of opening a new one.",
    });
}

export function draftButtons(report: Report): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`file:${report.id}`)
      .setLabel(report.dryRun ? "Show what would be filed" : "File issue")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`edit:${report.id}`)
      .setLabel("Edit")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cancel:${report.id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );
}

export function duplicateButtons(report: Report): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const match of report.duplicateMatches.slice(0, 3)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`dup:${report.id}:${match.number}`)
        .setLabel(`#${match.number} ${Math.round(match.confidence * 100)}%`)
        .setStyle(ButtonStyle.Primary),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`dup-none:${report.id}`)
      .setLabel("None of these")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`dup-unsure:${report.id}`)
      .setLabel("Not sure")
      .setStyle(ButtonStyle.Secondary),
  );
  return row;
}

export function triageButtons(report: Report): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${report.id}`)
      .setLabel("Approve and file")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject:${report.id}`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
  );
}

export function editModal(report: Report): ModalBuilder {
  const titleInput = new TextInputBuilder()
    .setCustomId("title")
    .setLabel("Issue title")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(120)
    .setRequired(true)
    .setValue(report.draft?.title.slice(0, 120) ?? "");

  const bodyInput = new TextInputBuilder()
    .setCustomId("body")
    .setLabel("Issue body")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000)
    .setRequired(false)
    .setValue(report.draft?.body.slice(0, 4000) ?? "");

  return new ModalBuilder()
    .setCustomId(`edit-modal:${report.id}`)
    .setTitle("Edit draft")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(bodyInput),
    );
}

export function matchSummary(match: {
  number: number;
  confidence: number;
  reason: string;
}): string {
  return `#${match.number} (${Math.round(match.confidence * 100)}%): ${match.reason}`;
}
