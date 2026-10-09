'use strict';

const fs = require('node:fs');
const path = require('node:path');

function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

class RotatingJsonlWriter {
  constructor(directory, maxFileMb) {
    this.directory = directory;
    this.maxBytes = maxFileMb * 1024 * 1024;
    this.sequence = 0;
    this.currentDate = null;
    this.currentPath = null;
    this.currentBytes = 0;
    this.queue = Promise.resolve();
    fs.mkdirSync(directory, { recursive: true });
  }

  chooseFile(now, additionalBytes) {
    const stamp = dateStamp(now);
    if (stamp !== this.currentDate || !this.currentPath || this.currentBytes + additionalBytes > this.maxBytes) {
      if (stamp !== this.currentDate) this.sequence = 0;
      this.currentDate = stamp;
      do {
        this.sequence += 1;
        this.currentPath = path.join(this.directory, `monitor-${stamp}-${String(this.sequence).padStart(3, '0')}.jsonl`);
      } while (fs.existsSync(this.currentPath) && fs.statSync(this.currentPath).size >= this.maxBytes);
      this.currentBytes = fs.existsSync(this.currentPath) ? fs.statSync(this.currentPath).size : 0;
    }
  }

  append(value) {
    const line = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(line);
    this.queue = this.queue.then(async () => {
      this.chooseFile(new Date(), bytes);
      await fs.promises.appendFile(this.currentPath, line, 'utf8');
      this.currentBytes += bytes;
    });
    return this.queue;
  }

  close() {
    return this.queue;
  }
}

async function removeExpiredFiles(directory, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let entries = [];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('monitor-') || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.promises.stat(filePath);
    if (stat.mtimeMs < cutoff) await fs.promises.unlink(filePath);
  }
}

module.exports = { RotatingJsonlWriter, removeExpiredFiles, dateStamp };
