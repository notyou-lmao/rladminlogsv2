import path from 'node:path';
import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseIdSet(value) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function integer(name, fallback, minimum = 0) {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return parsed;
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    throw new Error(`BOT_TIMEZONE is invalid: ${value}`);
  }
}

export const config = {
  token: required('DISCORD_TOKEN'),
  ownerUserIds: parseIdSet(process.env.OWNER_USER_IDS),
  prefix: process.env.PREFIX?.trim() || '.admin',
  timeZone: validTimeZone(process.env.BOT_TIMEZONE?.trim() || 'America/New_York'),
  initialCaseNumber: integer('INITIAL_CASE_NUMBER', 100, 1),
  databasePath:
    process.env.DATABASE_PATH?.trim() ||
    path.resolve(process.cwd(), 'data', 'staff-ledger.sqlite'),
  evidenceDirectory:
    process.env.EVIDENCE_DIRECTORY?.trim() ||
    path.resolve(process.cwd(), 'data', 'evidence'),
  maxEvidenceBytes: integer('MAX_EVIDENCE_MB', 25, 1) * 1024 * 1024,
  archiveChannelId: process.env.ARCHIVE_CHANNEL_ID?.trim() || null,
  port: integer('PORT', 3000, 1),
};

if (config.ownerUserIds.size === 0) {
  throw new Error('OWNER_USER_IDS must contain at least one Discord user ID.');
}
