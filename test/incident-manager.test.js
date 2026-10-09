'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RingBuffer, IncidentManager } = require('../src/incident-manager');

test('ring buffer mantém somente as amostras mais recentes', () => {
  const buffer = new RingBuffer(2);
  buffer.push(1);
  buffer.push(2);
  buffer.push(3);
  assert.deepEqual(buffer.snapshot(), [2, 3]);
});

test('incidente grava buffer anterior e resumo', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paraboni-monitor-'));
  const manager = new IncidentManager({
    configPath: 'config.json',
    collector: { intervalSeconds: 5 },
    storage: {
      directory,
      preIncidentMinutes: 1,
      postIncidentMinutes: 1,
      incidentCooldownMinutes: 10
    }
  });
  await manager.observe({ timestampUtc: '2026-01-01T10:00:00.000Z', value: 1 }, []);
  const incidentPath = await manager.observe(
    { timestampUtc: '2026-01-01T10:00:05.000Z', value: 2 },
    ['teste']
  );
  assert.ok(incidentPath);
  const before = fs.readFileSync(path.join(incidentPath, 'samples-before.jsonl'), 'utf8');
  assert.match(before, /"value":1/);
  assert.match(before, /"value":2/);
  const summary = JSON.parse(fs.readFileSync(path.join(incidentPath, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'collecting');
  assert.deepEqual(summary.reasons, ['teste']);
  await manager.finish();
});
