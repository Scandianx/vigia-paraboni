'use strict';

class SustainedDetector {
  constructor(config) {
    this.config = config;
    this.counts = new Map();
    this.seenTargets = new Set();
  }

  track(key, condition, reason, required = this.config.thresholds.consecutiveSamples) {
    const previous = this.counts.get(key) || 0;
    const current = condition ? previous + 1 : 0;
    this.counts.set(key, current);
    return condition && current >= required ? reason : null;
  }

  evaluate(sample) {
    const reasons = [];
    const thresholds = this.config.thresholds;
    const system = sample.system || {};

    reasons.push(this.track(
      'system-cpu',
      Number.isFinite(system.cpuPercent) && system.cpuPercent >= thresholds.systemCpuPercent,
      `CPU do servidor em ${system.cpuPercent}%`
    ));
    reasons.push(this.track(
      'system-memory',
      Number.isFinite(system.availableMemoryPercent) && system.availableMemoryPercent <= thresholds.availableMemoryPercent,
      `memória disponível em ${system.availableMemoryPercent}%`
    ));
    reasons.push(this.track(
      'sample-delay',
      Number.isFinite(sample.sampleDelayMs) && sample.sampleDelayMs >= thresholds.sampleDelaySeconds * 1000,
      `monitor atrasou ${Math.round(sample.sampleDelayMs / 1000)}s`,
      1
    ));
    reasons.push(this.track(
      'collector-warnings',
      Array.isArray(sample.collectorWarnings) && sample.collectorWarnings.length > 0,
      'uma ou mais fontes CIM do Windows estão indisponíveis'
    ));

    for (const target of this.config.targets) {
      const observed = sample.targets.find((item) => item.id === target.id);
      if (!observed) continue;
      if (observed.found) this.seenTargets.add(target.id);
      reasons.push(this.track(
        `${target.id}-missing`,
        this.seenTargets.has(target.id) && !observed.found,
        `${target.label || target.id} não foi encontrado`
      ));

      if (Number.isFinite(target.maxCpuPercent)) {
        reasons.push(this.track(
          `${target.id}-cpu`,
          observed.cpuPercent >= target.maxCpuPercent,
          `${target.label || target.id} consumindo ${observed.cpuPercent}% de CPU`
        ));
      }
      if (Number.isFinite(target.maxPrivateMemoryMb)) {
        reasons.push(this.track(
          `${target.id}-memory`,
          observed.privateMemoryMb >= target.maxPrivateMemoryMb,
          `${target.label || target.id} usando ${observed.privateMemoryMb} MB de memória privada`
        ));
      }
      for (const health of observed.health || []) {
        reasons.push(this.track(
          `${target.id}-health-${health.url}`,
          health.ok === false,
          `health check de ${target.label || target.id} falhou: ${health.error || health.statusCode || 'sem resposta'}`,
          thresholds.healthConsecutiveFailures
        ));
      }
    }

    return reasons.filter(Boolean);
  }
}

module.exports = { SustainedDetector };
