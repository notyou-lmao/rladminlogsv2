import fs from 'node:fs';
import path from 'node:path';
import {
  AttachmentBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import {
  ACTION_ALIASES,
  ACTION_LABELS,
  csvEscape,
  discordTimestamp,
  normalizeCaseNumber,
  parseChannelId,
  parseUserId,
  splitPipeArguments,
  truncate,
} from './utils.js';
import {
  buildAuditEmbed,
  buildCaseEmbed,
  buildCaseListEmbeds,
  buildUserActionDmEmbed,
  buildCompactAuditList,
  buildCompactRemovedList,
  buildRemovedEmbed,
} from './embeds.js';
import {
  mirrorEvidence,
  removeSavedEvidence,
  saveEvidence,
} from './evidence.js';

const ACCESS_WEIGHT = {
  none: 0,
  hr: 1,
  admin: 2,
  owner: 3,
};

function getAccessLevel(message, db, ownerUserIds) {
  if (ownerUserIds.has(message.author.id)) return 'owner';
  return db.getAccess(message.guild.id, message.author.id) || 'none';
}

function hasAccess(level, minimum) {
  return ACCESS_WEIGHT[level] >= ACCESS_WEIGHT[minimum];
}

async function sendError(message, text) {
  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Could Not Complete Command')
        .setDescription(text),
    ],
  });
}

async function fetchTextChannel(client, channelId) {
  if (!channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    return channel?.isTextBased() ? channel : null;
  } catch {
    return null;
  }
}

async function mirrorAudit({ client, config, guildConfig, auditRow, embeds = [] }) {
  const auditEmbed = buildAuditEmbed(auditRow);
  const payload = { embeds: [...embeds, auditEmbed].slice(0, 10) };
  const channelIds = new Set(
    [guildConfig.audit_channel_id, config.archiveChannelId].filter(Boolean),
  );
  const failures = [];

  for (const channelId of channelIds) {
    const channel = await fetchTextChannel(client, channelId);
    if (!channel) {
      failures.push(channelId);
      continue;
    }
    try {
      await channel.send(payload);
    } catch {
      failures.push(channelId);
    }
  }

  return failures;
}

async function sendCaseNotificationDm({
  client,
  caseRecord,
  guildName,
  evidenceDirectory,
}) {
  const storedPath = path.join(
    evidenceDirectory,
    caseRecord.evidence_stored_name,
  );

  const extension = path.extname(caseRecord.evidence_original_name || '');
  const evidenceFileName = `case-${caseRecord.case_number}-evidence${extension}`;
  const files = fs.existsSync(storedPath)
    ? [new AttachmentBuilder(storedPath, { name: evidenceFileName })]
    : [];

  if (files.length === 0) {
    return {
      delivered: false,
      error: 'The locally stored evidence file could not be found.',
    };
  }

  try {
    const staffUser = await client.users.fetch(caseRecord.staff_user_id);
    await staffUser.send({
      embeds: [
        buildUserActionDmEmbed(caseRecord, guildName, evidenceFileName),
      ],
      files,
    });
    return { delivered: true, error: null };
  } catch (error) {
    return {
      delivered: false,
      error: error?.message || 'Discord rejected the direct message.',
    };
  }
}

async function ensureConfigured(message, guildConfig) {
  const missing = [];
  if (!guildConfig.command_channel_id) missing.push('command channel');
  if (!guildConfig.audit_channel_id) missing.push('audit channel');
  if (!guildConfig.removed_channel_id) missing.push('removed actions channel');
  if (!guildConfig.evidence_channel_id) missing.push('evidence channel');

  if (missing.length) {
    await sendError(
      message,
      `The bot is not fully configured. Missing: ${missing.join(', ')}. An owner or admin must run \`.admin setup #commands #audit #removed #evidence\`.`,
    );
    return false;
  }
  return true;
}

async function ensureCommandChannel(message, guildConfig) {
  if (
    guildConfig.command_channel_id &&
    message.channel.id !== guildConfig.command_channel_id
  ) {
    await sendError(
      message,
      `Administrative commands are restricted to <#${guildConfig.command_channel_id}>.`,
    );
    return false;
  }
  return true;
}

