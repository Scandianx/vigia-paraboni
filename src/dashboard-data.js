'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const SYSTEM_METRICS = [
  'cpuPercent',
  'availableMemoryPercent',
  'committedMemoryPercent',
  'pagesPerSec',
  'diskBusyPercent',
  'diskQueueLength',
  'diskReadBytesPerSec',
  'diskWriteBytesPerSec'
];

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function addMetric(container, key, value) {
  const number = finite(value);
  if (number == null) return;
  container[key] ??= { sum: 0, count: 0, min: number, max: number };
  const metric = container[key];
  metric.sum += number;
  metric.count += 1;
  metric.min = Math.min(metric.min, number);
  metric.max = Math.max(metric.max, number);
}

function metricValue(metric, mode = 'average') {
  if (!metric || !metric.count) return null;
  if (mode === 'min') return metric.min;
  if (mode === 'max') return metric.max;
  return metric.sum / metric.count;
}

function rounded(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function createTargetAggregate(target) {
  return {
    id: target.id,
    label: target.label || target.id,
    metrics: {},
    samples: 0,
    foundSamples: 0,
    lastFound: false,
    pids: [],
    health: []
  };
}

function addTarget(aggregate, target) {
  aggregate.samples += 1;
  if (target.found) aggregate.foundSamples += 1;
  aggregate.lastFound = Boolean(target.found);
  aggregate.pids = Array.isArray(target.pids) ? target.pids : [];
  aggregate.health = Array.isArray(target.health) ? target.health : [];
  addMetric(aggregate.metrics, 'cpuPercent', target.cpuPercent);
  addMetric(aggregate.metrics, 'privateMemoryMb', target.privateMemoryMb);
}

function targetPoint(aggregate) {
  return {
    id: aggregate.id,
    label: aggregate.label,
    found: aggregate.lastFound,
    pids: aggregate.pids,
    cpuPercent: rounded(metricValue(aggregate.metrics.cpuPercent)),
    privateMemoryMb: rounded(metricValue(aggregate.metrics.privateMemoryMb)),
    health: aggregate.health
  };
}

function targetSummary(aggregate) {
  const failedHealth = aggregate.health.filter((item) => item && item.ok === false).length;
  return {
    id: aggregate.id,
    label: aggregate.label,
    found: aggregate.lastFound,
    pids: aggregate.pids,
    availabilityPercent: aggregate.samples
      ? rounded((aggregate.foundSamples / aggregate.samples) * 100)
      : null,
    averageCpuPercent: rounded(metricValue(aggregate.metrics.cpuPercent)),
    maxCpuPercent: rounded(metricValue(aggregate.metrics.cpuPercent, 'max')),
    averagePrivateMemoryMb: rounded(metricValue(aggregate.metrics.privateMemoryMb)),
    maxPrivateMemoryMb: rounded(metricValue(aggregate.metrics.privateMemoryMb, 'max')),
    healthOk: aggregate.health.length ? failedHealth === 0 : null
  };
}

class SampleAggregator {
  constructor(fromMs, toMs, maxPoints) {
    this.fromMs = fromMs;
    this.toMs = toMs;
    this.maxPoints = maxPoints;
    this.bucketSizeMs = Math.max(1, Math.ceil((toMs - fromMs) / maxPoints));
    this.buckets = new Map();
    this.system = {};
    this.targets = new Map();
    this.sampleCount = 0;
    this.warningSamples = 0;
    this.latest = null;
    this.availableFrom = null;
    this.availableTo = null;
  }

  add(sample) {
    const timestamp = Date.parse(sample.timestampUtc);
    if (!Number.isFinite(timestamp)) return;
    this.availableFrom = this.availableFrom == null ? timestamp : Math.min(this.availableFrom, timestamp);
    this.availableTo = this.availableTo == null ? timestamp : Math.max(this.availableTo, timestamp);
    if (timestamp < this.fromMs || timestamp > this.toMs) return;

    this.sampleCount += 1;
    this.latest = !this.latest || Date.parse(this.latest.timestampUtc) <= timestamp ? sample : this.latest;
    if (Array.isArray(sample.collectorWarnings) && sample.collectorWarnings.length) this.warningSamples += 1;
    for (const key of SYSTEM_METRICS) addMetric(this.system, key, sample.system?.[key]);

    for (const target of sample.targets || []) {
      if (!this.targets.has(target.id)) this.targets.set(target.id, createTargetAggregate(target));
      addTarget(this.targets.get(target.id), target);
    }

    const bucketIndex = Math.min(this.maxPoints - 1, Math.floor((timestamp - this.fromMs) / this.bucketSizeMs));
    if (!this.buckets.has(bucketIndex)) {
      this.buckets.set(bucketIndex, {
        timestampSum: 0,
        count: 0,
        system: {},
        targets: new Map()
      });
    }
    const bucket = this.buckets.get(bucketIndex);
    bucket.timestampSum += timestamp;
    bucket.count += 1;
    for (const key of SYSTEM_METRICS) addMetric(bucket.system, key, sample.system?.[key]);
    for (const target of sample.targets || []) {
      if (!bucket.targets.has(target.id)) bucket.targets.set(target.id, createTargetAggregate(target));
      addTarget(bucket.targets.get(target.id), target);
    }
  }

  result() {
    const series = [...this.buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, bucket]) => ({
        timestampUtc: new Date(bucket.timestampSum / bucket.count).toISOString(),
        system: Object.fromEntries(SYSTEM_METRICS.map((key) => [
          key,
          rounded(metricValue(bucket.system[key]))
        ])),
        targets: [...bucket.targets.values()].map(targetPoint)
      }));

    return {
      meta: {
        from: new Date(this.fromMs).toISOString(),
        to: new Date(this.toMs).toISOString(),
        sampleCount: this.sampleCount,
        pointCount: series.length,
        warningSamples: this.warningSamples,
        availableFrom: this.availableFrom == null ? null : new Date(this.availableFrom).toISOString(),
        availableTo: this.availableTo == null ? null : new Date(this.availableTo).toISOString()
      },
      summary: {
        system: {
          averageCpuPercent: rounded(metricValue(this.system.cpuPercent)),
          maxCpuPercent: rounded(metricValue(this.system.cpuPercent, 'max')),
          minimumAvailableMemoryPercent: rounded(metricValue(this.system.availableMemoryPercent, 'min')),
          maxDiskQueueLength: rounded(metricValue(this.system.diskQueueLength, 'max')),
          maxPagesPerSec: rounded(metricValue(this.system.pagesPerSec, 'max'))
        },
        targets: [...this.targets.values()].map(targetSummary)
      },
      latest: this.latest,
      series
    };
  }
}

