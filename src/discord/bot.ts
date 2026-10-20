import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type Guild,
  type ForumChannel,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
} from "discord.js";
import type { AppConfig } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ReportStore } from "../db.js";
import type { GitHubClient } from "../github/client.js";
import type { AttachmentUploader } from "../github/attachments.js";
import { logger } from "../logger.js";
import { ReportFlow } from "./flow.js";

function isSupportedChannel(
  channel: { type: ChannelType },
): channel is ForumChannel | GuildTextBasedChannel {
  return (
    channel.type === ChannelType.GuildForum ||
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement
  );
}

async function resolveGuild(client: Client, config: AppConfig): Promise<Guild> {
  if (config.discord.guild_id) {
    return client.guilds.fetch(config.discord.guild_id);
  }
  const guild = client.guilds.cache.first();
  if (!guild) {
    throw new Error(
      "The bot is not in any guild. Invite it to your Discord server first.",
    );
  }
  return guild;
}

async function resolveChannel(
  guild: Guild,
  config: AppConfig,
): Promise<ForumChannel | GuildTextBasedChannel> {
  if (config.discord.channel_id) {
    const channel = await guild.channels.fetch(config.discord.channel_id);
    if (!channel || !isSupportedChannel(channel)) {
      throw new Error(
        `Channel ${config.discord.channel_id} is not a text or forum channel`,
      );
    }
    return channel;
  }

  await guild.channels.fetch().catch(() => undefined);
  const channel = guild.channels.cache.find(
    (item) =>
      item.name === config.discord.channel_name && isSupportedChannel(item),
  );
  if (!channel || !isSupportedChannel(channel)) {
    throw new Error(
      `Could not find a text or forum channel named #${config.discord.channel_name}. ` +
        `Create it, or set discord.channel_id in config.toml.`,
    );
  }
  return channel;
}

function logPermissionWarnings(
  client: Client,
  channel: ForumChannel | GuildTextBasedChannel,
): void {
  const me = client.user;
  if (!me) return;
  const permissions = channel.permissionsFor(me);
  if (!permissions) return;

  const required: Array<[bigint, string]> = [
    [PermissionFlagsBits.ViewChannel, "View Channels"],
    [PermissionFlagsBits.SendMessages, "Send Messages"],
    [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
    [PermissionFlagsBits.AttachFiles, "Attach Files"],
  ];
  if (channel.type === ChannelType.GuildForum) {
    required.push(
      [PermissionFlagsBits.SendMessagesInThreads, "Send Messages in Threads"],
      [PermissionFlagsBits.ManageThreads, "Manage Threads"],
    );
  } else {
    required.push(
      [PermissionFlagsBits.CreatePublicThreads, "Create Public Threads"],
      [PermissionFlagsBits.SendMessagesInThreads, "Send Messages in Threads"],
    );
  }

  const missing = required
    .filter(([flag]) => !permissions.has(flag))
    .map(([, name]) => name);
  if (missing.length) {
    logger.warn(`Missing channel permissions: ${missing.join(", ")}`);
  }
}

async function reportError(
  interaction: Interaction,
  error: unknown,
): Promise<void> {
  logger.error("Interaction failed", String(error));
  if (
    interaction.isRepliable() &&
    !interaction.replied &&
    !interaction.deferred
  ) {
    await interaction
      .reply({
        content: "Something went wrong while handling that. A maintainer can check the bot logs.",
        ephemeral: true,
      })
      .catch(() => undefined);
  }
}

export async function startBot(
  config: AppConfig,
  store: ReportStore,
  llm: LlmProvider,
  github: GitHubClient,
  uploader?: AttachmentUploader,
): Promise<Client> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error(
      "DISCORD_TOKEN is not set. Create a bot at https://discord.com/developers/applications and add the token to .env.",
    );
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  const flow = new ReportFlow(client, config, store, llm, github, uploader);

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      const guild = await resolveGuild(readyClient, config);
      const channel = await resolveChannel(guild, config);
      flow.attach(guild, channel);
      logPermissionWarnings(readyClient, channel);

      readyClient.user.setPresence({
        status: "online",
        activities: [
          {
            name: config.discord.channel_name.startsWith("#")
              ? config.discord.channel_name
              : `#${config.discord.channel_name}`,
            type: ActivityType.Watching,
          },
        ],
      });

      logger.info(
        `Ready as ${readyClient.user.tag} in ${guild.name} (#${channel.name}, ${channel.id})`,
      );
      logger.info(
        `Mode: ${config.github.dry_run ? "DRY RUN" : "LIVE"}; ` +
          `approval=${config.behavior.approval_required ? "required" : "off"}; ` +
          `repo=${config.github.repo}`,
      );
      if (channel.type === ChannelType.GuildForum) {
        logger.info("Listening for new forum posts.");
      } else {
        logger.info("Listening for new messages in the text channel.");
      }
    } catch (error) {
      logger.error("Startup failed", String(error));
      await client.destroy();
      process.exitCode = 1;
    }
  });

  client.on(Events.ThreadCreate, (thread) => {
    flow.handleThreadCreate(thread).catch((error) => {
      logger.error(`Thread handling failed (${thread.id})`, String(error));
    });
  });

  client.on(Events.MessageCreate, (message: Message) => {
    flow.handleMessage(message).catch((error) => {
      logger.error(
        `Message handling failed (${message.id}, ${message.channelId})`,
        String(error),
      );
      if (message.channel.isTextBased() && "send" in message.channel) {
        message.channel
          .send({
            content:
              "Something went wrong while handling that message. A maintainer can check the bot logs.",
            allowedMentions: { parse: [] },
          })
          .catch(() => undefined);
      }
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    flow.handleInteraction(interaction).catch((error) =>
      reportError(interaction, error),
    );
  });

  client.on(Events.Error, (error) => logger.error("Discord error", String(error)));
  client.on(Events.Warn, (message) => logger.warn("Discord warning", message));

  await client.login(token);
  return client;
}
