import {
  AttachmentBuilder,
  ChannelType,
  type ButtonInteraction,
  type Client,
  type Guild,
  type ForumChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type ThreadChannel,
} from "discord.js";
import type { AppConfig } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type {
  GithubIssue,
  LlmTurn,
  Report,
  ReportAttachment,
  ReportSlots,
} from "../types.js";
import { SLOT_KEYS } from "../types.js";
import { ReportStore } from "../db.js";
import { GitHubClient, GitHubError } from "../github/client.js";
import type { AttachmentUploader } from "../github/attachments.js";
import {
  composeIssue,
  duplicateComment,
  issueLabels,
} from "../github/issue.js";
import { logger } from "../logger.js";
import { fallbackQuestion } from "../llm/prompts.js";
import {
  PRIVACY_NOTICE,
  draftButtons,
  draftEmbed,
  duplicateButtons,
  duplicateEmbed,
  editModal,
  triageButtons,
} from "./ui.js";
import {
  oneLine,
  parseQuickCommand,
  sanitizeIssueText,
  titleFromSummary,
  truncate,
} from "../util/text.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function isForbiddenAttachment(name: string): boolean {
  const lower = name.toLowerCase();
  return [
    ".akpak",
    ".pak",
    ".bin",
    ".iso",
    ".cue",
    ".exe",
    ".dll",
    ".zip",
    ".7z",
    ".rar",
  ].some((extension) => lower.endsWith(extension));
}

function attachmentKind(name: string, contentType: string): ReportAttachment["kind"] {
  const lower = name.toLowerCase();
  if (
    contentType.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp)$/i.test(lower)
  ) {
    return "screenshot";
  }
  if (
    /\.(sav|save|mcr|mcd|psu|vmp|vm2)$/i.test(lower) ||
    /save.*\.dat$/i.test(lower)
  ) {
    return "save";
  }
  return "file";
}

