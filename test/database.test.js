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
