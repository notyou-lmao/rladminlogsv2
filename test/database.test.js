import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase } from '../src/database.js';

test('creates, amends, removes, and verifies a case without deleting history', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-ledger-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'), 100);
  const guildId = '111111111111111111';
  const actorUserId = '222222222222222222';
  const staffUserId = '333333333333333333';

  db.setChannels({
    guildId,
    commandChannelId: '444444444444444444',
    auditChannelId: '555555555555555555',
    removedChannelId: '666666666666666666',
    evidenceChannelId: '777777777777777777',
    actorUserId,
  });

  const created = db.createCase({
    guildId,
    staffUserId,
    actionType: 'warning',
    reason: 'test reason',
    actorUserId,
    evidence: {
      originalName: 'proof.png',
      storedName: 'stored-proof.png',
      contentType: 'image/png',
      size: 123,
      sha256: 'a'.repeat(64),
    },
  });

  assert.equal(created.case.case_number, 100);
  assert.equal(db.getCase(guildId, 100).reason, 'test reason');

  db.amendCase({
    guildId,
    caseNumber: 100,
    note: 'clarification',
    actorUserId,
  });
  assert.equal(db.getCase(guildId, 100).amendments.length, 1);

  db.removeCase({
    guildId,
    caseNumber: 100,
    reason: 'issued in error',
    actorUserId,
  });

  const removed = db.getCase(guildId, 100);
  assert.ok(removed.removed_at);
  assert.equal(db.listCases(guildId, staffUserId, false).length, 0);
  assert.equal(db.listCases(guildId, staffUserId, true).length, 1);
  assert.equal(db.recentRemoved(guildId, 10).length, 1);
  assert.equal(db.verifyAudit(guildId).valid, true);

  assert.throws(
    () => db.raw.prepare('DELETE FROM cases WHERE id = ?').run(removed.id),
    /cannot be physically deleted/,
  );

  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('detects tampering when an audit trigger is deliberately bypassed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-ledger-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'), 100);
  const guildId = '111111111111111111';

  db.appendAudit({
    guildId,
    eventType: 'TEST_ENTRY',
    actorUserId: '222222222222222222',
    payload: { ok: true },
  });
  assert.equal(db.verifyAudit(guildId).valid, true);

  db.raw.exec('DROP TRIGGER audit_log_no_update');
  db.raw.prepare("UPDATE audit_log SET payload_json = '{\"ok\":false}' WHERE id = 1").run();
  assert.equal(db.verifyAudit(guildId).valid, false);

  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('migrates an existing case database and supports hiring and promotion actions', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-ledger-migrate-'));
  const databasePath = path.join(directory, 'test.sqlite');
  const guildId = '111111111111111111';
  const actorUserId = '222222222222222222';
  const staffUserId = '333333333333333333';

  const oldDb = new DatabaseSync(databasePath);
  oldDb.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE guild_config (
      guild_id TEXT PRIMARY KEY,
      command_channel_id TEXT,
      audit_channel_id TEXT,
      removed_channel_id TEXT,
      evidence_channel_id TEXT,
      next_case_number INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      case_number INTEGER NOT NULL,
      staff_user_id TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK(
        action_type IN ('warning', 'strike', 'suspension', 'demotion', 'fired')
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

    CREATE TABLE case_amendments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      case_id INTEGER NOT NULL,
      note TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (guild_id) REFERENCES guild_config(guild_id),
      FOREIGN KEY (case_id) REFERENCES cases(id)
    );

    CREATE TABLE removed_actions (
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
  `);

  const timestamp = new Date().toISOString();
  oldDb.prepare(`
    INSERT INTO guild_config (
      guild_id, next_case_number, created_at, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run(guildId, 101, timestamp, timestamp);
  oldDb.prepare(`
    INSERT INTO cases (
      guild_id, case_number, staff_user_id, action_type, reason,
      effective_at, created_by, created_at, evidence_original_name,
      evidence_stored_name, evidence_content_type, evidence_size,
      evidence_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId,
    100,
    staffUserId,
    'warning',
    'existing warning',
    timestamp,
    actorUserId,
    timestamp,
    'proof.png',
    'old-proof.png',
    'image/png',
    100,
    'a'.repeat(64),
  );
  oldDb.close();

  const db = createDatabase(databasePath, 100);
  assert.equal(db.getCase(guildId, 100).reason, 'existing warning');

  const hiring = db.createCase({
    guildId,
    staffUserId,
    actionType: 'hiring',
    reason: 'completed onboarding',
    newRank: 'junior moderator',
    actorUserId,
    evidence: {
      originalName: 'hire.png',
      storedName: 'hire-proof.png',
      contentType: 'image/png',
      size: 101,
      sha256: 'b'.repeat(64),
    },
  });

  const promotion = db.createCase({
    guildId,
    staffUserId,
    actionType: 'promotion',
    reason: 'consistent leadership',
    previousRank: 'junior moderator',
    newRank: 'moderator',
    actorUserId,
    evidence: {
      originalName: 'promote.png',
      storedName: 'promote-proof.png',
      contentType: 'image/png',
      size: 102,
      sha256: 'c'.repeat(64),
    },
  });

  assert.equal(hiring.case.case_number, 101);
  assert.equal(hiring.case.new_rank, 'junior moderator');
  assert.equal(promotion.case.case_number, 102);
  assert.equal(promotion.case.previous_rank, 'junior moderator');
  assert.equal(promotion.case.new_rank, 'moderator');
  assert.equal(db.listCases(guildId, staffUserId, true).length, 3);
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.verifyAudit(guildId).valid, true);

  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