export class ReportFlow {
  private guild!: Guild;
  private channel!: ForumChannel | GuildTextBasedChannel;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly client: Client,
    private readonly config: AppConfig,
    private readonly store: ReportStore,
    private readonly llm: LlmProvider,
    private readonly github: GitHubClient,
    private readonly uploader?: AttachmentUploader,
  ) {}

  attach(guild: Guild, channel: ForumChannel | GuildTextBasedChannel): void {
    this.guild = guild;
    this.channel = channel;

    const quickRole = this.config.discord.quick_role_id
      ? guild.roles.cache.get(this.config.discord.quick_role_id)
      : guild.roles.cache.find(
          (role) =>
            role.name.toLowerCase() ===
            this.config.discord.quick_role_name.toLowerCase(),
        );
    if (quickRole) {
      logger.info(
        `Quick reports enabled for role ${quickRole.name} (${quickRole.id})`,
      );
    } else {
      logger.warn(
        `No role matching "${this.config.discord.quick_role_name}" found; \\quick will use the normal flow.`,
      );
    }
  }

  private async hasQuickRole(
    member: GuildMember | null,
    userId: string,
  ): Promise<boolean> {
    const roleId = this.config.discord.quick_role_id;
    const roleName = this.config.discord.quick_role_name.toLowerCase();
    const matches = (candidate: GuildMember | null): boolean =>
      Boolean(
        candidate?.roles.cache.some((role) =>
          roleId
            ? role.id === roleId
            : role.name.toLowerCase() === roleName,
        ),
      );

    if (matches(member)) return true;
    if (member) return false;
    const fetched = await this.guild.members
      .fetch(userId)
      .catch(() => null);
    return matches(fetched);
  }

  isMaintainer(userId: string): boolean {
    return (
      this.guild?.ownerId === userId ||
      this.config.discord.maintainer_user_ids.includes(userId)
    );
  }

  /**
   * Process messages that arrived while the bot was offline. Existing reports
   * are skipped by starter message, so restarts do not duplicate threads.
   */
  async catchUp(limit = 50): Promise<void> {
    if (!("messages" in this.channel)) return;

    const cutoff = Date.now() - DAY_MS;
    const messages = await this.channel.messages.fetch({ limit });
    const ordered = [...messages.values()].sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp,
    );

    for (const message of ordered) {
      if (message.author.bot || message.system) continue;
      if (message.createdTimestamp < cutoff) continue;
      if (message.thread) continue;
      if (this.store.getReportByStarterMessage(message.id)) continue;

      try {
        logger.info(`Catching up on message ${message.id}`);
        await this.handleMessage(message);
      } catch (error) {
        logger.error(
          `Catch-up failed for message ${message.id}`,
          String(error),
        );
      }
    }
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.locks.set(id, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === queued) this.locks.delete(id);
    }
  }

  /**
   * Discord typing indicators expire after about ten seconds. Keep one alive
   * for the whole LLM/upload turn instead of sending it once and going quiet.
   */
  private startTyping(channel: {
    sendTyping: () => Promise<unknown>;
  }): () => void {
    let stopped = false;
    const tick = (): void => {
      if (stopped) return;
      void channel.sendTyping().catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 7000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async handleThreadCreate(thread: ThreadChannel): Promise<void> {
    if (thread.parentId !== this.channel.id) return;
    if (thread.ownerId === this.client.user?.id) return;
    let starter = await thread.fetchStarterMessage().catch(() => null);
    for (let attempt = 0; !starter && attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      starter = await thread.fetchStarterMessage().catch(() => null);
    }
    if (!starter || starter.author.bot) return;
    await this.startReport(thread, starter);
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || message.system) return;

    if (message.channel.isThread()) {
      const report = this.store.getReportByThread(message.channelId);
      if (!report) return;
      if (report.starterMessageId === message.id) return;
      if (message.author.id !== report.userId && !this.isMaintainer(message.author.id)) {
        await message.reply({
          content: "Please let the reporter answer here, or open your own post in the bug channel.",
          allowedMentions: { parse: [] },
        });
        return;
      }
      await this.handleThreadMessage(report, message);
      return;
    }

    if (message.channelId !== this.channel.id) return;
    if (this.channel.type === ChannelType.GuildForum) return;

    const quickText = parseQuickCommand(message.content);
    if (quickText !== null) {
      if (await this.hasQuickRole(message.member, message.author.id)) {
        await this.handleQuickReport(message, quickText);
        return;
      }
      // Non-umbrella users go through the normal flow. Strip the command
      // prefix so the report starts with the actual description.
      await this.startTextReport(message, quickText || message.content);
      return;
    }

    await this.startTextReport(message);
  }

  private async startTextReport(
    message: Message,
    contentOverride?: string,
  ): Promise<void> {
    if (this.store.getReportByStarterMessage(message.id)) return;
    const nameSource =
      contentOverride?.trim() ||
      message.content ||
      message.attachments.first()?.name ||
      "Bug report";
    const thread = await message.startThread({
      name: truncate(titleFromSummary(nameSource), 90, "") || "Bug report",
      autoArchiveDuration: 1440,
      reason: "Arklay bug report",
    });
    await this.startReport(thread, message, contentOverride);
  }

  private async startReport(
    thread: ThreadChannel,
    starter: Message,
    contentOverride?: string,
  ): Promise<void> {
    if (this.store.getReportByThread(thread.id)) return;

    const recent = this.store.countUserReportsSince(
      starter.author.id,
      Date.now() - DAY_MS,
    );
    if (recent >= this.config.behavior.max_reports_per_user_per_day) {
      await thread.send({
        content:
          "You’ve reached the daily report limit. Please wait a bit, or add to the report you already opened.",
        allowedMentions: { parse: [] },
      });
      return;
    }

    const content = await this.collectMessageContent(starter, contentOverride);
    const report = this.store.createReport({
      threadId: thread.id,
      starterMessageId: starter.id,
      channelId: thread.parentId ?? thread.id,
      guildId: thread.guildId,
      userId: starter.author.id,
      userName: starter.author.username,
      dryRun: this.config.github.dry_run,
      initialMessage: content,
    });

    const attachmentNames = starter.attachments.map((attachment) => attachment.name);
    if (attachmentNames.length) {
      report.slots.attachments = attachmentNames.join(", ");
    }
    this.store.saveReport(report);
    await this.ingestAttachments(report, starter);

    await starter.react("👀").catch((error) => {
      logger.debug(`Could not add the eyes reaction: ${String(error)}`);
    });
    await this.applyTag(report, this.config.discord.needs_info_tag);
    const mention = `<@${starter.author.id}>`;
    const greeting = this.config.behavior.privacy_notice
      ? `${mention} ${PRIVACY_NOTICE}`
      : `${mention} Thanks, I’ll help turn this into a report.`;
    await thread.send({
      content: greeting,
      // Mention the reporter once so they get a notification for the new thread.
      allowedMentions: { users: [starter.author.id] },
    });

    await this.runTurn(report);
  }

  private async handleQuickReport(
    message: Message,
    text: string,
  ): Promise<void> {
    if (this.store.getReportByThread(message.id)) return;
    if (!text) {
      await message.reply({
        content:
          "Add the report after `\\quick`, for example: `\\quick No sound plays when changing page in a file.`",
        allowedMentions: { parse: [] },
      });
      return;
    }

    const stopTyping = message.channel.isSendable()
      ? this.startTyping(message.channel)
      : () => undefined;
    try {
    const content = await this.collectMessageContent(message, text);
    const report = this.store.createReport({
      threadId: message.id,
      starterMessageId: message.id,
      channelId: this.channel.id,
      guildId: message.guildId ?? this.guild.id,
      userId: message.author.id,
      userName: message.author.username,
      dryRun: this.config.github.dry_run,
      initialMessage: content,
    });
    const attachmentNames = message.attachments.map(
      (attachment) => attachment.name,
    );
    if (attachmentNames.length) {
      report.slots.attachments = attachmentNames.join(", ");
    }
    this.store.saveReport(report);
    await this.ingestAttachments(report, message);

    let turn: LlmTurn;
    try {
      turn = await this.llm.runTurn(report, 1, { quick: true });
    } catch (error) {
      logger.error(`Quick report failed for ${report.id}`, String(error));
      await message.react("❌").catch(() => undefined);
      await message.reply({
        content:
          "I couldn’t process that quick report. Please try again, or use the normal flow.",
        allowedMentions: { parse: [] },
      });
      return;
    }

    this.mergeSlots(report, turn.slots);
    if (!report.slots.summary.trim()) {
      report.slots.summary = text;
    }
    if (report.slots.summary.trim() !== text.trim()) {
      report.slots.notes = [
        report.slots.notes.trim(),
        `Original report: ${text}`,
      ]
        .filter(Boolean)
        .join("\n\n");
    }

    const issue = composeIssue(report, this.config, {
      quick: true,
      titleOverride: turn.title,
    });
    report.draft = issue;

    if (report.dryRun) {
      report.status = "filed";
      this.store.saveReport(report);
      await message.react("👍").catch(() => undefined);
      await message.reply({
        content: "**Dry run**: this is the issue I would create:",
        files: [
          new AttachmentBuilder(Buffer.from(issue.body, "utf8"), {
            name: "issue.md",
          }),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    try {
      const created = await this.github.createIssue({
        title: issue.title,
        body: issue.body,
        labels: issueLabels(this.config, report.slots),
      });
      report.status = "filed";
      report.issueNumber = created.number;
      report.issueUrl = created.htmlUrl;
      this.store.saveReport(report);
      await message.react("👍").catch(() => undefined);
      logger.info(`Quick-filed #${created.number}: ${created.htmlUrl}`);
    } catch (error) {
      logger.error(
        `Could not file quick report ${report.id}`,
        String(error),
      );
      await message.react("❌").catch(() => undefined);
      await message.reply({
        content: `I couldn’t file that quick report. ${truncate(String(error), 1200)}`,
        allowedMentions: { parse: [] },
      });
    }
    } finally {
      stopTyping();
    }
  }

  private async handleThreadMessage(report: Report, message: Message): Promise<void> {
    if (parseQuickCommand(message.content) !== null) {
      await message.reply({
        content: "Use `\\quick` in the bug channel, not inside a report thread.",
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (["filed", "duplicate", "cancelled"].includes(report.status)) {
      return;
    }
    if (report.status === "awaiting_approval") {
      await message.reply({
        content: "A maintainer is reviewing this draft. You’ll see the issue link here if it’s approved.",
        allowedMentions: { parse: [] },
      });
      return;
    }

    const content = await this.collectMessageContent(message);
    if (!content.trim()) return;

    if (report.status === "awaiting_confirmation") {
      if (/^(file|file it|submit|looks good|yes|ok)$/i.test(message.content.trim())) {
        await this.fileReport(report);
        return;
      }
      if (/^(cancel|stop|no)$/i.test(message.content.trim())) {
        await this.cancelReport(report);
        return;
      }
    }

    report.transcript.push({
      role: "user",
      content,
      at: Date.now(),
      userId: message.author.id,
      userName: message.author.username,
    });
    this.store.saveReport(report);
    await this.ingestAttachments(report, message);
    await this.runTurn(report);
  }

  private async runTurn(report: Report): Promise<void> {
    await this.withLock(report.id, async () => {
      const thread = await this.getThread(report);
      const stopTyping = this.startTyping(thread);

      try {
        const userTurns = report.transcript.filter((entry) => entry.role === "user").length;
        let turn: LlmTurn;
        try {
          turn = await this.llm.runTurn(report, this.config.behavior.max_user_turns);
        } catch (error) {
          logger.error(`LLM turn failed for report ${report.id}`, String(error));
          const question = fallbackQuestion(report.slots);
          if (question) {
            await this.sendAssistant(thread, report, question);
            return;
          }
          turn = {
            reply: "",
            slots: {},
            missing: [],
            ready: true,
            title: titleFromSummary(report.slots.summary),
          };
        }

        this.mergeSlots(report, turn.slots);

        const forceReady = userTurns >= this.config.behavior.max_user_turns;
        const lastUserMessage =
          report.transcript
            .filter((entry) => entry.role === "user")
            .at(-1)?.content ?? "";
        if (
          !report.slots.game.trim() &&
          /don'?t know|not sure|unsure|no idea/i.test(lastUserMessage)
        ) {
          report.slots.game = "Unknown";
          this.store.saveReport(report);
        }
        if (!report.slots.game.trim() && !forceReady) {
          turn.ready = false;
          turn.reply =
            "Which game is this for: RE1, RE2, RE3, or a third-party game pack?";
        }
        if (!turn.ready && !forceReady) {
          const reply =
            turn.reply.trim() ||
            fallbackQuestion(report.slots) ||
            "Can you tell me a little more about what happened?";
          await this.sendAssistant(thread, report, reply);
          return;
        }

        if (!report.slots.summary.trim()) {
          report.slots.summary = oneLine(
            turn.title ||
              report.transcript.find((entry) => entry.role === "user")?.content ||
              "Bug report",
          ).slice(0, 1000);
        }

        if (!forceReady && turn.reply.trim()) {
          await this.sendAssistant(thread, report, turn.reply);
        }

        if (report.duplicateMatches.length === 0) {
          await this.checkDuplicates(thread, report);
        } else {
          await this.showDraft(thread, report);
        }
      } finally {
        stopTyping();
      }
    });
  }

  private mergeSlots(report: Report, incoming: Partial<ReportSlots>): void {
    for (const key of SLOT_KEYS) {
      const value = incoming[key];
      if (value && value.trim()) {
        report.slots[key] = value.trim();
      }
    }
    this.store.saveReport(report);
  }

  private async checkDuplicates(thread: ThreadChannel, report: Report): Promise<void> {
    let issues: GithubIssue[] = [];
    try {
      issues = await this.github.listIssues(this.config.github.max_issues_for_dedupe);
    } catch (error) {
      logger.warn(
        `Could not fetch GitHub issues for ${report.id}: ${String(error)}`,
      );
    }

    const matches = await this.llm.findDuplicates(report, issues);
    report.duplicateMatches = matches;
    this.store.saveReport(report);

    if (matches.length === 0) {
      await this.showDraft(thread, report);
      return;
    }

    report.status = "awaiting_confirmation";
    report.transcript.push({
      role: "assistant",
      content: "I found possible duplicate issues and asked the reporter which one matches.",
      at: Date.now(),
    });
    this.store.saveReport(report);
    await thread.send({
      embeds: [duplicateEmbed(report)],
      components: [duplicateButtons(report)],
      allowedMentions: { parse: [] },
    });
  }

  private async showDraft(
    thread: ThreadChannel,
    report: Report,
    possiblyRelated: number[] = [],
    keepDraft = false,
  ): Promise<void> {
    const issue =
      keepDraft && report.draft
        ? report.draft
        : composeIssue(report, this.config, { possiblyRelated });
    report.draft = issue;
    report.status = "awaiting_confirmation";
    report.transcript.push({
      role: "assistant",
      content: "I showed the draft report and asked the reporter to file, edit, or cancel it.",
      at: Date.now(),
    });
    this.store.saveReport(report);
    await thread.send({
      embeds: [draftEmbed(report, issue, this.config)],
      components: [draftButtons(report)],
      allowedMentions: { parse: [] },
    });
  }

  private async sendAssistant(
    thread: ThreadChannel,
    report: Report,
    content: string,
  ): Promise<void> {
    report.transcript.push({
      role: "assistant",
      content,
      at: Date.now(),
    });
    this.store.saveReport(report);
    await thread.send({
      content: truncate(content, 1900),
      allowedMentions: { parse: [] },
    });
  }

  async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      await this.handleButton(interaction);
      return;
    }
    if (interaction.isModalSubmit()) {
      await this.handleModal(interaction);
    }
  }

  private async reportForInteraction(
    interaction: ButtonInteraction | ModalSubmitInteraction,
  ): Promise<Report | null> {
    const parts = interaction.customId.split(":");
    const reportId = parts[1];
    if (!reportId) return null;
    const report = this.store.getReport(reportId);
    if (!report) {
      await interaction.reply({
        content: "I can’t find that report anymore.",
        ephemeral: true,
      });
      return null;
    }
    if (
      interaction.user.id !== report.userId &&
      !this.isMaintainer(interaction.user.id)
    ) {
      await interaction.reply({
        content: "Only the reporter or a maintainer can do that.",
        ephemeral: true,
      });
      return null;
    }
    return report;
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const report = await this.reportForInteraction(interaction);
    if (!report) return;
    if (["filed", "duplicate", "cancelled"].includes(report.status)) {
      await interaction.reply({
        content: "This report is already closed.",
        ephemeral: true,
      });
      return;
    }
    const [action, , numberText] = interaction.customId.split(":");

    if (action === "edit") {
      await interaction.showModal(editModal(report));
      return;
    }

    await interaction.deferUpdate();

    if (action === "file") {
      await this.fileReport(report);
      return;
    }
    if (action === "cancel") {
      await this.cancelReport(report);
      return;
    }
    if (action === "dup" && numberText) {
      await this.linkDuplicate(report, Number(numberText));
      return;
    }
    if (action === "dup-none") {
      await this.showDraft(await this.getThread(report), report);
      return;
    }
    if (action === "dup-unsure") {
      const related = report.duplicateMatches.map((match) => match.number);
      await this.showDraft(await this.getThread(report), report, related);
      return;
    }
    if (action === "approve") {
      if (!this.isMaintainer(interaction.user.id)) {
        await interaction.followUp({
          content: "Only maintainers can approve reports.",
          ephemeral: true,
        });
        return;
      }
      if (report.status !== "awaiting_approval") return;
      await interaction.message.edit({ components: [] }).catch(() => undefined);
      await this.fileReport(report, { skipApproval: true });
      return;
    }
    if (action === "reject") {
      if (!this.isMaintainer(interaction.user.id)) {
        await interaction.followUp({
          content: "Only maintainers can reject reports.",
          ephemeral: true,
        });
        return;
      }
      report.status = "cancelled";
      this.store.saveReport(report);
      await interaction.message.edit({ components: [] }).catch(() => undefined);
      const thread = await this.getThread(report);
      await thread.send({
        content: "A maintainer chose not to file this draft. You can open a new report with more detail later.",
        allowedMentions: { parse: [] },
      });
    }
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.customId.startsWith("edit-modal:")) return;
    const report = await this.reportForInteraction(interaction);
    if (!report) return;
    const title = interaction.fields.getTextInputValue("title").trim();
    const body = interaction.fields.getTextInputValue("body").trim();
    report.draft = {
      title: truncate(title || "Bug report", 120, ""),
      body: body || report.draft?.body || "",
    };
    report.status = "awaiting_confirmation";
    this.store.saveReport(report);
    await interaction.deferUpdate();
    await this.showDraft(await this.getThread(report), report, [], true);
  }

  private async fileReport(
    report: Report,
    options: { skipApproval?: boolean } = {},
  ): Promise<void> {
    await this.withLock(report.id, async () => {
      const thread = await this.getThread(report);
      if (this.config.behavior.approval_required && !options.skipApproval) {
        if (report.status !== "awaiting_approval") {
          try {
            await this.postForApproval(report);
          } catch (error) {
            logger.error(
              `Could not post ${report.id} for approval`,
              String(error),
            );
            await thread.send({
              content:
                "I couldn’t send this draft to the approval channel. A maintainer needs to check the bot configuration.",
              allowedMentions: { parse: [] },
            });
          }
        }
        return;
      }

      const issue = report.draft ?? composeIssue(report, this.config);
      report.draft = issue;

      if (report.dryRun) {
        report.status = "filed";
        this.store.saveReport(report);
        await this.applyTag(report, this.config.discord.filed_tag);
        await thread.send({
          content: "**Dry run**: this is the issue I would create:",
          files: [
            new AttachmentBuilder(Buffer.from(issue.body, "utf8"), {
              name: "issue.md",
            }),
          ],
          allowedMentions: { parse: [] },
        });
        return;
      }

      try {
        const created = await this.github.createIssue({
          title: issue.title,
          body: issue.body,
          labels: issueLabels(this.config, report.slots),
        });
        report.status = "filed";
        report.issueNumber = created.number;
        report.issueUrl = created.htmlUrl;
        this.store.saveReport(report);
        await this.applyTag(report, this.config.discord.filed_tag);
        await thread
          .setName(truncate(issue.title, 100, ""))
          .catch(() => undefined);
        await thread.send({
          content: `Filed: ${created.htmlUrl}`,
          allowedMentions: { parse: [] },
        });
        if (this.config.behavior.archive_after_file) {
          setTimeout(() => {
            thread.setArchived(true).catch(() => undefined);
          }, 5000);
        }
      } catch (error) {
        logger.error(`Could not create issue for ${report.id}`, String(error));
        const detail =
          error instanceof GitHubError
            ? `${error.message}`
            : "GitHub rejected the request.";
        await thread.send({
          content: `I couldn’t file the issue. ${truncate(detail, 1200)}`,
          allowedMentions: { parse: [] },
        });
      }
    });
  }

  private async postForApproval(report: Report): Promise<void> {
    const channelId = this.config.discord.triage_channel_id;
    if (!channelId) {
      throw new Error(
        "approval_required is true but discord.triage_channel_id is empty",
      );
    }
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isSendable() || channel.isThread()) {
      throw new Error("The configured triage channel is not a sendable text channel");
    }
    const issue = report.draft ?? composeIssue(report, this.config);
    report.draft = issue;
    report.status = "awaiting_approval";
    this.store.saveReport(report);
    await channel.send({
      content: `Report ${report.id} from <@${report.userId}> in <#${report.threadId}> needs approval.`,
      embeds: [draftEmbed(report, issue, this.config)],
      components: [triageButtons(report)],
      allowedMentions: { parse: [] },
    });
    const thread = await this.getThread(report);
    await thread.send({
      content: "A maintainer will review this draft before it is filed.",
      allowedMentions: { parse: [] },
    });
  }

  private async linkDuplicate(report: Report, number: number): Promise<void> {
    const thread = await this.getThread(report);
    if (!Number.isInteger(number) || number <= 0) return;

    if (report.dryRun) {
      report.status = "duplicate";
      this.store.saveReport(report);
      await this.applyTag(report, this.config.discord.duplicate_tag);
      await thread.send({
        content: `**Dry run**: this matches #${number}. I would add the details there instead of opening a new issue.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    try {
      const issue = await this.github.getIssue(number);
      await this.github.addReaction(number).catch(() => undefined);
      await this.github
        .commentIssue(number, duplicateComment(report))
        .catch((error) => logger.warn(`Could not comment on #${number}`, String(error)));
      report.status = "duplicate";
      report.issueNumber = number;
      report.issueUrl = issue.htmlUrl;
      this.store.saveReport(report);
      await this.applyTag(report, this.config.discord.duplicate_tag);
      await thread.send({
        content: `Linked to ${issue.htmlUrl}. I added the details from this report there instead of opening a new issue.`,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      logger.error(`Could not link duplicate #${number}`, String(error));
      await thread.send({
        content: `I couldn’t update #${number}. A maintainer can link it manually.`,
        allowedMentions: { parse: [] },
      });
    }
  }

  private async cancelReport(report: Report): Promise<void> {
    report.status = "cancelled";
    this.store.saveReport(report);
    const thread = await this.getThread(report);
    await thread.send({
      content: "Okay, I won’t file it. Open a new post if you want to try again.",
      allowedMentions: { parse: [] },
    });
  }

  private async getThread(report: Report): Promise<ThreadChannel> {
    const channel = await this.client.channels.fetch(report.threadId);
    if (!channel || !channel.isThread()) {
      throw new Error(`Report thread ${report.threadId} is not a thread`);
    }
    if (channel.archived) {
      await channel.setArchived(false).catch(() => undefined);
    }
    return channel;
  }

  private async applyTag(report: Report, tagName: string): Promise<void> {
    if (!tagName) return;
    try {
      const thread = await this.getThread(report);
      const parent = thread.parent;
      if (!parent || parent.type !== ChannelType.GuildForum) return;
      const forum = parent as ForumChannel;
      const tag = forum.availableTags.find((item) => item.name === tagName);
      if (!tag) return;
      const statusNames = new Set([
        this.config.discord.needs_info_tag,
        this.config.discord.filed_tag,
        this.config.discord.duplicate_tag,
      ]);
      const kept = thread.appliedTags.filter((id) => {
        const current = forum.availableTags.find((item) => item.id === id);
        return !current || !statusNames.has(current.name);
      });
      await thread.setAppliedTags([...kept, tag.id].slice(0, 5));
    } catch (error) {
      logger.debug(`Could not apply tag ${tagName}: ${String(error)}`);
    }
  }

  private async ingestAttachments(
    report: Report,
    message: Message,
  ): Promise<void> {
    for (const attachment of message.attachments.values()) {
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        logger.debug(`Skipping oversized attachment ${attachment.name}`);
        continue;
      }
      if (isForbiddenAttachment(attachment.name)) continue;
      if (
        report.attachments.some(
          (existing) => existing.discordUrl === attachment.url,
        )
      ) {
        continue;
      }

      const contentType = attachment.contentType ?? "";
      const isText =
        contentType.startsWith("text/") ||
        contentType === "application/json" ||
        /\.(log|txt|json|toml|ya?ml|ini|cfg|md|csv)$/i.test(attachment.name);
      if (isText) continue;

      let buffer: Buffer;
      try {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          logger.warn(
            `Could not download attachment ${attachment.name}: ${response.status}`,
          );
          continue;
        }
        buffer = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        logger.warn(
          `Could not download attachment ${attachment.name}`,
          String(error),
        );
        continue;
      }

      let url = "";
      if (this.uploader) {
        try {
          url = await this.uploader.upload(
            buffer,
            attachment.name,
            contentType || "application/octet-stream",
            report.id,
          );
        } catch (error) {
          logger.warn(
            `Could not upload attachment ${attachment.name} to GitHub`,
            String(error),
          );
        }
      }

      report.attachments.push({
        kind: attachmentKind(attachment.name, contentType),
        name: attachment.name,
        url,
        discordUrl: attachment.url,
        contentType,
        size: attachment.size,
      });
    }
    this.store.saveReport(report);
  }

  private async collectMessageContent(
    message: Message,
    textOverride?: string,
  ): Promise<string> {
    const parts: string[] = [];
    const text = textOverride ?? message.content;
    if (text.trim()) parts.push(text.trim());

    for (const attachment of message.attachments.values()) {
      const name = attachment.name;
      const lower = name.toLowerCase();
      if (
        lower.endsWith(".akpak") ||
        lower.endsWith(".pak") ||
        lower.endsWith(".bin") ||
        lower.endsWith(".iso") ||
        lower.endsWith(".cue") ||
        lower.endsWith(".exe") ||
        lower.endsWith(".dll") ||
        lower.endsWith(".zip") ||
        lower.endsWith(".7z") ||
        lower.endsWith(".rar")
      ) {
        parts.push(`[Ignored game file: ${name}]`);
        continue;
      }

      const isText =
        attachment.contentType?.startsWith("text/") ||
        attachment.contentType === "application/json" ||
        /\.(log|txt|json|toml|ya?ml|ini|cfg|md|csv)$/i.test(name);

      if (isText && attachment.size <= 2_000_000) {
        try {
          const response = await fetch(attachment.url);
          if (response.ok) {
            const text = await response.text();
            parts.push(
              `[Attached file: ${name}]\n${truncate(sanitizeIssueText(text, 12000), 12000)}`,
            );
            continue;
          }
        } catch (error) {
          logger.debug(`Could not download attachment ${name}`, String(error));
        }
      }

      parts.push(
        `[Attachment: ${name}${attachment.contentType ? `, ${attachment.contentType}` : ""}, ${attachment.size} bytes]`,
      );
    }

    return truncate(parts.join("\n\n"), 24000);
  }
}
