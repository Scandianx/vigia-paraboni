'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesTarget, matchTargets, selectorWarnings } = require('../src/target-matcher');

const nodeProcess = {
  pid: 101,
  name: 'node.exe',
  executablePath: 'C:\\Program Files\\nodejs\\node.exe',
  commandLine: 'node C:\\apps\\api\\server.js',
  serviceNames: []
};

test('combina nome do processo com trecho da linha de comando', () => {
  assert.equal(matchesTarget(nodeProcess, {
    processNames: ['NODE.EXE'],
    commandLineIncludes: ['apps\\api'],
    executablePathIncludes: [],
    serviceNames: []
  }), true);
  assert.equal(matchesTarget(nodeProcess, {
    processNames: ['node.exe'],
    commandLineIncludes: ['outra-aplicacao'],
    executablePathIncludes: [],
    serviceNames: []
  }), false);
});

test('nome de Windows Service identifica processo diretamente', () => {
  assert.equal(matchesTarget({ ...nodeProcess, serviceNames: ['MinhaApi'] }, {
    processNames: [],
    commandLineIncludes: [],
    executablePathIncludes: [],
    serviceNames: ['minhaapi']
  }), true);
});

test('associa mais de um PID ao mesmo target', () => {
  const targets = [{
    id: 'workers',
    processNames: ['node.exe'],
    commandLineIncludes: ['worker.js'],
    executablePathIncludes: [],
    serviceNames: []
  }];
  const matches = matchTargets([
    { ...nodeProcess, pid: 1, commandLine: 'node worker.js' },
    { ...nodeProcess, pid: 2, commandLine: 'node worker.js' }
  ], targets);
  assert.deepEqual(matches.get('workers').map((item) => item.pid), [1, 2]);
});

test('avisa quando o seletor usa somente o nome', () => {
  assert.equal(selectorWarnings([{
    id: 'java', processNames: ['java.exe'], serviceNames: [],
    commandLineIncludes: [], executablePathIncludes: []
  }]).length, 1);
});
