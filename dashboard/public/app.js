const state = {
  data: null,
  incidents: [],
  theme: 'light',
  loading: false,
  refreshTimer: null,
  chartConfigs: new Map(),
  resizeObserver: null
};

const targetColors = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'];
const percentFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const numberFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const integerFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});
const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit'
});

function element(id) {
  return document.getElementById(id);
}

function cssColor(variable) {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${percentFormatter.format(Number(value))}%` : '-';
}

function formatNumber(value, suffix = '') {
  return Number.isFinite(Number(value)) ? `${numberFormatter.format(Number(value))}${suffix}` : '-';
}

function formatInteger(value) {
  return Number.isFinite(Number(value)) ? integerFormatter.format(Number(value)) : '-';
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : '-';
}

function create(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text != null) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attributes || {})) {
    node.setAttribute(name, value);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('vigia-theme', theme);
  requestAnimationFrame(renderAllCharts);
}

function preferredTheme() {
  const saved = localStorage.getItem('vigia-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function rangeMilliseconds() {
  return Number(element('rangeSelect').value) || 21600000;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Falha HTTP ${response.status}`);
  }
  return response.json();
}

async function loadData({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  element('refreshButton').disabled = true;
  if (!silent && !state.data) element('loadingState').hidden = false;
  element('errorState').hidden = true;

  const to = Date.now();
  const from = to - rangeMilliseconds();
  try {
    const [data, incidentResponse] = await Promise.all([
      fetchJson(`/api/dashboard?from=${from}&to=${to}&points=720`),
      fetchJson('/api/incidents')
    ]);
    state.data = data;
    state.incidents = incidentResponse.incidents || [];
    renderDashboard();
  } catch (error) {
    element('errorMessage').textContent = error.message;
    element('errorState').hidden = false;
    if (!state.data) element('dashboardContent').hidden = true;
  } finally {
    state.loading = false;
    element('refreshButton').disabled = false;
    element('loadingState').hidden = true;
  }
}

function setMetric(id, value, context) {
  element(id).textContent = value;
  element(`${id}Context`).textContent = context;
}

function updateLiveStatus(latest) {
  const container = element('liveStatus');
  const label = element('liveStatusText');
  container.classList.remove('is-live', 'is-stale');
  if (!latest?.timestampUtc) {
    label.textContent = 'Sem amostras';
    container.classList.add('is-stale');
    return;
  }
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(latest.timestampUtc)) / 1000));
  if (ageSeconds <= 90) {
    container.classList.add('is-live');
    label.textContent = `Ao vivo, ${ageSeconds}s atrás`;
  } else {
    container.classList.add('is-stale');
    label.textContent = `Última amostra ${formatDate(latest.timestampUtc)}`;
  }
}

function renderDashboard() {
  const data = state.data;
  const hasData = data && data.meta.sampleCount > 0 && data.series.length > 0;
  element('emptyState').hidden = hasData;
  element('dashboardContent').hidden = !hasData;
  updateLiveStatus(data?.latest);
  renderIncidents();
  if (!hasData) {
    element('rangeNote').textContent = 'Nenhuma amostra encontrada no período selecionado';
    return;
  }

  const latest = data.latest || {};
  const latestSystem = latest.system || {};
  const systemSummary = data.summary.system || {};
  setMetric('metricCpu', formatPercent(latestSystem.cpuPercent), `Máxima ${formatPercent(systemSummary.maxCpuPercent)}`);
  setMetric(
    'metricMemory',
    formatPercent(latestSystem.availableMemoryPercent),
    `Mínima ${formatPercent(systemSummary.minimumAvailableMemoryPercent)}`
  );
  setMetric(
    'metricDisk',
    formatNumber(latestSystem.diskQueueLength),
    `Máxima ${formatNumber(systemSummary.maxDiskQueueLength)}`
  );
  setMetric('metricSamples', formatInteger(data.meta.sampleCount), `${formatInteger(data.meta.pointCount)} pontos no gráfico`);

  const from = formatDate(data.meta.from);
  const to = formatDate(data.meta.to);
  const warningText = data.meta.warningSamples
    ? `, ${formatInteger(data.meta.warningSamples)} com aviso de coleta`
    : '';
  element('rangeNote').textContent = `${from} até ${to}${warningText}`;

  renderSystemChart();
  renderTargetChart();
  renderTargetTable();
  renderSamplesTable();
}

