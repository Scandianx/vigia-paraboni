'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SustainedDetector } = require('../src/detector');

function config() {
  return {
    thresholds: {
      consecutiveSamples: 3,
      systemCpuPercent: 90,
      availableMemoryPercent: 10,
      sampleDelaySeconds: 15,
      healthConsecutiveFailures: 2
    },
    targets: [{ id: 'api', label: 'API', maxCpuPercent: null, maxPrivateMemoryMb: null }]
  };
}

function sample(cpu = 50) {
  return {
    sampleDelayMs: 0,
    system: { cpuPercent: cpu, availableMemoryPercent: 50 },
    targets: [{ id: 'api', health: [] }]
  };
}

test('exige amostras consecutivas antes de sinalizar CPU', () => {
  const detector = new SustainedDetector(config());
  assert.deepEqual(detector.evaluate(sample(95)), []);
  assert.deepEqual(detector.evaluate(sample(95)), []);
  assert.match(detector.evaluate(sample(95))[0], /CPU/);
  assert.equal(detector.evaluate(sample(20)).length, 0);
});

test('sinaliza atraso grande imediatamente', () => {
  const detector = new SustainedDetector(config());
  const delayed = sample();
  delayed.sampleDelayMs = 16000;
  assert.match(detector.evaluate(delayed)[0], /atrasou/);
});

test('health check respeita limite próprio', () => {
  const detector = new SustainedDetector(config());
  const failing = sample();
  failing.targets[0].health = [{ url: 'http://local/health', ok: false, error: 'timeout' }];
  assert.deepEqual(detector.evaluate(failing), []);
  assert.match(detector.evaluate(failing)[0], /health check/);
});

test('sinaliza desaparecimento somente depois de ter visto o processo', () => {
  const detector = new SustainedDetector(config());
  const present = sample();
  present.targets[0].found = true;
  detector.evaluate(present);
  const missing = sample();
  missing.targets[0].found = false;
  detector.evaluate(missing);
  detector.evaluate(missing);
  assert.match(detector.evaluate(missing)[0], /não foi encontrado/);
});
