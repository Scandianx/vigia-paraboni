'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SampleAggregator,
  loadDashboardData,
  listIncidents,
  safeIncidentId
} = require('../src/dashboard-data');

function sample(timestampUtc, cpuPercent, targetCpu) {
  return {
    timestampUtc,
    system: {
      cpuPercent,
      availableMemoryPercent: 70 - cpuPercent / 10,
      diskQueueLength: cpuPercent / 100,
      pagesPerSec: 0
    },
    collectorWarnings: [],
    targets: [{
      id: 'api', label: 'API', found: true, pids: [42],
      cpuPercent: targetCpu, privateMemoryMb: 128, health: []
    }]
  };
}

test('agrega métricas e reduz amostras para pontos de gráfico', () => {
  const from = Date.parse('2026-01-01T10:00:00.000Z');
  const aggregator = new SampleAggregator(from, from + 60000, 2);
  aggregator.add(sample('2026-01-01T10:00:05.000Z', 20, 10));
  aggregator.add(sample('2026-01-01T10:00:15.000Z', 40, 30));
  aggregator.add(sample('2026-01-01T10:00:45.000Z', 80, 50));
  const result = aggregator.result();
  assert.equal(result.meta.sampleCount, 3);
  assert.equal(result.series.length, 2);
  assert.equal(result.summary.system.averageCpuPercent, 46.67);
  assert.equal(result.summary.system.maxCpuPercent, 80);
  assert.equal(result.summary.targets[0].maxCpuPercent, 50);
});

test('carrega JSONL e incidentes do diretório configurado', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigia-dashboard-'));
  const samplesDirectory = path.join(directory, 'samples');
  const incidentDirectory = path.join(directory, 'incidents', '2026-01-01T10-00-00-000Z');
  fs.mkdirSync(samplesDirectory, { recursive: true });
  fs.mkdirSync(incidentDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(samplesDirectory, 'monitor-2026-01-01-001.jsonl'),
    `${JSON.stringify(sample('2026-01-01T10:00:05.000Z', 30, 12))}\nlinha-incompleta`,
    'utf8'
  );
  fs.writeFileSync(path.join(incidentDirectory, 'summary.json'), JSON.stringify({
    status: 'complete', startedAt: '2026-01-01T10:00:00.000Z', reasons: ['CPU alta']
  }));

  const data = await loadDashboardData(directory, {
    fromMs: Date.parse('2026-01-01T09:00:00.000Z'),
    toMs: Date.parse('2026-01-01T11:00:00.000Z'),
    maxPoints: 120
  });
  const incidents = await listIncidents(directory);
  assert.equal(data.meta.sampleCount, 1);
  assert.equal(incidents.length, 1);
  assert.deepEqual(incidents[0].reasons, ['CPU alta']);
});

test('rejeita identificador de incidente com travessia de diretório', () => {
  assert.equal(safeIncidentId('2026-01-01T10-00-00-000Z'), true);
  assert.equal(safeIncidentId('../config.json'), false);
  assert.equal(safeIncidentId('pasta/arquivo'), false);
});