function renderSystemChart() {
  const lines = [
    {
      label: 'CPU',
      color: cssColor('--chart-cpu'),
      values: state.data.series.map((point) => point.system.cpuPercent),
      format: formatPercent
    },
    {
      label: 'Memória disponível',
      color: cssColor('--chart-memory'),
      values: state.data.series.map((point) => point.system.availableMemoryPercent),
      format: formatPercent
    }
  ];
  registerChart('systemChart', 'systemTooltip', state.data.series, lines, {
    yMin: 0,
    yMax: 100,
    yFormat: (value) => `${Math.round(value)}%`
  });
}

function targetIds() {
  const ids = new Map();
  for (const point of state.data.series) {
    for (const target of point.targets || []) ids.set(target.id, target.label || target.id);
  }
  return [...ids.entries()];
}

function renderTargetChart() {
  const metric = element('targetMetric').value || 'cpuPercent';
  const isCpu = metric === 'cpuPercent';
  const ids = targetIds();
  const lines = ids.map(([id, label], index) => ({
    label,
    color: cssColor(targetColors[index % targetColors.length]),
    values: state.data.series.map((point) => {
      const target = (point.targets || []).find((item) => item.id === id);
      return target?.[metric] ?? null;
    }),
    format: isCpu ? formatPercent : (value) => formatNumber(value, ' MB')
  }));
  registerChart('targetChart', 'targetTooltip', state.data.series, lines, {
    yMin: 0,
    yMax: isCpu ? 100 : null,
    yFormat: isCpu ? (value) => `${Math.round(value)}%` : (value) => `${Math.round(value)} MB`
  });

  const legend = element('targetLegend');
  clear(legend);
  lines.forEach((line) => {
    const item = create('span');
    const swatch = create('i', { className: 'legend-swatch' });
    swatch.style.color = line.color;
    item.append(swatch, document.createTextNode(line.label));
    legend.appendChild(item);
  });
}

function registerChart(canvasId, tooltipId, points, lines, options) {
  const canvas = element(canvasId);
  const tooltip = element(tooltipId);
  state.chartConfigs.set(canvasId, { canvas, tooltip, points, lines, options });
  setupChartInteraction(canvasId);
  drawChart(state.chartConfigs.get(canvasId));
}

function drawChart(config) {
  const { canvas, points, lines, options } = config;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(bounds.width * dpr);
  canvas.height = Math.round(bounds.height * dpr);
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);

  const padding = { left: 58, right: 18, top: 18, bottom: 34 };
  const width = Math.max(1, bounds.width - padding.left - padding.right);
  const height = Math.max(1, bounds.height - padding.top - padding.bottom);
  const values = lines.flatMap((line) => line.values).filter((value) => Number.isFinite(Number(value))).map(Number);
  const yMin = Number.isFinite(options.yMin) ? options.yMin : Math.min(0, ...values);
  const rawMax = Number.isFinite(options.yMax) ? options.yMax : Math.max(1, ...values);
  const yMax = rawMax === yMin ? yMin + 1 : rawMax * (Number.isFinite(options.yMax) ? 1 : 1.08);
  const startTime = points.length ? Date.parse(points[0].timestampUtc) : 0;
  const endTime = points.length > 1 ? Date.parse(points[points.length - 1].timestampUtc) : startTime + 1;
  const timeSpan = Math.max(1, endTime - startTime);

  context.font = '11px "Segoe UI", sans-serif';
  context.textBaseline = 'middle';
  context.strokeStyle = cssColor('--chart-grid');
  context.fillStyle = cssColor('--text-secondary');
  context.lineWidth = 1;

  for (let index = 0; index <= 4; index += 1) {
    const ratio = index / 4;
    const y = padding.top + height * ratio;
    context.beginPath();
    context.moveTo(padding.left, y + 0.5);
    context.lineTo(padding.left + width, y + 0.5);
    context.stroke();
    const value = yMax - (yMax - yMin) * ratio;
    context.textAlign = 'right';
    context.fillText(options.yFormat(value), padding.left - 9, y);
  }

  const xLabelCount = bounds.width < 600 ? 2 : 4;
  for (let index = 0; index <= xLabelCount; index += 1) {
    const ratio = index / xLabelCount;
    const x = padding.left + width * ratio;
    const timestamp = startTime + timeSpan * ratio;
    context.textAlign = index === 0 ? 'left' : index === xLabelCount ? 'right' : 'center';
    context.fillText(timeFormatter.format(new Date(timestamp)), x, padding.top + height + 20);
  }

  config.pointXs = points.map((point) => {
    const timestamp = Date.parse(point.timestampUtc);
    return padding.left + ((timestamp - startTime) / timeSpan) * width;
  });
  config.plot = { padding, width, height, yMin, yMax };

  lines.forEach((line) => {
    context.beginPath();
    context.strokeStyle = line.color;
    context.lineWidth = 2;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    let drawing = false;
    line.values.forEach((rawValue, index) => {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) {
        drawing = false;
        return;
      }
      const x = config.pointXs[index];
      const ratio = (value - yMin) / (yMax - yMin);
      const y = padding.top + height - ratio * height;
      if (!drawing) {
        context.moveTo(x, y);
        drawing = true;
      } else {
        context.lineTo(x, y);
      }
    });
    context.stroke();
  });
}

