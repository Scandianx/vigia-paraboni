'use strict';

const http = require('node:http');
const https = require('node:https');

function requestHealth(check) {
  return new Promise((resolve) => {
    const started = Date.now();
    let parsed;
    try {
      parsed = new URL(check.url);
    } catch (error) {
      resolve({ url: check.url, ok: false, latencyMs: 0, error: error.message });
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request(parsed, {
      method: check.method || 'GET',
      timeout: check.timeoutMs || 3000,
      headers: { 'User-Agent': 'ParaboniMonitor/0.1' }
    }, (response) => {
      response.resume();
      response.on('end', () => {
        const accepted = check.acceptedStatusCodes || [200, 204];
        resolve({
          url: check.url,
          ok: accepted.includes(response.statusCode),
          statusCode: response.statusCode,
          latencyMs: Date.now() - started
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({
      url: check.url,
      ok: false,
      latencyMs: Date.now() - started,
      error: error.message
    }));
    request.end();
  });
}

class HealthScheduler {
  constructor(targets) {
    this.targets = targets;
    this.states = new Map();
  }

  async collect() {
    const now = Date.now();
    const output = new Map();
    const jobs = [];

    for (const target of this.targets) {
      const results = [];
      output.set(target.id, results);
      for (const check of target.healthChecks || []) {
        const key = `${target.id}:${check.url}`;
        const state = this.states.get(key);
        const due = !state || now - state.checkedAt >= (check.intervalSeconds || 15) * 1000;
        if (!due) {
          results.push(state.result);
          continue;
        }
        jobs.push(requestHealth(check).then((result) => {
          this.states.set(key, { checkedAt: Date.now(), result });
          results.push(result);
        }));
      }
    }

    await Promise.all(jobs);
    return output;
  }
}

module.exports = { requestHealth, HealthScheduler };