async function listSampleFiles(directory) {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('monitor-') && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function aggregateJsonlFiles(filePaths, options) {
  const aggregator = new SampleAggregator(options.fromMs, options.toMs, options.maxPoints);
  for (const filePath of filePaths) {
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        aggregator.add(JSON.parse(line));
      } catch {
        // A partial final line can exist if the monitor is writing while the dashboard reads.
      }
    }
  }
  return aggregator.result();
}

async function loadDashboardData(storageDirectory, options = {}) {
  const now = Date.now();
  const toMs = Number.isFinite(options.toMs) ? options.toMs : now;
  const fromMs = Number.isFinite(options.fromMs) ? options.fromMs : toMs - 6 * 60 * 60 * 1000;
  const maxPoints = Math.min(1440, Math.max(120, Number(options.maxPoints) || 720));
  const files = await listSampleFiles(path.join(storageDirectory, 'samples'));
  return aggregateJsonlFiles(files, { fromMs, toMs, maxPoints });
}

async function listIncidents(storageDirectory) {
  const incidentsDirectory = path.join(storageDirectory, 'incidents');
  let entries;
  try {
    entries = await fs.promises.readdir(incidentsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const incidents = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(incidentsDirectory, entry.name);
    try {
      const summary = JSON.parse(await fs.promises.readFile(path.join(directory, 'summary.json'), 'utf8'));
      const files = await fs.promises.readdir(directory);
      incidents.push({ id: entry.name, ...summary, files: files.sort() });
    } catch {
      incidents.push({ id: entry.name, status: 'incomplete', reasons: [], files: [] });
    }
  }
  return incidents.sort((a, b) => String(b.startedAt || b.id).localeCompare(String(a.startedAt || a.id)));
}

function safeIncidentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value) && path.basename(value) === value;
}

async function loadIncident(storageDirectory, incidentId, maxPoints = 600) {
  if (!safeIncidentId(incidentId)) throw new Error('Identificador de incidente inválido.');
  const directory = path.join(storageDirectory, 'incidents', incidentId);
  const summary = JSON.parse(await fs.promises.readFile(path.join(directory, 'summary.json'), 'utf8'));
  const sampleFiles = ['samples-before.jsonl', 'samples-after.jsonl']
    .map((name) => path.join(directory, name))
    .filter((filePath) => fs.existsSync(filePath));
  const fromMs = Date.parse(summary.startedAt) - 15 * 60 * 1000;
  const toMs = Date.parse(summary.completedAt || summary.startedAt) + 15 * 60 * 1000;
  const data = await aggregateJsonlFiles(sampleFiles, {
    fromMs: Number.isFinite(fromMs) ? fromMs : 0,
    toMs: Number.isFinite(toMs) ? toMs : Date.now(),
    maxPoints: Math.min(1000, Math.max(120, maxPoints))
  });
  const files = await fs.promises.readdir(directory);
  return { id: incidentId, summary, files: files.sort(), data };
}

module.exports = {
  SYSTEM_METRICS,
  SampleAggregator,
  aggregateJsonlFiles,
  loadDashboardData,
  listIncidents,
  loadIncident,
  safeIncidentId,
  rounded
};