function setupChartInteraction(canvasId) {
  const config = state.chartConfigs.get(canvasId);
  if (config.interactionReady) return;
  config.interactionReady = true;
  config.canvas.addEventListener('pointermove', (event) => {
    const current = state.chartConfigs.get(canvasId);
    if (!current?.pointXs?.length) return;
    const bounds = current.canvas.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    let closest = 0;
    let distance = Infinity;
    current.pointXs.forEach((x, index) => {
      const nextDistance = Math.abs(pointerX - x);
      if (nextDistance < distance) {
        distance = nextDistance;
        closest = index;
      }
    });
    showTooltip(current, closest, event.clientX - bounds.left, event.clientY - bounds.top);
  });
  config.canvas.addEventListener('pointerleave', () => {
    const current = state.chartConfigs.get(canvasId);
    if (current) current.tooltip.hidden = true;
  });
}

function showTooltip(config, index, pointerX, pointerY) {
  const tooltip = config.tooltip;
  clear(tooltip);
  tooltip.appendChild(create('strong', { text: formatDate(config.points[index].timestampUtc) }));
  config.lines.forEach((line) => {
    const value = line.values[index];
    if (!Number.isFinite(Number(value))) return;
    const row = create('span', { text: `${line.label}: ${line.format(Number(value))}` });
    row.style.color = line.color;
    tooltip.appendChild(row);
  });
  tooltip.hidden = false;
  const frame = config.canvas.parentElement.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  tooltip.style.left = `${Math.min(frame.width - width - 8, Math.max(8, pointerX + 12))}px`;
  tooltip.style.top = `${Math.min(frame.height - height - 8, Math.max(8, pointerY + 12))}px`;
}

function renderAllCharts() {
  for (const config of state.chartConfigs.values()) drawChart(config);
}

function renderTargetTable() {
  const body = element('targetsTableBody');
  clear(body);
  for (const target of state.data.summary.targets || []) {
    const row = create('tr');
    const status = create('span', {
      className: `status-badge${target.found ? '' : ' is-missing'}`,
      text: target.found ? 'Encontrado' : 'Ausente'
    });
    const values = [
      target.label,
      status,
      target.pids?.length ? target.pids.join(', ') : '-',
      formatPercent(target.averageCpuPercent),
      formatPercent(target.maxCpuPercent),
      formatNumber(target.maxPrivateMemoryMb, ' MB'),
      formatPercent(target.availabilityPercent)
    ];
    values.forEach((value) => {
      const cell = create('td');
      if (value instanceof Node) cell.appendChild(value);
      else cell.textContent = value;
      row.appendChild(cell);
    });
    body.appendChild(row);
  }
}

function renderSamplesTable() {
  const body = element('samplesTableBody');
  clear(body);
  const recent = state.data.series.slice(-20).reverse();
  for (const sample of recent) {
    const row = create('tr');
    [
      formatDate(sample.timestampUtc),
      formatPercent(sample.system.cpuPercent),
      formatPercent(sample.system.availableMemoryPercent),
      formatNumber(sample.system.diskQueueLength),
      formatNumber(sample.system.pagesPerSec, '/s')
    ].forEach((value) => row.appendChild(create('td', { text: value })));
    body.appendChild(row);
  }
}

function renderIncidents() {
  const list = element('incidentsList');
  clear(list);
  const incidents = state.incidents.slice(0, 20);
  element('incidentCount').textContent = `${state.incidents.length} ${state.incidents.length === 1 ? 'ocorrência' : 'ocorrências'}`;
  element('noIncidents').hidden = incidents.length > 0;
  list.hidden = incidents.length === 0;

  for (const incident of incidents) {
    const row = create('div', { className: 'incident-row' });
    const copy = create('div', { className: 'incident-copy' });
    copy.append(
      create('strong', { text: formatDate(incident.startedAt || incident.id) }),
      create('span', { text: incident.reasons?.join('; ') || 'Resumo indisponível' })
    );
    const meta = create('div', { className: 'incident-meta' });
    meta.appendChild(create('span', {
      className: 'incident-time',
      text: incident.status === 'complete' ? 'Concluído' : 'Coletando'
    }));
    const button = create('button', {
      className: 'ui-button ui-button-subtle',
      text: 'Abrir',
      attributes: { type: 'button' }
    });
    button.addEventListener('click', () => openIncident(incident.id));
    meta.appendChild(button);
    row.append(copy, meta);
    list.appendChild(row);
  }
}

