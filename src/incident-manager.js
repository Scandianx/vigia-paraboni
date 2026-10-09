'use strict';

const fs = require('node:fs');
const path = require('node:path');

function safeTimestamp(value) {
  return value.replace(/[:.]/g, '-');
}

class RingBuffer {
  constructor(maxItems) {
    this.maxItems = Math.max(1, maxItems);
    this.items = [];
  }

  push(value) {
    this.items.push(value);
    if (this.items.length > this.maxItems) this.items.shift();
  }

  snapshot() {
    return [...this.items];
  }
}

class IncidentManager {
  constructor(config) {
    this.config = config;
    const maxSamples = Math.ceil(
      config.storage.preIncidentMinutes * 60 / config.collector.intervalSeconds
    );
    this.buffer = new RingBuffer(maxSamples);
    this.active = null;
    this.lastStartedAt = 0;
  }

  async observe(sample, reasons) {
    this.buffer.push(sample);
    if (this.active) {
      await fs.promises.appendFile(this.active.afterPath, `${JSON.stringify(sample)}\n`, 'utf8');
      if (Date.now() >= this.active.endsAt) await this.finish();
      return null;
    }

    if (!reasons.length) return null;
    const cooldownMs = this.config.storage.incidentCooldownMinutes * 60 * 1000;
    if (Date.now() - this.lastStartedAt < cooldownMs) return null;
    return this.start(sample, reasons);
  }

  async start(sample, reasons) {
    const timestamp = sample.timestampUtc || new Date().toISOString();
    const directory = path.join(
      this.config.storage.directory,
      'incidents',
      safeTimestamp(timestamp)
    );
    await fs.promises.mkdir(directory, { recursive: true });
    const beforePath = path.join(directory, 'samples-before.jsonl');
    const afterPath = path.join(directory, 'samples-after.jsonl');
    const summaryPath = path.join(directory, 'summary.json');
    const before = this.buffer.snapshot().map((item) => JSON.stringify(item)).join('\n');
    await fs.promises.writeFile(beforePath, before ? `${before}\n` : '', 'utf8');
    await fs.promises.writeFile(afterPath, '', 'utf8');

    this.active = {
      directory,
      beforePath,
      afterPath,
      summaryPath,
      startedAt: timestamp,
      endsAt: Date.now() + this.config.storage.postIncidentMinutes * 60 * 1000,
      reasons
    };
    this.lastStartedAt = Date.now();
    await this.writeSummary('collecting');
    return directory;
  }

  async writeSummary(status) {
    if (!this.active) return;
    const summary = {
      status,
      startedAt: this.active.startedAt,
      completedAt: status === 'complete' ? new Date().toISOString() : null,
      reasons: this.active.reasons,
      configPath: this.config.configPath,
      hostname: process.env.COMPUTERNAME || null
    };
    await fs.promises.writeFile(this.active.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  async finish() {
    if (!this.active) return;
    await this.writeSummary('complete');
    const directory = this.active.directory;
    this.active = null;
    return directory;
  }
}

module.exports = { RingBuffer, IncidentManager, safeTimestamp };