function helpEmbeds(prefix) {
  const main = new EmbedBuilder()
    .setTitle('Staff Action Ledger Help Guide')
    .setDescription(
      'This bot creates permanent, tamper-evident staff disciplinary records. Every new disciplinary case requires a reason and one attached image or video.',
    )
    .addFields(
      {
        name: 'Create Cases',
        value: [
          `\`${prefix} warning @user <reason>\``,
          `\`${prefix} strike @user <reason>\``,
          `\`${prefix} suspension @user <duration> | <reason>\``,
          `\`${prefix} demotion @user <old rank> | <new rank> | <reason>\``,
          `\`${prefix} fired @user <reason>\``,
          '',
          '**Attach one image or video to the same message.**',
        ].join('\n'),
      },
      {
        name: 'Read Cases',
        value: [
          `\`${prefix} case 133\` full case, issuer, date, action, reason, and proof`,
          `\`${prefix} cases @user\` active case history`,
          `\`${prefix} cases @user all\` includes removed actions`,
          `\`${prefix} stats @user\` action totals`,
          `\`${prefix} export @user all\` csv export`,
        ].join('\n'),
      },
      {
        name: 'Correct or Remove Records',
        value: [
          `\`${prefix} amend 133 <correction note>\` appends a note without editing history`,
          `\`${prefix} remove 133 <reason>\` voids a case without deleting it`,
        ].join('\n'),
      },
    );

  const admin = new EmbedBuilder()
    .setTitle('Administrative Setup and Audit Commands')
    .addFields(
      {
        name: 'Initial Setup',
        value: `\`${prefix} setup #hr-commands #audit-log #removed-actions #case-evidence\``,
      },
      {
        name: 'Whitelist',
        value: [
          `\`${prefix} whitelist add @user hr\``,
          `\`${prefix} whitelist add @user admin\``,
          `\`${prefix} whitelist remove @user\``,
          `\`${prefix} whitelist list\``,
        ].join('\n'),
      },
      {
        name: 'Audit Ledger',
        value: [
          `\`${prefix} audit recent 10\``,
          `\`${prefix} audit verify\``,
          `\`${prefix} removed 10\``,
          `\`${prefix} status\``,
        ].join('\n'),
      },
      {
        name: 'Access Levels',
        value:
          '**HR** can create, read, amend, export, and view cases.\n**Admin** can also configure channels, manage the whitelist, remove cases, and verify the audit chain.\n**Owner IDs** are configured in the hosting environment and cannot be locked out by the Discord whitelist.',
      },
    );

  return [main, admin];
}

function commandsEmbed(prefix) {
  return new EmbedBuilder()
    .setTitle('Command List')
    .setDescription(
      [
        `\`${prefix} help\``,
        `\`${prefix} commands\``,
        `\`${prefix} warning\`, \`${prefix} strike\`, \`${prefix} suspension\`, \`${prefix} demotion\`, \`${prefix} fired\``,
        `\`${prefix} case\`, \`${prefix} cases\`, \`${prefix} stats\`, \`${prefix} export\``,
        `\`${prefix} amend\`, \`${prefix} remove\``,
        `\`${prefix} whitelist\`, \`${prefix} setup\``,
        `\`${prefix} audit\`, \`${prefix} removed\`, \`${prefix} status\``,
      ].join('\n'),
    )
    .setFooter({ text: `Run ${prefix} help for syntax and examples.` });
}

function parseActionInput(actionType, raw) {
  const firstSpace = raw.indexOf(' ');
  if (firstSpace < 0) return null;

  const targetToken = raw.slice(0, firstSpace).trim();
  const staffUserId = parseUserId(targetToken);
  const details = raw.slice(firstSpace + 1).trim();
  if (!staffUserId || !details) return null;

  if (actionType === 'suspension') {
    const parts = splitPipeArguments(details, 2);
    if (!parts) return null;
    return { staffUserId, duration: parts[0], reason: parts[1] };
  }

  if (actionType === 'demotion') {
    const parts = splitPipeArguments(details, 3);
    if (!parts) return null;
    return {
      staffUserId,
      previousRank: parts[0],
      newRank: parts[1],
      reason: parts[2],
    };
  }

  return { staffUserId, reason: details };
}

