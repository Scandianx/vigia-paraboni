'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { matchTargets, selectorWarnings } = require('./target-matcher');
const { SustainedDetector } = require('./detector');
const { HealthScheduler } = require('./health');
const { RotatingJsonlWriter, removeExpiredFiles } = require('./rotating-writer');
const { IncidentManager } = require('./incident-manager');
const { WindowsCollector, runLogman } = require('./windows-collector');
const { captureEventLogs } = require('./event-logs');

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function buildObservedSample(raw, catalog, targets, healthByTarget, lastTimestampMs) {
  const timestampMs = Date.parse(raw.timestampUtc);
  const expectedGap = targets.config.collector.intervalSeconds * 1000;
  const sampleDelayMs = lastTimestampMs
    ? Math.max(0, timestampMs - lastTimestampMs - expectedGap)
    : 0;
  const logicalProcessors = Math.max(1, Number(raw.logicalProcessors) || 1);
  const perfByPid = new Map((raw.processes || []).map((item) => [Number(item.pid), item]));
  const matches = matchTargets(catalog, targets.config.targets);

  const observedTargets = targets.config.targets.map((target) => {
    const processInfos = matches.get(target.id) || [];
    const processes = processInfos.map((info) => {
      const perf = perfByPid.get(Number(info.pid)) || {};
      return {
        pid: Number(info.pid),
        name: info.name,
        serviceNames: info.serviceNames || [],
        cpuRawPercent: round(perf.cpuRawPercent),
        cpuPercent: round(Number(perf.cpuRawPercent || 0) / logicalProcessors),
        workingSetMb: round(Number(perf.workingSetBytes || 0) / 1024 / 1024),
        privateMemoryMb: round(Number(perf.privateBytes || 0) / 1024 / 1024),
        threads: round(perf.threads, 0),
        handles: round(perf.handles, 0),
        ioReadBytesPerSec: round(perf.ioReadBytesPerSec, 0),
        ioWriteBytesPerSec: round(perf.ioWriteBytesPerSec, 0),
        startedAt: info.creationDate || null
      };
    });
    return {
      id: target.id,
      label: target.label || target.id,
      found: processes.length > 0,
      pids: processes.map((item) => item.pid),
      cpuPercent: round(processes.reduce((sum, item) => sum + (item.cpuPercent || 0), 0)),
      privateMemoryMb: round(processes.reduce((sum, item) => sum + (item.privateMemoryMb || 0), 0)),
      processes,
      health: healthByTarget.get(target.id) || []
    };
  });

  const topProcesses = (raw.processes || [])
    .map((perf) => {
      const info = catalog.find((item) => Number(item.pid) === Number(perf.pid));
      return {
        pid: Number(perf.pid),
        name: info?.name || perf.instance,
        cpuPercent: round(Number(perf.cpuRawPercent || 0) / logicalProcessors),
        privateMemoryMb: round(Number(perf.privateBytes || 0) / 1024 / 1024),
        ioBytesPerSec: round(Number(perf.ioReadBytesPerSec || 0) + Number(perf.ioWriteBytesPerSec || 0), 0)
      };
    })
    .sort((a, b) => (b.cpuPercent || 0) - (a.cpuPercent || 0))
    .slice(0, 10);

  return {
    schemaVersion: 1,
    timestampUtc: raw.timestampUtc,
    receivedAtUtc: new Date().toISOString(),
    collectionDurationMs: raw.collectionDurationMs,
    sampleDelayMs,
    logicalProcessors,
    system: raw.system,
    collectorWarnings: raw.collectorWarnings || [],
    targets: observedTargets,
    topProcesses
  };
}

