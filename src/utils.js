import crypto from 'node:crypto';

export const ACTION_LABELS = {
  warning: 'Official Warning',
  strike: 'Strike',
  suspension: 'Suspension',
  demotion: 'Demotion',
  fired: 'Fired',
};

export const ACTION_ALIASES = {
  warn: 'warning',
  warning: 'warning',
  strike: 'strike',
  suspend: 'suspension',
  suspension: 'suspension',
  demote: 'demotion',
  demotion: 'demotion',
  fire: 'fired',
  fired: 'fired',
};

export function nowIso() {
  return new Date().toISOString();
}

export function discordTimestamp(iso, style = 'F') {
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  return Number.isFinite(unix) ? `<t:${unix}:${style}>` : 'unknown time';
}

export function parseUserId(input) {
  if (!input) return null;
  const match = input.match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return match?.[1] || match?.[2] || null;
}

export function parseChannelId(input) {
  if (!input) return null;
  const match = input.match(/^<#(\d{17,20})>$|^(\d{17,20})$/);
  return match?.[1] || match?.[2] || null;
}

export function normalizeCaseNumber(input) {
  const cleaned = String(input ?? '').trim().replace(/^#/, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number.parseInt(cleaned, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function splitPipeArguments(value, expectedParts) {
  const parts = value.split('|').map((part) => part.trim());
  return parts.length === expectedParts && parts.every(Boolean) ? parts : null;
}

export function sanitizeFilename(name) {
  const safe = String(name || 'evidence.bin')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-120);
  return safe || 'evidence.bin';
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function truncate(value, length = 1024) {
  const text = String(value ?? '');
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1))}…`;
}

export function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function isMediaAttachment(attachment) {
  const contentType = attachment.contentType?.toLowerCase() || '';
  if (contentType.startsWith('image/') || contentType.startsWith('video/')) {
    return true;
  }

  return /\.(png|jpe?g|gif|webp|bmp|mp4|mov|webm|m4v)$/i.test(
    attachment.name || '',
  );
}
