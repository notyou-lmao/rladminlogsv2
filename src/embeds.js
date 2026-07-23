import { EmbedBuilder } from 'discord.js';
import {
  ACTION_LABELS,
  discordTimestamp,
  truncate,
} from './utils.js';

const STATUS_LABEL = {
  active: 'Active',
  removed: 'Removed or Voided',
};

export function buildHelpEmbeds(prefix) {
  const main = new EmbedBuilder()
    .setTitle('Staff Action Ledger Help Guide')
    .setDescription(
      'This bot creates permanent, tamper-evident staff action records. Every new case requires a reason and one attached image or video.',
    )
    .addFields(
      {
        name: 'Hiring and Promotions',
        value: [
          `\`${prefix} hire @user <starting rank> | <reason>\``,
          `\`${prefix} promote @user <old rank> | <new rank> | <reason>\``,
          '',
          'Aliases: `hiring`, `hired`, `promotion`, and `promoted`.',
        ].join('\n'),
      },
      {
        name: 'Disciplinary Cases',
        value: [
          `\`${prefix} warning @user <reason>\``,
          `\`${prefix} strike @user <reason>\``,
          `\`${prefix} suspension @user <duration> | <reason>\``,
          `\`${prefix} demotion @user <old rank> | <new rank> | <reason>\``,
          `\`${prefix} fired @user <reason>\``,
          '',
          '**Attach one image or video to the same message for every staff action.**',
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

export function buildCommandsEmbed(prefix) {
  return new EmbedBuilder()
    .setTitle('Command List')
    .setDescription(
      [
        `\`${prefix} help\``,
        `\`${prefix} commands\``,
        `\`${prefix} hire\`, \`${prefix} promote\``,
        `\`${prefix} warning\`, \`${prefix} strike\`, \`${prefix} suspension\`, \`${prefix} demotion\`, \`${prefix} fired\``,
        `\`${prefix} case\`, \`${prefix} cases\`, \`${prefix} stats\`, \`${prefix} export\``,
        `\`${prefix} amend\`, \`${prefix} remove\``,
        `\`${prefix} whitelist\`, \`${prefix} setup\``,
        `\`${prefix} audit\`, \`${prefix} removed\`, \`${prefix} status\``,
      ].join('\n'),
    )
    .setFooter({ text: `Run ${prefix} help for syntax and examples.` });
}


export function buildCaseEmbed(caseRecord) {
  const removed = Boolean(caseRecord.removed_at);
  const embed = new EmbedBuilder()
    .setTitle(`Case #${caseRecord.case_number}`)
    .setDescription(
      removed
        ? '**This action has been removed or voided, but its record remains preserved.**'
        : '**Official staff administrative action**',
    )
    .addFields(
      {
        name: 'Staff Member',
        value: `<@${caseRecord.staff_user_id}>\n\`${caseRecord.staff_user_id}\``,
        inline: true,
      },
      {
        name: 'Action',
        value: ACTION_LABELS[caseRecord.action_type] || caseRecord.action_type,
        inline: true,
      },
      {
        name: 'Status',
        value: removed ? STATUS_LABEL.removed : STATUS_LABEL.active,
        inline: true,
      },
      {
        name: 'Issued By',
        value: `<@${caseRecord.created_by}>\n\`${caseRecord.created_by}\``,
        inline: true,
      },
      {
        name: 'Issued At',
        value: `${discordTimestamp(caseRecord.created_at)}\n${discordTimestamp(caseRecord.created_at, 'R')}`,
        inline: true,
      },
      {
        name: 'Reason',
        value: truncate(caseRecord.reason, 1024),
      },
    )
    .setFooter({
      text: `Evidence SHA 256: ${caseRecord.evidence_sha256}`,
    })
    .setTimestamp(new Date(caseRecord.created_at));

  if (caseRecord.duration) {
    embed.addFields({ name: 'Suspension Duration', value: caseRecord.duration });
  }

  if (caseRecord.action_type === 'hiring' && caseRecord.new_rank) {
    embed.addFields({
      name: 'Starting Rank',
      value: caseRecord.new_rank,
    });
  } else if (caseRecord.previous_rank || caseRecord.new_rank) {
    embed.addFields({
      name: 'Rank Change',
      value: `${caseRecord.previous_rank || 'unknown'} → ${caseRecord.new_rank || 'unknown'}`,
    });
  }

  if (caseRecord.evidence_message_url) {
    embed.addFields({
      name: 'Stored Evidence',
      value: `[Open evidence archive](${caseRecord.evidence_message_url})`,
    });
  }

  if (removed) {
    embed.addFields(
      {
        name: 'Removed By',
        value: `<@${caseRecord.removed_by}>`,
        inline: true,
      },
      {
        name: 'Removed At',
        value: discordTimestamp(caseRecord.removed_at),
        inline: true,
      },
      {
        name: 'Removal Reason',
        value: truncate(caseRecord.removal_reason, 1024),
      },
    );
  }

  const amendments = caseRecord.amendments || [];
  if (amendments.length) {
    const latest = amendments.slice(-5).map((item) => (
      `${discordTimestamp(item.created_at, 'd')} by <@${item.created_by}>: ${truncate(item.note, 300)}`
    ));
    embed.addFields({ name: 'Amendments', value: latest.join('\n') });
  }

  const imageLike = caseRecord.evidence_content_type?.startsWith('image/');
  if (imageLike && caseRecord.evidence_attachment_url) {
    embed.setImage(caseRecord.evidence_attachment_url);
  }

  return embed;
}

export function buildCaseListEmbeds(cases, staffUserId, includeRemoved = false) {
  const casesPerPage = 12;
  const lines = cases.map((item) => {
    const removed = item.removed_at ? ' • removed' : '';
    return `**#${item.case_number}** • ${ACTION_LABELS[item.action_type] || item.action_type} • ${discordTimestamp(item.created_at, 'f')}${removed}`;
  });

  if (!lines.length) {
    return [
      new EmbedBuilder()
        .setTitle(`Cases for <@${staffUserId}>`)
        .setDescription('No matching cases were found.')
        .setFooter({
          text: includeRemoved
            ? 'Includes removed or voided actions'
            : 'Active actions only',
        }),
    ];
  }

  const pageCount = Math.ceil(lines.length / casesPerPage);
  const embeds = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const start = pageIndex * casesPerPage;
    const end = start + casesPerPage;
    embeds.push(
      new EmbedBuilder()
        .setTitle(`Cases for <@${staffUserId}>`)
        .setDescription(lines.slice(start, end).join('\n'))
        .setFooter({
          text: [
            `Page ${pageIndex + 1} of ${pageCount}`,
            `${cases.length} total case${cases.length === 1 ? '' : 's'}`,
            includeRemoved
              ? 'Includes removed or voided actions'
              : 'Active actions only',
          ].join(' • '),
        }),
    );
  }

  return embeds;
}

export function buildAuditEmbed(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = { raw: row.payload_json };
  }

  return new EmbedBuilder()
    .setTitle(`Audit Entry #${row.id}`)
    .setDescription(`**${row.event_type}**`)
    .addFields(
      { name: 'Actor', value: `<@${row.actor_user_id}>`, inline: true },
      {
        name: 'Target',
        value: row.target_user_id ? `<@${row.target_user_id}>` : 'none',
        inline: true,
      },
      {
        name: 'Case',
        value: row.case_number ? `#${row.case_number}` : 'none',
        inline: true,
      },
      {
        name: 'Date and Time',
        value: discordTimestamp(row.created_at),
      },
      {
        name: 'Details',
        value: `\`\`\`json\n${truncate(JSON.stringify(payload, null, 2), 900)}\n\`\`\``,
      },
      {
        name: 'Hash Chain',
        value: `Previous: \`${truncate(row.previous_hash, 20)}\`\nEntry: \`${truncate(row.entry_hash, 20)}\``,
      },
    )
    .setTimestamp(new Date(row.created_at));
}

export function buildRemovedEmbed(caseRecord) {
  return new EmbedBuilder()
    .setTitle(`Removed Action, Case #${caseRecord.case_number}`)
    .setDescription(
      'The action was voided, but the original case, proof hash, and removal record remain stored.',
    )
    .addFields(
      { name: 'Staff Member', value: `<@${caseRecord.staff_user_id}>`, inline: true },
      {
        name: 'Original Action',
        value: ACTION_LABELS[caseRecord.action_type] || caseRecord.action_type,
        inline: true,
      },
      { name: 'Removed By', value: `<@${caseRecord.removed_by}>`, inline: true },
      { name: 'Removed At', value: discordTimestamp(caseRecord.removed_at) },
      { name: 'Removal Reason', value: truncate(caseRecord.removal_reason, 1024) },
      {
        name: 'Original Evidence SHA 256',
        value: `\`${caseRecord.evidence_sha256}\``,
      },
    )
    .setTimestamp(new Date(caseRecord.removed_at));
}

export function buildCompactAuditList(rows) {
  const description = rows.length
    ? rows
        .map(
          (row) =>
            `**#${row.id}** • ${row.event_type} • <@${row.actor_user_id}> • ${discordTimestamp(row.created_at, 'f')}${row.case_number ? ` • case #${row.case_number}` : ''}`,
        )
        .join('\n')
    : 'No audit entries found.';

  return new EmbedBuilder().setTitle('Recent Audit Entries').setDescription(description);
}

export function buildCompactRemovedList(rows) {
  const description = rows.length
    ? rows
        .map(
          (row) =>
            `**Case #${row.case_number}** • ${ACTION_LABELS[row.original_action_type] || row.original_action_type} • <@${row.staff_user_id}> • removed ${discordTimestamp(row.removed_at, 'R')}`,
        )
        .join('\n')
    : 'No removed actions found.';

  return new EmbedBuilder().setTitle('Removed Actions Ledger').setDescription(description);
}

export function buildUserActionDmEmbed(
  caseRecord,
  guildName,
  evidenceFileName,
) {
  const actionLabel =
    ACTION_LABELS[caseRecord.action_type] || caseRecord.action_type;

  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setAuthor({
      name: guildName
        ? `${guildName} Staff Administration`
        : 'Staff Administration',
    })
    .setTitle(`Administrative Action Notice, Case #${caseRecord.case_number}`)
    .setDescription(
      'An official administrative action has been recorded on your staff record. The details and submitted evidence are included below.',
    )
    .addFields(
      {
        name: 'Action Taken',
        value: actionLabel,
        inline: true,
      },
      {
        name: 'Case Number',
        value: `#${caseRecord.case_number}`,
        inline: true,
      },
      {
        name: 'Issued By',
        value: `<@${caseRecord.created_by}>\n\`${caseRecord.created_by}\``,
        inline: true,
      },
      {
        name: 'Date and Time',
        value: `${discordTimestamp(caseRecord.created_at)}\n${discordTimestamp(caseRecord.created_at, 'R')}`,
      },
      {
        name: 'Reason',
        value: truncate(caseRecord.reason, 1024),
      },
    )
    .setFooter({
      text: `Evidence SHA 256: ${caseRecord.evidence_sha256}`,
    })
    .setTimestamp(new Date(caseRecord.created_at));

  if (caseRecord.duration) {
    embed.addFields({
      name: 'Suspension Duration',
      value: caseRecord.duration,
    });
  }

  if (caseRecord.action_type === 'hiring' && caseRecord.new_rank) {
    embed.addFields({
      name: 'Starting Rank',
      value: caseRecord.new_rank,
    });
  } else if (caseRecord.previous_rank || caseRecord.new_rank) {
    embed.addFields({
      name: 'Rank Change',
      value: `${caseRecord.previous_rank || 'unknown'} → ${caseRecord.new_rank || 'unknown'}`,
    });
  }

  embed.addFields({
    name: 'Submitted Proof',
    value:
      'The evidence submitted with this action is attached to this direct message. Contact your HR team and reference the case number above if you need to discuss this action.',
  });

  if (
    evidenceFileName &&
    caseRecord.evidence_content_type?.startsWith('image/')
  ) {
    embed.setImage(`attachment://${evidenceFileName}`);
  }

  return embed;
}