function actionUsage(prefix, actionType) {
  if (actionType === 'suspension') {
    return `Use \`${prefix} suspension @user <duration> | <reason>\` and attach an image or video.`;
  }
  if (actionType === 'demotion') {
    return `Use \`${prefix} demotion @user <old rank> | <new rank> | <reason>\` and attach an image or video.`;
  }
  return `Use \`${prefix} ${actionType} @user <reason>\` and attach an image or video.`;
}

async function handleCreateCase({
  message,
  actionType,
  rawArguments,
  client,
  db,
  config,
  guildConfig,
}) {
  const parsed = parseActionInput(actionType, rawArguments);
  if (!parsed) {
    await sendError(message, actionUsage(config.prefix, actionType));
    return;
  }

  if (parsed.staffUserId === message.author.id) {
    await sendError(message, 'You cannot issue an administrative case to yourself.');
    return;
  }

  const mediaAttachments = [...message.attachments.values()].filter(
    (attachment) =>
      attachment.contentType?.startsWith('image/') ||
      attachment.contentType?.startsWith('video/') ||
      /\.(png|jpe?g|gif|webp|bmp|mp4|mov|webm|m4v)$/i.test(attachment.name || ''),
  );

  if (mediaAttachments.length === 0) {
    await sendError(
      message,
      'This action was not logged. Every disciplinary case requires one attached photo or video as evidence.',
    );
    return;
  }

  if (mediaAttachments.length > 1) {
    await sendError(
      message,
      'Please attach exactly one evidence file per case so the proof stays clearly tied to that case.',
    );
    return;
  }

  let savedEvidence = null;
  try {
    savedEvidence = await saveEvidence(
      mediaAttachments[0],
      config.evidenceDirectory,
      config.maxEvidenceBytes,
    );

    const created = db.createCase({
      guildId: message.guild.id,
      staffUserId: parsed.staffUserId,
      actionType,
      reason: parsed.reason,
      duration: parsed.duration,
      previousRank: parsed.previousRank,
      newRank: parsed.newRank,
      actorUserId: message.author.id,
      evidence: savedEvidence,
    });

    let mirrorWarning = null;
    try {
      const mirrored = await mirrorEvidence({
        client,
        channelId: guildConfig.evidence_channel_id,
        caseRecord: created.case,
        evidenceDirectory: config.evidenceDirectory,
      });
      db.setEvidenceMirror({
        guildId: message.guild.id,
        caseNumber: created.case.case_number,
        messageUrl: mirrored.messageUrl,
        attachmentUrl: mirrored.attachmentUrl,
        actorUserId: message.author.id,
      });
    } catch (error) {
      mirrorWarning = error.message;
    }

    const fullCase = db.getCase(message.guild.id, created.case.case_number);
    const failures = await mirrorAudit({
      client,
      config,
      guildConfig,
      auditRow: created.audit,
      embeds: [buildCaseEmbed(fullCase)],
    });

    const dmResult = await sendCaseNotificationDm({
      client,
      caseRecord: fullCase,
      guildName: message.guild.name,
      evidenceDirectory: config.evidenceDirectory,
    });

    const dmAudit = db.appendAudit({
      guildId: message.guild.id,
      eventType: dmResult.delivered ? 'CASE_DM_DELIVERED' : 'CASE_DM_FAILED',
      actorUserId: message.author.id,
      targetUserId: parsed.staffUserId,
      caseNumber: fullCase.case_number,
      payload: dmResult.delivered
        ? { deliveryMethod: 'direct_message' }
        : {
            deliveryMethod: 'direct_message',
            error: truncate(dmResult.error, 500),
          },
    });
    const dmAuditFailures = await mirrorAudit({
      client,
      config,
      guildConfig,
      auditRow: dmAudit,
    });

    try {
      await message.delete();
    } catch {
      // The case is already stored. Failure to clean up the command is harmless.
    }

    const notes = [];
    if (mirrorWarning) notes.push(`Evidence channel mirror warning: ${mirrorWarning}`);
    if (failures.length || dmAuditFailures.length) {
      notes.push('One or more audit mirror channels could not be reached.');
    }
    notes.push(
      dmResult.delivered
        ? 'The staff member was notified by direct message.'
        : `The staff member could not be notified by direct message: ${truncate(dmResult.error, 300)}`,
    );

    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Case #${fullCase.case_number} Logged`)
          .setDescription(
            `${ACTION_LABELS[actionType]} was issued to <@${parsed.staffUserId}> by <@${message.author.id}>.`,
          )
          .addFields(
            { name: 'Date and Time', value: discordTimestamp(fullCase.created_at) },
            { name: 'Reason', value: truncate(fullCase.reason, 1024) },
            ...(notes.length
              ? [{ name: 'Storage Notice', value: notes.join('\n') }]
              : []),
          )
          .setFooter({ text: `View with ${config.prefix} case ${fullCase.case_number}` }),
      ],
    });
  } catch (error) {
    if (savedEvidence?.storedPath) removeSavedEvidence(savedEvidence.storedPath);
    await sendError(message, `The case could not be stored: ${error.message}`);
  }
}

