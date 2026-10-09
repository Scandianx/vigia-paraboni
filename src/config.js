'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  collector: {
    intervalSeconds: 5,
    catalogRefreshSeconds: 30,
    powershellExecutable: 'powershell.exe'
  },
  storage: {
    directory: '.\\data',
    maxLogFileMb: 100,
    retentionDays: 14,
    preIncidentMinutes: 5,
    postIncidentMinutes: 2,
    incidentCooldownMinutes: 10
  },
  thresholds: {
    consecutiveSamples: 6,
    systemCpuPercent: 90,
    availableMemoryPercent: 10,
    sampleDelaySeconds: 15,
    healthConsecutiveFailures: 3
  },
  targets: [],
  perfmon: {
    collectorName: null,
    startWithMonitor: false,
    stopWithMonitor: false
  }
};

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key]) {
      result[key] = merge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function assertPositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} deve ser maior que zero.`);
}

function validateConfig(config) {
  assertPositive(config.collector.intervalSeconds, 'collector.intervalSeconds');
  assertPositive(config.collector.catalogRefreshSeconds, 'collector.catalogRefreshSeconds');
  assertPositive(config.storage.maxLogFileMb, 'storage.maxLogFileMb');
  assertPositive(config.storage.retentionDays, 'storage.retentionDays');
  assertPositive(config.storage.preIncidentMinutes, 'storage.preIncidentMinutes');
  assertPositive(config.storage.postIncidentMinutes, 'storage.postIncidentMinutes');
  assertPositive(config.thresholds.consecutiveSamples, 'thresholds.consecutiveSamples');

  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    throw new Error('Configure ao menos um item em targets.');
  }

  const ids = new Set();
  for (const target of config.targets) {
    if (!target.id || !/^[a-zA-Z0-9_-]+$/.test(target.id)) {
      throw new Error('Cada target precisa de id contendo somente letras, números, _ ou -.');
    }
    if (ids.has(target.id)) throw new Error(`Target duplicado: ${target.id}`);
    ids.add(target.id);

    const selectors = ['serviceNames', 'processNames', 'executablePathIncludes', 'commandLineIncludes'];
    for (const selector of selectors) {
      if (target[selector] != null && !Array.isArray(target[selector])) {
        throw new Error(`${target.id}.${selector} deve ser uma lista.`);
      }
    }
    const hasSelector = selectors.some((key) => Array.isArray(target[key]) && target[key].length > 0);
    if (!hasSelector) throw new Error(`Target ${target.id} não possui seletor de processo.`);

    target.healthChecks ??= [];
  }

  return config;
}

function loadConfig(configPath = process.env.PARABONI_MONITOR_CONFIG || 'config.json') {
  const absolutePath = path.resolve(configPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Configuração não encontrada: ${absolutePath}. Copie config.example.json para config.json.`);
  }
  const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  const config = validateConfig(merge(DEFAULTS, parsed));
  config.storage.directory = path.resolve(path.dirname(absolutePath), config.storage.directory);
  config.configPath = absolutePath;
  return config;
}

module.exports = { loadConfig, validateConfig, merge, DEFAULTS };
