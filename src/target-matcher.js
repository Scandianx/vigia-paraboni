'use strict';

function normalizedList(values) {
  return (values || []).filter(Boolean).map((value) => String(value).toLowerCase());
}

function containsAny(value, fragments) {
  if (!fragments.length) return true;
  const normalizedValue = String(value || '').toLowerCase();
  return fragments.some((fragment) => normalizedValue.includes(fragment));
}

function matchesTarget(processInfo, target) {
  const targetServices = normalizedList(target.serviceNames);
  const processServices = normalizedList(processInfo.serviceNames);
  if (targetServices.length && targetServices.some((name) => processServices.includes(name))) {
    return true;
  }

  const processNames = normalizedList(target.processNames);
  const pathFragments = normalizedList(target.executablePathIncludes);
  const commandFragments = normalizedList(target.commandLineIncludes);

  if (processNames.length && !processNames.includes(String(processInfo.name || '').toLowerCase())) {
    return false;
  }
  if (!processNames.length && !pathFragments.length && !commandFragments.length) return false;
  if (!containsAny(processInfo.executablePath, pathFragments)) return false;
  if (!containsAny(processInfo.commandLine, commandFragments)) return false;
  return true;
}

function matchTargets(catalog, targets) {
  const result = new Map(targets.map((target) => [target.id, []]));
  for (const processInfo of catalog || []) {
    for (const target of targets) {
      if (matchesTarget(processInfo, target)) result.get(target.id).push(processInfo);
    }
  }
  return result;
}

function selectorWarnings(targets) {
  const warnings = [];
  for (const target of targets) {
    const onlyName = (target.processNames || []).length > 0 &&
      !(target.serviceNames || []).length &&
      !(target.executablePathIncludes || []).length &&
      !(target.commandLineIncludes || []).length;
    if (onlyName) warnings.push(`${target.id}: usa somente nome do processo e pode capturar processos não relacionados.`);
  }
  return warnings;
}

module.exports = { matchesTarget, matchTargets, selectorWarnings };
