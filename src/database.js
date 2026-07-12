import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nowIso } from './utils.js';

const ACCESS_LEVELS = new Set(['hr', 'admin']);
const ACTION_TYPES = new Set([
  'hiring',
  'promotion',
  'warning',
  'strike',
  'suspension',
  'demotion',
  'fired',
]);

function auditHash({
  guildId,
  eventType,
  actorUserId,
  targetUserId,
  caseNumber,
  payloadJson,
  previousHash,
  createdAt,
}) {
  const canonical = [
    guildId,
    eventType,
    actorUserId,
    targetUserId ?? '',
    caseNumber ?? '',
    payloadJson,
    previousHash,
    createdAt,
  ].join('|');

  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function createDatabase(databasePath, initialCaseNumber = 100) {
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

  const db = new DatabaseSync(databasePath, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
  `);

  const existingCasesTable = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cases'")
    .get();

  if (
    existingCasesTable?.sql &&
    (!existingCasesTable.sql.includes("'hiring'") ||
      !existingCasesTable.sql.includes("'promotion'"))
  ) {
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.exec(`
        BEGIN IMMEDIATE;

        DROP TRIGGER IF EXISTS cases_no_delete;
        DROP TRIGGER IF EXISTS cases_immutable_fields;
        DROP INDEX IF EXISTS idx_cases_staff;

        CREATE TABLE cases_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          case_number INTEGER NOT NULL,
          staff_user_id TEXT NOT NULL,
          action_type TEXT NOT NULL CHECK(
            action_type IN ('hiring', 'promotion', 'warning', 'strike', 'suspension', 'demotion', 'fired')
          ),
          reason TEXT NOT NULL,
          duration TEXT,
          previous_rank TEXT,
          new_rank TEXT,
          effective_at TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          evidence_original_name TEXT NOT NULL,
          evidence_stored_name TEXT NOT NULL,
          evidence_content_type TEXT,
          evidence_size INTEGER NOT NULL,
          evidence_sha256 TEXT NOT NULL,
          evidence_message_url TEXT,
          evidence_attachment_url TEXT,
          removed_at TEXT,
          removed_by TEXT,
          removal_reason TEXT,
          UNIQUE (guild_id, case_number),
          FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id)
        );

        INSERT INTO cases_migrated (
          id, guild_id, case_number, staff_user_id, action_type, reason,
          duration, previous_rank, new_rank, effective_at, created_by, created_at,
          evidence_original_name, evidence_stored_name, evidence_content_type,
          evidence_size, evidence_sha256, evidence_message_url,
          evidence_attachment_url, removed_at, removed_by, removal_reason
        )
        SELECT
          id, guild_id, case_number, staff_user_id, action_type, reason,
          duration, previous_rank, new_rank, effective_at, created_by, created_at,
          evidence_original_name, evidence_stored_name, evidence_content_type,
          evidence_size, evidence_sha256, evidence_message_url,
          evidence_attachment_url, removed_at, removed_by, removal_reason
        FROM cases;

        DROP TABLE cases;
        ALTER TABLE cases_migrated RENAME TO cases;

        COMMIT;
      `);
    } catch (error) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Preserve the migration error if rollback also fails.
      }
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  function transaction(fn) {
    return (...args) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Preserve the original error if rollback also fails.
        }
        throw error;
      }
    };
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      command_channel_id TEXT,
      audit_channel_id TEXT,
      removed_channel_id TEXT,
      evidence_channel_id TEXT,
      next_case_number INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whitelist (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      access_level TEXT NOT NULL CHECK(access_level IN ('hr', 'admin')),
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id),
      FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id)
    );

    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      case_number INTEGER NOT NULL,
      staff_user_id TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK(
        action_type IN ('hiring', 'promotion', 'warning', 'strike', 'suspension', 'demotion', 'fired')
      ),
      reason TEXT NOT NULL,
      duration TEXT,
      previous_rank TEXT,
      new_rank TEXT,
      effective_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      evidence_original_name TEXT NOT NULL,
      evidence_stored_name TEXT NOT NULL,
      evidence_content_type TEXT,
      evidence_size INTEGER NOT NULL,
      evidence_sha256 TEXT NOT NULL,
      evidence_message_url TEXT,
      evidence_attachment_url TEXT,
      removed_at TEXT,
      removed_by TEXT,
      removal_reason TEXT,
      UNIQUE (guild_id, case_number),
      FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cases_staff
      ON cases(guild_id, staff_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS case_amendments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      case_id INTEGER NOT NULL,
      note TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id),
      FOREIGN KEY (case_id) REFERENCES cases(id)
    );

    CREATE TABLE IF NOT EXISTS removed_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      case_id INTEGER NOT NULL,
      case_number INTEGER NOT NULL,
      original_action_type TEXT NOT NULL,
      staff_user_id TEXT NOT NULL,
      removed_by TEXT NOT NULL,
      removal_reason TEXT NOT NULL,
      removed_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id),
      FOREIGN KEY (case_id) REFERENCES cases(id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      target_user_id TEXT,
      case_number INTEGER,
      payload_json TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_guild
      ON audit_log(guild_id, id DESC);

    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS removed_actions_no_update
    BEFORE UPDATE ON removed_actions
    BEGIN
      SELECT RAISE(ABORT, 'removed_actions is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS removed_actions_no_delete
    BEFORE DELETE ON removed_actions
    BEGIN
      SELECT RAISE(ABORT, 'removed_actions is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS case_amendments_no_update
    BEFORE UPDATE ON case_amendments
    BEGIN
      SELECT RAISE(ABORT, 'case_amendments is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS case_amendments_no_delete
    BEFORE DELETE ON case_amendments
    BEGIN
      SELECT RAISE(ABORT, 'case_amendments is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS cases_no_delete
    BEFORE DELETE ON cases
    BEGIN
      SELECT RAISE(ABORT, 'cases cannot be physically deleted');
    END;

    CREATE TRIGGER IF NOT EXISTS cases_immutable_fields
    BEFORE UPDATE ON cases
    WHEN
      OLD.guild_id IS NOT NEW.guild_id OR
      OLD.case_number IS NOT NEW.case_number OR
      OLD.staff_user_id IS NOT NEW.staff_user_id OR
      OLD.action_type IS NOT NEW.action_type OR
      OLD.reason IS NOT NEW.reason OR
      OLD.duration IS NOT NEW.duration OR
      OLD.previous_rank IS NOT NEW.previous_rank OR
      OLD.new_rank IS NOT NEW.new_rank OR
      OLD.effective_at IS NOT NEW.effective_at OR
      OLD.created_by IS NOT NEW.created_by OR
      OLD.created_at IS NOT NEW.created_at OR
      OLD.evidence_original_name IS NOT NEW.evidence_original_name OR
      OLD.evidence_stored_name IS NOT NEW.evidence_stored_name OR
      OLD.evidence_content_type IS NOT NEW.evidence_content_type OR
      OLD.evidence_size IS NOT NEW.evidence_size OR
      OLD.evidence_sha256 IS NOT NEW.evidence_sha256 OR
      (OLD.evidence_message_url IS NOT NEW.evidence_message_url AND OLD.evidence_message_url IS NOT NULL) OR
      (OLD.evidence_attachment_url IS NOT NEW.evidence_attachment_url AND OLD.evidence_attachment_url IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'case evidence and original details are immutable');
    END;
  `);

  const stmt = {
    ensureGuild: db.prepare(`
      INSERT INTO guild_config (
        guild_id, next_case_number, created_at, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO NOTHING
    `),
    getConfig: db.prepare(`SELECT * FROM guild_config WHERE guild_id = ?`),
    setChannels: db.prepare(`
      UPDATE guild_config SET
        command_channel_id = ?,
        audit_channel_id = ?,
        removed_channel_id = ?,
        evidence_channel_id = ?,
        updated_at = ?
      WHERE guild_id = ?
    `),
    getWhitelist: db.prepare(`
      SELECT * FROM whitelist WHERE guild_id = ? AND user_id = ?
    `),
    listWhitelist: db.prepare(`
      SELECT * FROM whitelist
      WHERE guild_id = ?
      ORDER BY CASE access_level WHEN 'admin' THEN 0 ELSE 1 END, added_at ASC
    `),
    upsertWhitelist: db.prepare(`
      INSERT INTO whitelist (
        guild_id, user_id, access_level, added_by, added_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        access_level = excluded.access_level,
        added_by = excluded.added_by,
        added_at = excluded.added_at
    `),
    removeWhitelist: db.prepare(`
      DELETE FROM whitelist WHERE guild_id = ? AND user_id = ?
    `),
    getLastAudit: db.prepare(`
      SELECT entry_hash FROM audit_log
      WHERE guild_id = ? ORDER BY id DESC LIMIT 1
    `),
    insertAudit: db.prepare(`
      INSERT INTO audit_log (
        guild_id, event_type, actor_user_id, target_user_id,
        case_number, payload_json, previous_hash, entry_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertCase: db.prepare(`
      INSERT INTO cases (
        guild_id, case_number, staff_user_id, action_type, reason,
        duration, previous_rank, new_rank, effective_at, created_by, created_at,
        evidence_original_name, evidence_stored_name, evidence_content_type,
        evidence_size, evidence_sha256, evidence_message_url,
        evidence_attachment_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    incrementCase: db.prepare(`
      UPDATE guild_config
      SET next_case_number = next_case_number + 1, updated_at = ?
      WHERE guild_id = ?
    `),
    getCase: db.prepare(`
      SELECT * FROM cases WHERE guild_id = ? AND case_number = ?
    `),
    setEvidenceMirror: db.prepare(`
      UPDATE cases
      SET evidence_message_url = ?, evidence_attachment_url = ?
      WHERE guild_id = ? AND case_number = ?
        AND evidence_message_url IS NULL
        AND evidence_attachment_url IS NULL
    `),
    getCaseById: db.prepare(`SELECT * FROM cases WHERE id = ?`),
    getAmendments: db.prepare(`
      SELECT * FROM case_amendments
      WHERE guild_id = ? AND case_id = ?
      ORDER BY id ASC
    `),
    insertAmendment: db.prepare(`
      INSERT INTO case_amendments (
        guild_id, case_id, note, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `),
    markRemoved: db.prepare(`
      UPDATE cases SET removed_at = ?, removed_by = ?, removal_reason = ?
      WHERE id = ? AND removed_at IS NULL
    `),
    insertRemoved: db.prepare(`
      INSERT INTO removed_actions (
        guild_id, case_id, case_number, original_action_type,
        staff_user_id, removed_by, removal_reason, removed_at, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listCasesActive: db.prepare(`
      SELECT * FROM cases
      WHERE guild_id = ? AND staff_user_id = ? AND removed_at IS NULL
      ORDER BY created_at DESC
    `),
    listCasesAll: db.prepare(`
      SELECT * FROM cases
      WHERE guild_id = ? AND staff_user_id = ?
      ORDER BY created_at DESC
    `),
    recentAudit: db.prepare(`
      SELECT * FROM audit_log
      WHERE guild_id = ? ORDER BY id DESC LIMIT ?
    `),
    recentRemoved: db.prepare(`
      SELECT * FROM removed_actions
      WHERE guild_id = ? ORDER BY id DESC LIMIT ?
    `),
    allAudit: db.prepare(`
      SELECT * FROM audit_log
      WHERE guild_id = ? ORDER BY id ASC
    `),
  };

  function ensureGuild(guildId) {
    const timestamp = nowIso();
    stmt.ensureGuild.run(
      guildId,
      initialCaseNumber,
      timestamp,
      timestamp,
    );
    return stmt.getConfig.get(guildId);
  }

  function appendAuditCore({
    guildId,
    eventType,
    actorUserId,
    targetUserId = null,
    caseNumber = null,
    payload = {},
    createdAt = nowIso(),
  }) {
    const previousHash = stmt.getLastAudit.get(guildId)?.entry_hash ?? 'GENESIS';
    const payloadJson = JSON.stringify(payload);
    const entryHash = auditHash({
      guildId,
      eventType,
      actorUserId,
      targetUserId,
      caseNumber,
      payloadJson,
      previousHash,
      createdAt,
    });

    const result = stmt.insertAudit.run(
      guildId,
      eventType,
      actorUserId,
      targetUserId,
      caseNumber,
      payloadJson,
      previousHash,
      entryHash,
      createdAt,
    );

    return db.prepare('SELECT * FROM audit_log WHERE id = ?').get(result.lastInsertRowid);
  }

  const setChannelsTransaction = transaction(({
    guildId,
    commandChannelId,
    auditChannelId,
    removedChannelId,
    evidenceChannelId,
    actorUserId,
  }) => {
    ensureGuild(guildId);
    const timestamp = nowIso();
    stmt.setChannels.run(
      commandChannelId,
      auditChannelId,
      removedChannelId,
      evidenceChannelId,
      timestamp,
      guildId,
    );
    return appendAuditCore({
      guildId,
      eventType: 'CONFIG_CHANNELS_UPDATED',
      actorUserId,
      payload: { commandChannelId, auditChannelId, removedChannelId, evidenceChannelId },
      createdAt: timestamp,
    });
  });

  const setWhitelistTransaction = transaction(({
    guildId,
    userId,
    accessLevel,
    actorUserId,
  }) => {
    if (!ACCESS_LEVELS.has(accessLevel)) throw new Error('Invalid access level.');
    ensureGuild(guildId);
    const timestamp = nowIso();
    stmt.upsertWhitelist.run(
      guildId,
      userId,
      accessLevel,
      actorUserId,
      timestamp,
    );
    return appendAuditCore({
      guildId,
      eventType: 'WHITELIST_UPSERTED',
      actorUserId,
      targetUserId: userId,
      payload: { accessLevel },
      createdAt: timestamp,
    });
  });

  const removeWhitelistTransaction = transaction(({
    guildId,
    userId,
    actorUserId,
  }) => {
    ensureGuild(guildId);
    const existing = stmt.getWhitelist.get(guildId, userId);
    if (!existing) return null;
    stmt.removeWhitelist.run(guildId, userId);
    return appendAuditCore({
      guildId,
      eventType: 'WHITELIST_REMOVED',
      actorUserId,
      targetUserId: userId,
      payload: { previousAccessLevel: existing.access_level },
    });
  });

  const createCaseTransaction = transaction((input) => {
    if (!ACTION_TYPES.has(input.actionType)) throw new Error('Invalid action type.');
    const guild = ensureGuild(input.guildId);
    const caseNumber = guild.next_case_number;
    const timestamp = nowIso();

    const result = stmt.insertCase.run(
      input.guildId,
      caseNumber,
      input.staffUserId,
      input.actionType,
      input.reason,
      input.duration ?? null,
      input.previousRank ?? null,
      input.newRank ?? null,
      timestamp,
      input.actorUserId,
      timestamp,
      input.evidence.originalName,
      input.evidence.storedName,
      input.evidence.contentType ?? null,
      input.evidence.size,
      input.evidence.sha256,
      input.evidence.messageUrl ?? null,
      input.evidence.attachmentUrl ?? null,
    );

    stmt.incrementCase.run(timestamp, input.guildId);

    const createdCase = stmt.getCaseById.get(result.lastInsertRowid);
    const audit = appendAuditCore({
      guildId: input.guildId,
      eventType: 'CASE_CREATED',
      actorUserId: input.actorUserId,
      targetUserId: input.staffUserId,
      caseNumber,
      payload: {
        actionType: input.actionType,
        reason: input.reason,
        duration: input.duration ?? null,
        previousRank: input.previousRank ?? null,
        newRank: input.newRank ?? null,
        evidenceOriginalName: input.evidence.originalName,
        evidenceSha256: input.evidence.sha256,
      },
      createdAt: timestamp,
    });

    return { case: createdCase, audit };
  });

  const setEvidenceMirrorTransaction = transaction(({
    guildId,
    caseNumber,
    messageUrl,
    attachmentUrl,
    actorUserId,
  }) => {
    ensureGuild(guildId);
    const existing = stmt.getCase.get(guildId, caseNumber);
    if (!existing) return null;
    const changed = stmt.setEvidenceMirror.run(
      messageUrl,
      attachmentUrl,
      guildId,
      caseNumber,
    );
    if (changed.changes !== 1) return stmt.getCase.get(guildId, caseNumber);
    appendAuditCore({
      guildId,
      eventType: 'EVIDENCE_MIRRORED',
      actorUserId,
      targetUserId: existing.staff_user_id,
      caseNumber,
      payload: { messageUrl, attachmentUrl },
    });
    return stmt.getCase.get(guildId, caseNumber);
  });

  const amendCaseTransaction = transaction(({
    guildId,
    caseNumber,
    note,
    actorUserId,
  }) => {
    ensureGuild(guildId);
    const existing = stmt.getCase.get(guildId, caseNumber);
    if (!existing) return null;
    const timestamp = nowIso();
    const result = stmt.insertAmendment.run(
      guildId,
      existing.id,
      note,
      actorUserId,
      timestamp,
    );
    const amendment = db
      .prepare('SELECT * FROM case_amendments WHERE id = ?')
      .get(result.lastInsertRowid);
    const audit = appendAuditCore({
      guildId,
      eventType: 'CASE_AMENDED',
      actorUserId,
      targetUserId: existing.staff_user_id,
      caseNumber,
      payload: { note },
      createdAt: timestamp,
    });
    return { case: existing, amendment, audit };
  });

  const removeCaseTransaction = transaction(({
    guildId,
    caseNumber,
    reason,
    actorUserId,
  }) => {
    ensureGuild(guildId);
    const existing = stmt.getCase.get(guildId, caseNumber);
    if (!existing || existing.removed_at) return null;
    const timestamp = nowIso();
    const updated = stmt.markRemoved.run(
      timestamp,
      actorUserId,
      reason,
      existing.id,
    );
    if (updated.changes !== 1) return null;

    const snapshotJson = JSON.stringify(existing);
    stmt.insertRemoved.run(
      guildId,
      existing.id,
      existing.case_number,
      existing.action_type,
      existing.staff_user_id,
      actorUserId,
      reason,
      timestamp,
      snapshotJson,
    );

    const removedCase = stmt.getCaseById.get(existing.id);
    const audit = appendAuditCore({
      guildId,
      eventType: 'CASE_REMOVED',
      actorUserId,
      targetUserId: existing.staff_user_id,
      caseNumber,
      payload: {
        removalReason: reason,
        originalActionType: existing.action_type,
        originalEvidenceSha256: existing.evidence_sha256,
      },
      createdAt: timestamp,
    });

    return { case: removedCase, audit };
  });

  return {
    raw: db,
    ensureGuild,
    getConfig(guildId) {
      return ensureGuild(guildId);
    },
    setChannels(input) {
      return setChannelsTransaction(input);
    },
    getAccess(guildId, userId) {
      ensureGuild(guildId);
      return stmt.getWhitelist.get(guildId, userId)?.access_level ?? null;
    },
    listWhitelist(guildId) {
      ensureGuild(guildId);
      return stmt.listWhitelist.all(guildId);
    },
    setWhitelist(input) {
      return setWhitelistTransaction(input);
    },
    removeWhitelist(input) {
      return removeWhitelistTransaction(input);
    },
    createCase(input) {
      return createCaseTransaction(input);
    },
    setEvidenceMirror(input) {
      return setEvidenceMirrorTransaction(input);
    },
    getCase(guildId, caseNumber) {
      ensureGuild(guildId);
      const found = stmt.getCase.get(guildId, caseNumber);
      if (!found) return null;
      return {
        ...found,
        amendments: stmt.getAmendments.all(guildId, found.id),
      };
    },
    listCases(guildId, staffUserId, includeRemoved = false) {
      ensureGuild(guildId);
      return includeRemoved
        ? stmt.listCasesAll.all(guildId, staffUserId)
        : stmt.listCasesActive.all(guildId, staffUserId);
    },
    amendCase(input) {
      return amendCaseTransaction(input);
    },
    removeCase(input) {
      return removeCaseTransaction(input);
    },
    recentAudit(guildId, limit = 10) {
      ensureGuild(guildId);
      return stmt.recentAudit.all(guildId, Math.min(Math.max(limit, 1), 20));
    },
    recentRemoved(guildId, limit = 10) {
      ensureGuild(guildId);
      return stmt.recentRemoved.all(guildId, Math.min(Math.max(limit, 1), 20));
    },
    appendAudit(input) {
      ensureGuild(input.guildId);
      return transaction(() => appendAuditCore(input))();
    },
    verifyAudit(guildId) {
      ensureGuild(guildId);
      const rows = stmt.allAudit.all(guildId);
      let previousHash = 'GENESIS';

      for (const row of rows) {
        if (row.previous_hash !== previousHash) {
          return {
            valid: false,
            checked: rows.length,
            brokenAtId: row.id,
            reason: 'previous hash does not match',
          };
        }

        const expected = auditHash({
          guildId: row.guild_id,
          eventType: row.event_type,
          actorUserId: row.actor_user_id,
          targetUserId: row.target_user_id,
          caseNumber: row.case_number,
          payloadJson: row.payload_json,
          previousHash: row.previous_hash,
          createdAt: row.created_at,
        });

        if (expected !== row.entry_hash) {
          return {
            valid: false,
            checked: rows.length,
            brokenAtId: row.id,
            reason: 'entry hash does not match its contents',
          };
        }

        previousHash = row.entry_hash;
      }

      return {
        valid: true,
        checked: rows.length,
        finalHash: previousHash,
      };
    },
    close() {
      db.close();
    },
  };
}
