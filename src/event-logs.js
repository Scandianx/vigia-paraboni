'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

function exportLog(channel, destination, lookbackMinutes = 30) {
  const milliseconds = Math.round(lookbackMinutes * 60 * 1000);
  const query = `*[System[TimeCreated[timediff(@SystemTime) <= ${milliseconds}]]]`;
  return new Promise((resolve) => {
    execFile('wevtutil.exe', [
      'epl', channel, destination, `/q:${query}`, '/ow:true'
    ], { windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        channel,
        ok: !error,
        error: error ? (stderr || stdout || error.message).trim() : null
      });
    });
  });
}

async function captureEventLogs(directory) {
  return Promise.all([
    exportLog('System', path.join(directory, 'windows-system.evtx')),
    exportLog('Application', path.join(directory, 'windows-application.evtx'))
  ]);
}

module.exports = { exportLog, captureEventLogs };
