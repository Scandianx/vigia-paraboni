'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildObservedSample } = require('../src/index');

test('amostra agrega processo e não persiste linha de comando', () => {
  const config = {
    collector: { intervalSeconds: 5 },
    targets: [{
      id: 'api', label: 'API', processNames: ['node.exe'], serviceNames: [],
      executablePathIncludes: [], commandLineIncludes: ['server.js']
    }]
  };
  const raw = {
    timestampUtc: '2026-01-01T10:00:00.000Z',
    logicalProcessors: 4,
    system: { cpuPercent: 10 },
    processes: [{
      pid: 42, instance: 'node', cpuRawPercent: 200,
      workingSetBytes: 104857600, privateBytes: 52428800,
      threads: 10, handles: 20, ioReadBytesPerSec: 100, ioWriteBytesPerSec: 200
    }],
    collectorWarnings: []
  };
  const catalog = [{
    pid: 42, name: 'node.exe', executablePath: 'C:\\node.exe',
    commandLine: 'node secret-token server.js', serviceNames: []
  }];
  const observed = buildObservedSample(raw, catalog, { config }, new Map([['api', []]]), null);
  assert.equal(observed.targets[0].found, true);
  assert.equal(observed.targets[0].cpuPercent, 50);
  assert.equal(observed.targets[0].privateMemoryMb, 50);
  assert.equal(JSON.stringify(observed).includes('secret-token'), false);
});
