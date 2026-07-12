import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import {
  isMediaAttachment,
  sanitizeFilename,
  sha256,
  truncate,
} from './utils.js';

export async function saveEvidence(attachment, evidenceDirectory, maxBytes) {
  if (!attachment) {
    throw new Error('A photo or video attachment is required.');
  }

  if (!isMediaAttachment(attachment)) {
    throw new Error('Evidence must be an image or video file.');
  }

  if (attachment.size > maxBytes) {
    throw new Error(
      `Evidence is too large. Maximum size is ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
    );
  }

  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Could not download the evidence file, HTTP ${response.status}.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > maxBytes) {
    throw new Error(
      `Evidence is too large. Maximum size is ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
    );
  }

  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const originalName = sanitizeFilename(attachment.name || 'evidence.bin');
  const extension = path.extname(originalName).slice(0, 12);
  const storedName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
  const storedPath = path.join(evidenceDirectory, storedName);
  const temporaryPath = `${storedPath}.tmp`;

  fs.writeFileSync(temporaryPath, buffer, { flag: 'wx' });
  fs.renameSync(temporaryPath, storedPath);

  return {
    originalName,
    storedName,
    storedPath,
    contentType: attachment.contentType || null,
    size: buffer.length,
    sha256: sha256(buffer),
  };
}

export function removeSavedEvidence(storedPath) {
  try {
    fs.rmSync(storedPath, { force: true });
  } catch {
    // Best effort cleanup only.
  }
}

export async function mirrorEvidence({
  client,
  channelId,
  caseRecord,
  evidenceDirectory,
}) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) {
    throw new Error('The configured evidence channel is not a text channel.');
  }

  const storedPath = path.join(
    evidenceDirectory,
    caseRecord.evidence_stored_name,
  );
  if (!fs.existsSync(storedPath)) {
    throw new Error('The locally stored evidence file is missing.');
  }

  const file = new AttachmentBuilder(storedPath, {
    name: caseRecord.evidence_original_name,
  });

  const embed = new EmbedBuilder()
    .setTitle(`Case #${caseRecord.case_number} Evidence`)
    .setDescription(
      `Staff member: <@${caseRecord.staff_user_id}>\nIssued by: <@${caseRecord.created_by}>`,
    )
    .addFields(
      {
        name: 'Action',
        value: caseRecord.action_type,
        inline: true,
      },
      {
        name: 'SHA 256',
        value: `\`${caseRecord.evidence_sha256}\``,
      },
      {
        name: 'Original filename',
        value: truncate(caseRecord.evidence_original_name, 256),
      },
    )
    .setTimestamp(new Date(caseRecord.created_at));

  const sent = await channel.send({ embeds: [embed], files: [file] });
  const mirroredAttachment = sent.attachments.first();

  return {
    messageUrl: sent.url,
    attachmentUrl: mirroredAttachment?.url || null,
  };
}