function buildStatsEmbed(cases, staffUserId) {
  const counts = Object.fromEntries(Object.keys(ACTION_LABELS).map((key) => [key, 0]));
  for (const item of cases) counts[item.action_type] += 1;

  return new EmbedBuilder()
    .setTitle(`Case Statistics for <@${staffUserId}>`)
    .setDescription(`Total preserved cases: **${cases.length}**`)
    .addFields(
      ...Object.entries(counts).map(([key, count]) => ({
        name: ACTION_LABELS[key],
        value: String(count),
        inline: true,
      })),
      {
        name: 'Removed or Voided',
        value: String(cases.filter((item) => item.removed_at).length),
        inline: true,
      },
    );
}

function buildCsv(cases) {
  const headers = [
    'case_number',
    'staff_user_id',
    'action',
    'reason',
    'duration',
    'previous_rank',
    'new_rank',
    'issued_by',
    'issued_at',
    'evidence_sha256',
    'evidence_archive_url',
    'removed_at',
    'removed_by',
    'removal_reason',
  ];
  const rows = cases.map((item) => [
    item.case_number,
    item.staff_user_id,
    item.action_type,
    item.reason,
    item.duration,
    item.previous_rank,
    item.new_rank,
    item.created_by,
    item.created_at,
    item.evidence_sha256,
    item.evidence_message_url,
    item.removed_at,
    item.removed_by,
    item.removal_reason,
  ]);

  return [headers, ...rows]
    .map((row) => row.map(csvEscape).join(','))
    .join('\r\n');
}