async function openIncident(id) {
  const dialog = element('incidentDialog');
  const content = element('incidentDialogContent');
  element('incidentDialogTitle').textContent = 'Carregando incidente';
  clear(content);
  content.appendChild(create('p', { text: 'Lendo amostras e arquivos do incidente.' }));
  dialog.showModal();

  try {
    const incident = await fetchJson(`/api/incidents/${encodeURIComponent(id)}`);
    renderIncidentDialog(incident);
  } catch (error) {
    element('incidentDialogTitle').textContent = 'Falha ao abrir incidente';
    clear(content);
    content.appendChild(create('p', { text: error.message }));
  }
}

function renderIncidentDialog(incident) {
  const content = element('incidentDialogContent');
  const summary = incident.summary || {};
  element('incidentDialogTitle').textContent = formatDate(summary.startedAt || incident.id);
  clear(content);

  const metrics = create('div', { className: 'dialog-summary' });
  [
    ['Estado', summary.status === 'complete' ? 'Concluído' : 'Coletando'],
    ['Amostras', formatInteger(incident.data?.meta?.sampleCount)],
    ['Servidor', summary.hostname || 'Não informado']
  ].forEach(([label, value]) => {
    const block = create('div');
    block.append(create('span', { text: label }), create('strong', { text: value }));
    metrics.appendChild(block);
  });
  content.appendChild(metrics);

  const reasonsTitle = create('h3', { text: 'Motivos do gatilho' });
  const reasons = create('ul', { className: 'dialog-reasons' });
  for (const reason of summary.reasons || ['Motivo não informado']) {
    reasons.appendChild(create('li', { text: reason }));
  }
  content.append(reasonsTitle, reasons);

  if (incident.data?.series?.length) {
    const chartTitle = create('h3', { text: 'Comportamento do servidor' });
    const frame = create('div', { className: 'chart-frame' });
    const canvas = create('canvas', {
      attributes: { id: 'incidentChart', role: 'img', 'aria-label': 'Gráfico do incidente' }
    });
    const tooltip = create('div', { className: 'chart-tooltip', attributes: { id: 'incidentTooltip', hidden: '' } });
    frame.append(canvas, tooltip);
    content.append(chartTitle, frame);
    const lines = [
      {
        label: 'CPU', color: cssColor('--chart-cpu'),
        values: incident.data.series.map((point) => point.system.cpuPercent), format: formatPercent
      },
      {
        label: 'Memória disponível', color: cssColor('--chart-memory'),
        values: incident.data.series.map((point) => point.system.availableMemoryPercent), format: formatPercent
      }
    ];
    registerChart('incidentChart', 'incidentTooltip', incident.data.series, lines, {
      yMin: 0, yMax: 100, yFormat: (value) => `${Math.round(value)}%`
    });
  }

  const downloadTitle = create('h3', { text: 'Arquivos disponíveis' });
  const downloads = create('div', { className: 'dialog-downloads' });
  for (const fileName of incident.files || []) {
    const link = create('a', {
      className: 'download-link',
      text: fileName,
      attributes: {
        href: `/api/incidents/${encodeURIComponent(incident.id)}/files/${encodeURIComponent(fileName)}`,
        download: ''
      }
    });
    downloads.appendChild(link);
  }
  content.append(downloadTitle, downloads);
}

function configureAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  if (element('autoRefresh').checked) {
    state.refreshTimer = setInterval(() => loadData({ silent: true }), 15000);
  }
}

async function initialize() {
  state.resizeObserver = new ResizeObserver(() => requestAnimationFrame(renderAllCharts));
  document.querySelectorAll('.chart-frame').forEach((frame) => state.resizeObserver.observe(frame));

  applyTheme(preferredTheme());

  element('themeButton').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
  element('refreshButton').addEventListener('click', () => loadData());
  element('rangeSelect').addEventListener('change', () => loadData());
  element('targetMetric').addEventListener('change', renderTargetChart);
  element('autoRefresh').addEventListener('change', configureAutoRefresh);
  element('closeDialog').addEventListener('click', () => element('incidentDialog').close());
  element('incidentDialog').addEventListener('click', (event) => {
    if (event.target === element('incidentDialog')) element('incidentDialog').close();
  });

  configureAutoRefresh();
  await loadData();
}

initialize();
