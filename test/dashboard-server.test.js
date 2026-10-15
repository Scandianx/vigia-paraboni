'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { createDashboardRequestHandler, parseArguments, parseTimeRange } = require('../src/dashboard-server');

class MockResponse extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

async function invoke(handler, url, method = 'GET') {
  const response = new MockResponse();
  await handler({ url, method }, response);
  if (!response.writableEnded) await new Promise((resolve) => response.once('finish', resolve));
  return response;
}

test('valida argumentos e limita período à retenção', () => {
  assert.deepEqual(parseArguments(['--host=127.0.0.1', '--port=4000']), {
    host: '127.0.0.1', port: 4000, configPath: undefined
  });
  assert.throws(() => parseArguments(['--port=99999']), /porta/);
  const params = new URLSearchParams({ from: '0', to: String(10 * 86400000) });
  const range = parseTimeRange(params, 2);
  assert.equal(range.fromMs, 8 * 86400000);
});

test('serve painel e API somente para leitura', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigia-server-'));
  fs.mkdirSync(path.join(directory, 'samples'), { recursive: true });
  const handler = createDashboardRequestHandler({ storage: { directory, retentionDays: 14 } });

  const page = await invoke(handler, '/');
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-security-policy'], /default-src/);
  assert.match(page.text(), /Vigia Paraboni/);

  const api = await invoke(handler, '/api/dashboard');
  assert.equal(api.statusCode, 200);
  assert.equal(JSON.parse(api.text()).meta.sampleCount, 0);

  const post = await invoke(handler, '/api/dashboard', 'POST');
  assert.equal(post.statusCode, 405);
});