export function createCommandHandler({ client, db, config }) {
  return async function handleMessage(message) {
    if (!message.guild || message.author.bot) return;

    const content = message.content.trim();
    if (
      !content.toLowerCase().startsWith(config.prefix.toLowerCase()) ||
      !['', ' '].includes(content.charAt(config.prefix.length))
    ) {
      return;
    }

    const afterPrefix = content.slice(config.prefix.length).trim();
    const firstSpace = afterPrefix.indexOf(' ');
    const command = (
      firstSpace < 0 ? afterPrefix : afterPrefix.slice(0, firstSpace)
    ).toLowerCase();
    const rawArguments = firstSpace < 0 ? '' : afterPrefix.slice(firstSpace + 1).trim();

    if (!command || command === 'help' || command === 'guide') {
      await message.reply({ embeds: helpEmbeds(config.prefix) });
      return;
    }

    if (command === 'commands' || command === 'commandlist') {
      await message.reply({ embeds: [commandsEmbed(config.prefix)] });
      return;
    }

    const guildConfig = db.getConfig(message.guild.id);
    const level = getAccessLevel(message, db, config.ownerUserIds);
    if (!hasAccess(level, 'hr')) {
      await sendError(message, 'You are not on this server’s HR whitelist.');
      return;
    }

    if (command !== 'setup') {
      if (!(await ensureConfigured(message, guildConfig))) return;
      if (!(await ensureCommandChannel(message, guildConfig))) return;
    }

    const actionType = ACTION_ALIASES[command];
    if (actionType) {
      await handleCreateCase({
        message,
        actionType,
        rawArguments,
        client,
        db,
        config,
        guildConfig,
      });
      return;
    }

    if (command === 'setup') {
      if (!hasAccess(level, 'admin')) {
        await sendError(message, 'Only an admin or owner can configure channels.');
        return;
      }

      const tokens = rawArguments.split(/\s+/).filter(Boolean);
      if (tokens.length !== 4) {
        await sendError(
          message,
          `Use \`${config.prefix} setup #commands #audit #removed #evidence\`.`,
        );
        return;
      }

      const [commandChannelId, auditChannelId, removedChannelId, evidenceChannelId] =
        tokens.map(parseChannelId);
      if (!commandChannelId || !auditChannelId || !removedChannelId || !evidenceChannelId) {
        await sendError(message, 'All four setup values must be channel mentions or channel IDs.');
        return;
      }

      for (const channelId of [
        commandChannelId,
        auditChannelId,
        removedChannelId,
        evidenceChannelId,
      ]) {
        const channel = await fetchTextChannel(client, channelId);
        if (!channel || channel.guildId !== message.guild.id) {
          await sendError(message, `<#${channelId}> is not a usable text channel in this server.`);
          return;
        }

        const permissions = channel.permissionsFor(message.guild.members.me);
        if (
          !permissions?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
          ])
        ) {
          await sendError(
            message,
            `I need View Channel, Send Messages, Embed Links, and Attach Files in <#${channelId}>.`,
          );
          return;
        }
      }

      const audit = db.setChannels({
        guildId: message.guild.id,
        commandChannelId,
        auditChannelId,
        removedChannelId,
        evidenceChannelId,
        actorUserId: message.author.id,
      });
      const updatedConfig = db.getConfig(message.guild.id);
      await mirrorAudit({ client, config, guildConfig: updatedConfig, auditRow: audit });
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Staff Ledger Configured')
            .setDescription(
              [
                `Commands: <#${commandChannelId}>`,
                `Audit log: <#${auditChannelId}>`,
                `Removed actions: <#${removedChannelId}>`,
                `Evidence archive: <#${evidenceChannelId}>`,
              ].join('\n'),
            ),
        ],
      });
      return;
    }

    if (command === 'whitelist') {
      if (!hasAccess(level, 'admin')) {
        await sendError(message, 'Only an admin or owner can manage the whitelist.');
        return;
      }

      const [operation = '', targetToken = '', requestedLevel = ''] =
        rawArguments.split(/\s+/);

      if (operation === 'list') {
        const entries = db.listWhitelist(message.guild.id);
        const lines = [
          ...[...config.ownerUserIds].map((id) => `<@${id}> • owner environment access`),
          ...entries.map(
            (entry) =>
              `<@${entry.user_id}> • ${entry.access_level} • added by <@${entry.added_by}> ${discordTimestamp(entry.added_at, 'R')}`,
          ),
        ];
        await message.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('Staff Ledger Whitelist')
              .setDescription(lines.join('\n') || 'No authorized users found.'),
          ],
        });
        return;
      }

      const targetUserId = parseUserId(targetToken);
      if (!targetUserId) {
        await sendError(
          message,
          `Use \`${config.prefix} whitelist add @user hr\`, \`${config.prefix} whitelist add @user admin\`, or \`${config.prefix} whitelist remove @user\`.`,
        );
        return;
      }

      if (operation === 'add') {
        if (!['hr', 'admin'].includes(requestedLevel)) {
          await sendError(message, 'Whitelist level must be `hr` or `admin`.');
          return;
        }
        const audit = db.setWhitelist({
          guildId: message.guild.id,
          userId: targetUserId,
          accessLevel: requestedLevel,
          actorUserId: message.author.id,
        });
        await mirrorAudit({ client, config, guildConfig, auditRow: audit });
        await message.reply(`Added <@${targetUserId}> to the whitelist as **${requestedLevel}**.`);
        return;
      }

      if (operation === 'remove') {
        if (config.ownerUserIds.has(targetUserId)) {
          await sendError(message, 'Environment owners cannot be removed with a Discord command.');
          return;
        }
        const audit = db.removeWhitelist({
          guildId: message.guild.id,
          userId: targetUserId,
          actorUserId: message.author.id,
        });
        if (!audit) {
          await sendError(message, 'That user is not on the Discord whitelist.');
          return;
        }
        await mirrorAudit({ client, config, guildConfig, auditRow: audit });
        await message.reply(`Removed <@${targetUserId}> from the whitelist.`);
        return;
      }

      await sendError(message, `Run \`${config.prefix} help\` for whitelist syntax.`);
      return;
    }

    if (command === 'case') {
      const caseNumber = normalizeCaseNumber(rawArguments);
      if (!caseNumber) {
        await sendError(message, `Use \`${config.prefix} case 133\`.`);
        return;
      }
      const caseRecord = db.getCase(message.guild.id, caseNumber);
      if (!caseRecord) {
        await sendError(message, `Case #${caseNumber} was not found.`);
        return;
      }

      const storedPath = path.join(
        config.evidenceDirectory,
        caseRecord.evidence_stored_name,
      );
      const files = fs.existsSync(storedPath)
        ? [
            new AttachmentBuilder(storedPath, {
              name: caseRecord.evidence_original_name,
            }),
          ]
        : [];
      try {
        await message.reply({ embeds: [buildCaseEmbed(caseRecord)], files });
      } catch (error) {
        if (files.length === 0) throw error;
        await message.reply({
          content:
            'The case is stored, but Discord would not accept the local evidence re-upload. Use the evidence archive link inside the case when available.',
          embeds: [buildCaseEmbed(caseRecord)],
        });
      }
      return;
    }

    if (command === 'cases') {
      const tokens = rawArguments.split(/\s+/).filter(Boolean);
      const staffUserId = parseUserId(tokens[0]);
      const includeRemoved = tokens[1]?.toLowerCase() === 'all';
      if (!staffUserId) {
        await sendError(message, `Use \`${config.prefix} cases @user\` or add \`all\`.`);
        return;
      }
      const cases = db.listCases(message.guild.id, staffUserId, includeRemoved);
      await message.reply({
        embeds: buildCaseListEmbeds(cases, staffUserId, includeRemoved),
      });
      return;
    }

    if (command === 'stats') {
      const staffUserId = parseUserId(rawArguments.split(/\s+/)[0]);
      if (!staffUserId) {
        await sendError(message, `Use \`${config.prefix} stats @user\`.`);
        return;
      }
      const cases = db.listCases(message.guild.id, staffUserId, true);
      await message.reply({ embeds: [buildStatsEmbed(cases, staffUserId)] });
      return;
    }

    if (command === 'export') {
      const tokens = rawArguments.split(/\s+/).filter(Boolean);
      const staffUserId = parseUserId(tokens[0]);
      const includeRemoved = tokens[1]?.toLowerCase() === 'all';
      if (!staffUserId) {
        await sendError(message, `Use \`${config.prefix} export @user\` or add \`all\`.`);
        return;
      }
      const cases = db.listCases(message.guild.id, staffUserId, includeRemoved);
      const csv = buildCsv(cases);
      const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), {
        name: `staff-cases-${staffUserId}.csv`,
      });
      const audit = db.appendAudit({
        guildId: message.guild.id,
        eventType: 'CASE_HISTORY_EXPORTED',
        actorUserId: message.author.id,
        targetUserId: staffUserId,
        payload: { includeRemoved, caseCount: cases.length },
      });
      await mirrorAudit({ client, config, guildConfig, auditRow: audit });
      await message.reply({ content: `Exported ${cases.length} cases.`, files: [file] });
      return;
    }

    if (command === 'amend') {
      const firstSpaceIndex = rawArguments.indexOf(' ');
      const caseNumber = normalizeCaseNumber(
        firstSpaceIndex < 0 ? rawArguments : rawArguments.slice(0, firstSpaceIndex),
      );
      const note = firstSpaceIndex < 0 ? '' : rawArguments.slice(firstSpaceIndex + 1).trim();
      if (!caseNumber || !note) {
        await sendError(message, `Use \`${config.prefix} amend 133 <correction note>\`.`);
        return;
      }
      const result = db.amendCase({
        guildId: message.guild.id,
        caseNumber,
        note,
        actorUserId: message.author.id,
      });
      if (!result) {
        await sendError(message, `Case #${caseNumber} was not found.`);
        return;
      }
      await mirrorAudit({ client, config, guildConfig, auditRow: result.audit });
      await message.reply(`Amendment added to case **#${caseNumber}** without changing the original record.`);
      return;
    }

    if (command === 'remove') {
      if (!hasAccess(level, 'admin')) {
        await sendError(message, 'Only an admin or owner can remove or void a case.');
        return;
      }
      const firstSpaceIndex = rawArguments.indexOf(' ');
      const caseNumber = normalizeCaseNumber(
        firstSpaceIndex < 0 ? rawArguments : rawArguments.slice(0, firstSpaceIndex),
      );
      const reason = firstSpaceIndex < 0 ? '' : rawArguments.slice(firstSpaceIndex + 1).trim();
      if (!caseNumber || !reason) {
        await sendError(message, `Use \`${config.prefix} remove 133 <reason>\`.`);
        return;
      }
      const result = db.removeCase({
        guildId: message.guild.id,
        caseNumber,
        reason,
        actorUserId: message.author.id,
      });
      if (!result) {
        await sendError(message, 'That case does not exist or has already been removed.');
        return;
      }

      const removedChannel = await fetchTextChannel(client, guildConfig.removed_channel_id);
      if (removedChannel) {
        await removedChannel.send({ embeds: [buildRemovedEmbed(result.case)] });
      }
      await mirrorAudit({
        client,
        config,
        guildConfig,
        auditRow: result.audit,
        embeds: [buildRemovedEmbed(result.case)],
      });
      await message.reply(
        `Case **#${caseNumber}** was voided. Its original record and evidence remain preserved.`,
      );
      return;
    }

    if (command === 'audit') {
      if (!hasAccess(level, 'admin')) {
        await sendError(message, 'Only an admin or owner can inspect the audit ledger.');
        return;
      }
      const [operation = 'recent', amountText = '10'] = rawArguments.split(/\s+/);
      if (operation === 'verify') {
        const result = db.verifyAudit(message.guild.id);
        await message.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle(result.valid ? 'Audit Chain Verified' : 'Audit Chain Failure')
              .setDescription(
                result.valid
                  ? `${result.checked} entries were verified. Final hash: \`${truncate(result.finalHash, 32)}\``
                  : `The chain failed at audit entry #${result.brokenAtId}: ${result.reason}.`,
              ),
          ],
        });
        return;
      }
      if (operation === 'recent' || operation === '') {
        const amount = Math.min(Math.max(Number.parseInt(amountText, 10) || 10, 1), 20);
        await message.reply({
          embeds: [buildCompactAuditList(db.recentAudit(message.guild.id, amount))],
        });
        return;
      }
      await sendError(message, `Use \`${config.prefix} audit recent 10\` or \`${config.prefix} audit verify\`.`);
      return;
    }

    if (command === 'removed') {
      if (!hasAccess(level, 'admin')) {
        await sendError(message, 'Only an admin or owner can inspect removed actions.');
        return;
      }
      const amount = Math.min(Math.max(Number.parseInt(rawArguments, 10) || 10, 1), 20);
      await message.reply({
        embeds: [buildCompactRemovedList(db.recentRemoved(message.guild.id, amount))],
      });
      return;
    }

    if (command === 'status') {
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Staff Ledger Status')
            .addFields(
              { name: 'Your Access', value: level, inline: true },
              { name: 'Command Channel', value: `<#${guildConfig.command_channel_id}>`, inline: true },
              { name: 'Audit Channel', value: `<#${guildConfig.audit_channel_id}>`, inline: true },
              { name: 'Removed Actions', value: `<#${guildConfig.removed_channel_id}>`, inline: true },
              { name: 'Evidence Archive', value: `<#${guildConfig.evidence_channel_id}>`, inline: true },
              {
                name: 'Audit Integrity',
                value: db.verifyAudit(message.guild.id).valid ? 'verified' : 'failed verification',
                inline: true,
              },
            ),
        ],
      });
      return;
    }

    await sendError(message, `Unknown command. Run \`${config.prefix} commands\` or \`${config.prefix} help\`.`);
  };
}
