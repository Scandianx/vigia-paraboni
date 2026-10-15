'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const {
  loadDashboardData,
  listIncidents,
  loadIncident,
  safeIncidentId
} = require('./dashboard-data');

const PUBLIC_DIRECTORY = path.resolve(__dirname, '..', 'dashboard', 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.evtx': 'application/octet-stream',
  '.jsonl': 'application/x-ndjson; charset=utf-8'
};

function parseArguments(argv) {
  const values = { host: '127.0.0.1', port: 3876, configPath: undefined };
  for (const argument of argv) {
    if (argument.startsWith('--host=')) values.host = argument.slice('--host='.length);
    if (argument.startsWith('--port=')) values.port = Number(argument.slice('--port='.length));
    if (argument.startsWith('--config=')) values.configPath = argument.slice('--config='.length);
  }
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) {
    throw new Error('A porta deve ser um número entre 1 e 65535.');
  }
  return values;
}

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': MIME_TYPES['.json'],
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

async function sendFile(response, filePath, options = {}) {
  const stat = await fs.promises.stat(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': options.cache || 'no-cache'
  };
  if (options.downloadName) {
    headers['Content-Disposition'] = `attachment; filename="${options.downloadName.replace(/[^A-Za-z0-9_.-]/g, '_')}"`;
  }
  response.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(response);
}

function resolvePublicFile(urlPath) {
  const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
  const resolved = path.resolve(PUBLIC_DIRECTORY, relative);
  if (!resolved.startsWith(`${PUBLIC_DIRECTORY}${path.sep}`) && resolved !== PUBLIC_DIRECTORY) return null;
  return resolved;
}

function parseTimeRange(searchParams, retentionDays) {
  const now = Date.now();
  const parsedTo = searchParams.has('to') ? Number(searchParams.get('to')) : NaN;
  const toMs = Number.isFinite(parsedTo) ? parsedTo : now;
  const parsedFrom = searchParams.has('from') ? Number(searchParams.get('from')) : NaN;
  const requestedFrom = Number.isFinite(parsedFrom) ? parsedFrom : toMs - 6 * 60 * 60 * 1000;
  const earliest = toMs - retentionDays * 24 * 60 * 60 * 1000;
  const fromMs = Math.max(earliest, Math.min(requestedFrom, toMs));
  const maxPoints = Number(searchParams.get('points')) || 720;
  return { fromMs, toMs, maxPoints };
}

function createDashboardRequestHandler(config) {
  return async function dashboardRequestHandler(request, response) {
    securityHeaders(response);
    const requestUrl = new URL(request.url, 'http://localhost');

    try {
      if (request.method !== 'GET') {
        sendError(response, 405, 'Método não permitido.');
        return;
      }

      if (requestUrl.pathname === '/api/dashboard') {
        const range = parseTimeRange(requestUrl.searchParams, config.storage.retentionDays);
        sendJson(response, 200, await loadDashboardData(config.storage.directory, range));
        return;
      }

      if (requestUrl.pathname === '/api/incidents') {
        sendJson(response, 200, { incidents: await listIncidents(config.storage.directory) });
        return;
      }

      const incidentMatch = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)$/);
      if (incidentMatch) {
        const incidentId = decodeURIComponent(incidentMatch[1]);
        sendJson(response, 200, await loadIncident(config.storage.directory, incidentId));
        return;
      }

      const fileMatch = requestUrl.pathname.match(/^\/api\/incidents\/([^/]+)\/files\/([^/]+)$/);
      if (fileMatch) {
        const incidentId = decodeURIComponent(fileMatch[1]);
        const fileName = decodeURIComponent(fileMatch[2]);
        const allowedFiles = new Set([
          'summary.json',
          'samples-before.jsonl',
          'samples-after.jsonl',
          'windows-system.evtx',
          'windows-application.evtx',
          'event-log-export.json'
        ]);
        if (!safeIncidentId(incidentId) || !allowedFiles.has(fileName)) {
          sendError(response, 400, 'Arquivo inválido.');
          return;
        }
        const filePath = path.join(config.storage.directory, 'incidents', incidentId, fileName);
        await sendFile(response, filePath, { downloadName: `${incidentId}-${fileName}` });
        return;
      }

      if (requestUrl.pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }

      const publicFile = resolvePublicFile(requestUrl.pathname);
      if (!publicFile || !fs.existsSync(publicFile) || !fs.statSync(publicFile).isFile()) {
        sendError(response, 404, 'Recurso não encontrado.');
        return;
      }
      await sendFile(response, publicFile, { cache: 'no-cache' });
    } catch (error) {
      if (error.code === 'ENOENT') sendError(response, 404, 'Arquivo não encontrado.');
      else {
        console.error(`[dashboard] ${error.stack || error.message}`);
        sendError(response, 500, 'Não foi possível carregar os dados.');
      }
    }
  };
}

function createDashboardServer(config) {
  return http.createServer(createDashboardRequestHandler(config));
}

async function main() {
  let options;
  let config;
  try {
    options = parseArguments(process.argv.slice(2));
    config = loadConfig(options.configPath);
  } catch (error) {
    console.error(`[dashboard] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const server = createDashboardServer(config);
  server.on('error', (error) => {
    console.error(`[dashboard] ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(options.port, options.host, () => {
    console.log(`Painel disponível em http://${options.host}:${options.port}`);
    console.log(`Lendo dados de ${config.storage.directory}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = {
  createDashboardServer,
  createDashboardRequestHandler,
  parseArguments,
  parseTimeRange,
  resolvePublicFile,
  securityHeaders
};
