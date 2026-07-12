import express from 'express';
import {
  AuditLogEvent,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { config } from './config.js';
import { createDatabase } from './database.js';
import { createCommandHandler } from './commands.js';

const db = createDatabase(config.databasePath, config.initialCaseNumber);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const app = express();
app.disable('x-powered-by');
app.get('/', (_request, response) => {
  response.json({
    ok: true,
    service: 'staff-action-ledger',
    discordReady: client.isReady(),
  });
});
app.get('/health', (_request, response) => {
  response.status(client.isReady() ? 200 : 503).json({
    ok: client.isReady(),
    service: 'staff-action-ledger',
    uptimeSeconds: Math.floor(process.uptime()),
  });
});
app.listen(config.port, '0.0.0.0', () => {
  console.log(`Health server listening on port ${config.port}.`);
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}. Prefix: ${config.prefix}`);
});

const handleMessage = createCommandHandler({ client, db, config });
client.on(Events.MessageCreate, async (message) => {
  try {
    await handleMessage(message);
  } catch (error) {
    console.error('Command handler failure:', error);
    try {
      await message.reply('The command failed unexpectedly. The error was written to the host console.');
    } catch {
      // Nothing else can be done here.
    }
  }
});

client.on(Events.MessageDelete, async (message) => {
  if (!message.guildId || message.author?.id !== client.user?.id) return;

  const guildConfig = db.getConfig(message.guildId);
  const protectedChannels = new Set([
    guildConfig.audit_channel_id,
    guildConfig.removed_channel_id,
    guildConfig.evidence_channel_id,
  ]);
  if (!protectedChannels.has(message.channelId)) return;

  let executorId = null;
  try {
    const guild = await client.guilds.fetch(message.guildId);
    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MessageDelete,
      limit: 5,
    });
    const recent = [...logs.entries.values()].find(
      (entry) =>
        entry.target?.id === client.user.id &&
        Date.now() - entry.createdTimestamp < 15_000,
    );
    executorId = recent?.executor?.id || null;
  } catch {
    // View Audit Log permission is optional. The event is still recorded.
  }

  const audit = db.appendAudit({
    guildId: message.guildId,
    eventType: 'PROTECTED_LOG_MESSAGE_DELETED',
    actorUserId: executorId || 'unknown',
    payload: {
      deletedChannelId: message.channelId,
      deletedMessageId: message.id,
      executorIdentified: Boolean(executorId),
    },
  });

  const channelIds = new Set([
    guildConfig.audit_channel_id,
    config.archiveChannelId,
  ]);
  for (const channelId of channelIds) {
    if (!channelId || channelId === message.channelId) continue;
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await channel.send(
          `A protected log message was deleted in <#${message.channelId}>. ` +
            `Executor: ${executorId ? `<@${executorId}>` : 'unknown'}. ` +
            `The database audit entry is #${audit.id}.`,
        );
      }
    } catch {
      // Database audit remains the source of truth.
    }
  }
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  try {
    client.destroy();
  } finally {
    db.close();
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

await client.login(config.token);