async function main() {
  let config;
  try {
    const configArgument = process.argv.find((arg) => arg.startsWith('--config='));
    config = loadConfig(configArgument ? configArgument.slice('--config='.length) : undefined);
  } catch (error) {
    console.error(`[config] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Configuração válida: ${config.configPath}`);
  for (const warning of selectorWarnings(config.targets)) console.warn(`[aviso] ${warning}`);
  const serializedConfig = JSON.stringify(config.targets);
  if (serializedConfig.includes('SUBSTITUIR-')) {
    console.warn('[aviso] A configuração ainda contém valores SUBSTITUIR-. Ajuste os seletores antes de monitorar.');
  }
  if (process.argv.includes('--check-config')) return;

  fs.mkdirSync(config.storage.directory, { recursive: true });
  const samplesDirectory = path.join(config.storage.directory, 'samples');
  const writer = new RotatingJsonlWriter(samplesDirectory, config.storage.maxLogFileMb);
  const incidentManager = new IncidentManager(config);
  const detector = new SustainedDetector(config);
  const health = new HealthScheduler(config.targets);
  let catalog = [];
  let lastTimestampMs = null;
  const reportedCollectorWarnings = new Set();
  let queue = Promise.resolve();
  let shuttingDown = false;

  await removeExpiredFiles(samplesDirectory, config.storage.retentionDays);
  const cleanupTimer = setInterval(() => {
    removeExpiredFiles(samplesDirectory, config.storage.retentionDays)
      .catch((error) => console.error(`[retenção] ${error.message}`));
  }, 6 * 60 * 60 * 1000);
  cleanupTimer.unref();

  if (config.perfmon.startWithMonitor && config.perfmon.collectorName) {
    try {
      await runLogman('start', config.perfmon.collectorName);
      console.log(`PerfMon iniciado: ${config.perfmon.collectorName}`);
    } catch (error) {
      console.error(`[perfmon] Não foi possível iniciar: ${error.message}`);
    }
  }

  const collector = new WindowsCollector(config, {
    onMessage(message) {
      queue = queue.then(async () => {
        if (message.type === 'collector-error') {
          console.error(`[coletor] ${message.message}`);
          return;
        }
        if (Array.isArray(message.catalog)) catalog = message.catalog;
        const healthResults = await health.collect();
        const sample = buildObservedSample(
          message,
          catalog,
          { config },
          healthResults,
          lastTimestampMs
        );
        lastTimestampMs = Date.parse(message.timestampUtc);
        const currentWarnings = sample.collectorWarnings || [];
        const newWarnings = currentWarnings.filter((warning) => !reportedCollectorWarnings.has(warning));
        if (newWarnings.length) {
          console.error(`[coletor] ${newWarnings.join('; ')}`);
          newWarnings.forEach((warning) => reportedCollectorWarnings.add(warning));
        }
        if (!currentWarnings.length && reportedCollectorWarnings.size) {
          console.log('[coletor] Fontes CIM voltaram a responder.');
          reportedCollectorWarnings.clear();
        }
        await writer.append(sample);
        const reasons = detector.evaluate(sample);
        const incidentDirectory = await incidentManager.observe(sample, reasons);
        if (incidentDirectory) {
          console.warn(`[incidente] ${reasons.join('; ')} -> ${incidentDirectory}`);
          captureEventLogs(incidentDirectory).then(async (results) => {
            await fs.promises.writeFile(
              path.join(incidentDirectory, 'event-log-export.json'),
              `${JSON.stringify(results, null, 2)}\n`,
              'utf8'
            );
          }).catch((error) => console.error(`[eventos] ${error.message}`));
        }
      }).catch((error) => console.error(`[amostra] ${error.stack || error.message}`));
    },
    onError(error) {
      console.error(`[coletor] ${error.message}`);
    }
  });

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Encerrando (${signal})...`);
    collector.stop();
    clearInterval(cleanupTimer);
    await queue;
    await incidentManager.finish();
    await writer.close();
    if (config.perfmon.stopWithMonitor && config.perfmon.collectorName) {
      try {
        await runLogman('stop', config.perfmon.collectorName);
      } catch (error) {
        console.error(`[perfmon] Não foi possível parar: ${error.message}`);
      }
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
  process.on('uncaughtException', (error) => {
    console.error(error.stack || error.message);
    shutdown('uncaughtException').finally(() => process.exit(1));
  });

  collector.start();
  console.log(`Monitor iniciado; dados em ${config.storage.directory}`);
}

if (require.main === module) main();

module.exports = { buildObservedSample, round, main };
