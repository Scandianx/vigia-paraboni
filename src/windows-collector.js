'use strict';

const { spawn, execFile } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

class WindowsCollector {
  constructor(config, handlers = {}) {
    this.config = config;
    this.handlers = handlers;
    this.child = null;
    this.stopping = false;
    this.restartTimer = null;
  }

  start() {
    if (process.platform !== 'win32') throw new Error('Este coletor requer Windows.');
    const script = path.resolve(__dirname, '..', 'scripts', 'windows-collector.ps1');
    const args = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-IntervalSeconds', String(this.config.collector.intervalSeconds),
      '-CatalogRefreshSeconds', String(this.config.collector.catalogRefreshSeconds)
    ];
    this.child = spawn(this.config.collector.powershellExecutable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      try {
        this.handlers.onMessage?.(JSON.parse(line));
      } catch (error) {
        this.handlers.onError?.(new Error(`Saída inválida do coletor: ${error.message}`));
      }
    });
    this.child.stderr.on('data', (chunk) => this.handlers.onError?.(new Error(chunk.toString().trim())));
    this.child.on('error', (error) => this.handlers.onError?.(error));
    this.child.on('exit', (code) => {
      this.child = null;
      if (!this.stopping) {
        this.handlers.onError?.(new Error(`Coletor PowerShell encerrou com código ${code}; reiniciando em 5 segundos.`));
        this.restartTimer = setTimeout(() => this.start(), 5000);
      }
    });
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.child) this.child.kill();
  }
}

function runLogman(action, collectorName) {
  return new Promise((resolve, reject) => {
    execFile('logman.exe', [action, collectorName], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

module.exports = { WindowsCollector, runLogman };
