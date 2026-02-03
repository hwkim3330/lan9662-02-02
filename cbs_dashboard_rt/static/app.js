const statusEl = document.getElementById('status');
const totalRxMbpsEl = document.getElementById('totalRxMbps');
const totalRxCalcEl = document.getElementById('totalRxCalc');
const totalRxWireEl = document.getElementById('totalRxWire');
const totalRxPcpEl = document.getElementById('totalRxPcp');
const rxUnknownEl = document.getElementById('rxUnknown');
const rxTxRatioEl = document.getElementById('rxTxRatio');
const pcpUnknownLineEl = document.getElementById('pcpUnknownLine');
const pcpCoverageEl = document.getElementById('pcpCoverage');
const totalTxMbpsEl = document.getElementById('totalTxMbps');
const totalPktsEl = document.getElementById('totalPkts');
const sumLineEl = document.getElementById('sumLine');
const chartsEl = document.getElementById('charts');
const idleInputsEl = document.getElementById('idleSlopeInputs');
const tcTableEl = document.getElementById('tcTable').querySelector('tbody');
const sampleTableEl = document.getElementById('sampleTable').querySelector('tbody');
const totalChartCanvas = document.getElementById('totalChart');
const pcpChartCanvas = document.getElementById('pcpChart');
const pcpBreakdownCanvas = document.getElementById('pcpBreakdownChart');
const ifaceTableEl = document.getElementById('ifaceTable').querySelector('tbody');
const capTableEl = document.getElementById('capTable').querySelector('tbody');
const rxBreakdownEl = document.getElementById('rxBreakdown').querySelector('tbody');

const fields = {
  ingress: document.getElementById('ingress'),
  egress: document.getElementById('egress'),
  dstmac: document.getElementById('dstmac'),
  vlan: document.getElementById('vlan'),
  duration: document.getElementById('duration'),
  pktsize: document.getElementById('pktsize'),
  payloadSize: document.getElementById('payloadSize'),
  pktSizeMode: document.getElementById('pktSizeMode'),
  egressPort: document.getElementById('egressPort'),
  ingressPort: document.getElementById('ingressPort'),
  rate: document.getElementById('rate'),
  tol: document.getElementById('tol'),
  dstip: document.getElementById('dstip'),
  smooth: document.getElementById('smooth'),
  rxBatch: document.getElementById('rxBatch'),
  txBatch: document.getElementById('txBatch'),
  rxCpu: document.getElementById('rxCpu'),
  txCpu: document.getElementById('txCpu'),
  useBoard: document.getElementById('useBoard'),
  capFilter: document.getElementById('capFilter'),
  rxSeqOnly: document.getElementById('rxSeqOnly'),
};

const defaultIdle = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const historyLen = 120;
const sampleHistoryLen = 24;
const totalHistory = { rx: [], tx: [] };
const totalChart = { canvas: totalChartCanvas, ctx: totalChartCanvas.getContext('2d'), size: null };
const pcpHistory = { ratio: [], pcp: [], unknown: [] };
const pcpChart = { canvas: pcpChartCanvas, ctx: pcpChartCanvas ? pcpChartCanvas.getContext('2d') : null, size: null };
const pcpBreakdownChart = { canvas: pcpBreakdownCanvas, ctx: pcpBreakdownCanvas ? pcpBreakdownCanvas.getContext('2d') : null, size: null };
const tcState = Array.from({length:8}, (_, tc) => ({
  tc,
  pred: defaultIdle[tc] / 1000,
  measured: 0,
  history: [],
  canvas: null,
  ctx: null,
}));

function buildIdleInputs() {
  idleInputsEl.innerHTML = '';
  tcState.forEach((s, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'chart';
    wrap.innerHTML = `
      <div class="label">TC${i} (kbps)</div>
      <input id="idle${i}" value="${defaultIdle[i]}">
    `;
    idleInputsEl.appendChild(wrap);
  });
}

function buildCharts() {
  chartsEl.innerHTML = '';
  tcState.forEach((s, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'chart';
    wrap.innerHTML = `<div class="label">TC${i} Mbps</div><canvas id="chart${i}" width="640" height="220"></canvas>`;
    chartsEl.appendChild(wrap);
    s.canvas = wrap.querySelector('canvas');
    s.ctx = s.canvas.getContext('2d');
  });
}

function resizeCanvas(s) {
  const dpr = window.devicePixelRatio || 1;
  const rect = s.canvas.getBoundingClientRect();
  const w = Math.max(320, rect.width);
  const h = Math.max(180, rect.height);
  s.canvas.width = Math.floor(w * dpr);
  s.canvas.height = Math.floor(h * dpr);
  s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  s.size = { w, h };
}

function drawTotalChart() {
  const s = totalChart;
  if (!s.size) resizeCanvas(s);
  const ctx = s.ctx;
  const w = s.size.w;
  const h = s.size.h;
  const pad = 34;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#242b3a';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (h - 2*pad) * (i / 4);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
  }
  const max = Math.max(1, ...totalHistory.rx, ...totalHistory.tx);

  const drawLine = (arr, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    arr.forEach((v, i) => {
      const x = pad + (w - 2*pad) * (i / (historyLen - 1 || 1));
      const y = pad + (h - 2*pad) * (1 - v / max);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  drawLine(totalHistory.rx, '#6ee7b7');
  drawLine(totalHistory.tx, '#6aa9ff');

  ctx.fillStyle = '#9aa4b2';
  ctx.font = '10px "Space Grotesk", "SF Pro Display", sans-serif';
  ctx.fillText('Mbps', 4, 12);
  ctx.fillText('time (s)', w / 2 - 20, h - 6);
  for (let i = 0; i <= 4; i++) {
    const y = pad + (h - 2*pad) * (i / 4);
    const v = (max * (1 - i / 4)).toFixed(1);
    ctx.fillText(v, 4, y + 3);
  }
}

function drawLineChart(chart, series, colors, unit, maxOverride = null) {
  if (!chart || !chart.canvas) return;
  if (!chart.size) resizeCanvas(chart);
  const ctx = chart.ctx;
  const w = chart.size.w;
  const h = chart.size.h;
  const pad = 34;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#242b3a';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (h - 2 * pad) * (i / 4);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
  }
  const flat = series.flat();
  const max = maxOverride !== null ? maxOverride : Math.max(1, ...flat);
  series.forEach((arr, idx) => {
    ctx.strokeStyle = colors[idx];
    ctx.lineWidth = 2;
    ctx.beginPath();
    arr.forEach((v, i) => {
      const x = pad + (w - 2 * pad) * (i / (historyLen - 1 || 1));
      const y = pad + (h - 2 * pad) * (1 - v / max);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  ctx.fillStyle = '#9aa4b2';
  ctx.font = '10px "Space Grotesk", "SF Pro Display", sans-serif';
  ctx.fillText(unit, 4, 12);
  ctx.fillText('time (s)', w / 2 - 20, h - 6);
  for (let i = 0; i <= 4; i++) {
    const y = pad + (h - 2 * pad) * (i / 4);
    const v = (max * (1 - i / 4)).toFixed(1);
    ctx.fillText(v, 4, y + 3);
  }
}

function drawChart(s) {
  const ctx = s.ctx;
  if (!s.size) resizeCanvas(s);
  const w = s.size.w;
  const h = s.size.h;
  const pad = 34;

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#242b3a';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (h - 2*pad) * (i / 4);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
  }

  const max = Math.max(...s.history, s.pred, 1);

  // predicted line
  ctx.strokeStyle = '#6aa9ff';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  const ypred = pad + (h - 2*pad) * (1 - s.pred / max);
  ctx.moveTo(pad, ypred); ctx.lineTo(w - pad, ypred); ctx.stroke();
  ctx.setLineDash([]);

  // measured line
  ctx.strokeStyle = '#6ee7b7';
  ctx.lineWidth = 2;
  ctx.beginPath();
  s.history.forEach((v, i) => {
    const x = pad + (w - 2*pad) * (i / (historyLen - 1 || 1));
    const y = pad + (h - 2*pad) * (1 - v / max);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // axes labels
  ctx.fillStyle = '#9aa4b2';
  ctx.font = '10px "Space Grotesk", "SF Pro Display", sans-serif';
  ctx.fillText('Mbps', 4, 12);
  ctx.fillText('time (s)', w / 2 - 20, h - 6);
  // y-axis ticks
  for (let i = 0; i <= 4; i++) {
    const y = pad + (h - 2*pad) * (i / 4);
    const v = (max * (1 - i / 4)).toFixed(1);
    ctx.fillText(v, 4, y + 3);
  }
}

function updateTable() {
  tcTableEl.innerHTML = '';
  tcState.forEach((s) => {
    const tr = document.createElement('tr');
    const errMbps = (s.expected && s.expected > 0) ? (Math.abs(s.measured - s.expected) / s.expected) * 100 : 0;
    tr.innerHTML = `
      <td>${s.tc}</td>
      <td>${(s.tx || 0).toFixed(2)}</td>
      <td>${s.measured.toFixed(2)}</td>
      <td>${s.pred.toFixed(2)}</td>
      <td>${errMbps.toFixed(1)}%</td>
    `;
    tcTableEl.appendChild(tr);

  });
}

function readIdleSlopes() {
  const values = [];
  for (let i = 0; i < 8; i++) {
    const v = parseInt(document.getElementById(`idle${i}`).value, 10);
    const raw = Number.isFinite(v) ? v : 0;
    values.push(raw);
    tcState[i].pred = raw / 1000;
  }
  return values;
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  const map = { ok: 'success', warn: 'warning', err: 'error', info: 'info' };
  const mapped = map[cls] || 'neutral';
  statusEl.className = `status-badge ${mapped}`;
}

function collectPayload(extra = {}) {
  const idle = readIdleSlopes();
  return {
    ingress_iface: fields.ingress.value,
    egress_iface: fields.egress.value,
    dst_mac: fields.dstmac.value,
    vlan_id: parseInt(fields.vlan.value, 10),
    duration: parseInt(fields.duration.value, 10),
    packet_size: parseInt(fields.pktsize.value, 10),
    payload_size: parseInt(fields.payloadSize.value, 10),
    pkt_size_mode: fields.pktSizeMode ? fields.pktSizeMode.value : 'frame',
    rate_per_tc_mbps: parseInt(fields.rate.value, 10),
    tolerance: parseFloat(fields.tol.value),
    smooth_window: parseInt(fields.smooth.value, 10),
    rx_batch: parseInt(fields.rxBatch.value, 10),
    tx_batch: parseInt(fields.txBatch.value, 10),
    rx_cpu: parseInt(fields.rxCpu.value, 10),
    tx_cpu: parseInt(fields.txCpu.value, 10),
    egress_port: fields.egressPort.value,
    ingress_port: fields.ingressPort.value,
    dst_ip: fields.dstip.value,
    use_board: fields.useBoard ? (fields.useBoard.value === 'true') : true,
    capture_filter: fields.capFilter ? fields.capFilter.value : 'dst',
    rx_seq_only: fields.rxSeqOnly ? (fields.rxSeqOnly.value === 'true') : true,
    idle_slope_kbps: idle,
    ...extra
  };
}

function applyCBS() {
  fetch('/apply', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(collectPayload())
  });
  setStatus('APPLIED', 'ok');
}

function start() {
  if (isRunning) return;
  const idle = readIdleSlopes();
  fetch('/start', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(collectPayload({ apply_first: false }))
  }).then((r) => {
    if (r.status === 409) throw new Error('already running');
    setStatus('RUNNING', 'ok');
    setButtons(true);
  }).catch(() => {
    setStatus('RUNNING', 'ok');
    setButtons(true);
  });
}

function stop() {
  fetch('/stop', {method:'POST'});
  setStatus('STOPPED', 'warn');
  setButtons(false);
}

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const applyBtn = document.getElementById('applyBtn');
let isRunning = false;
function setButtons(running) {
  isRunning = running;
  startBtn.disabled = running;
  applyBtn.disabled = running;
  stopBtn.disabled = !running;
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
applyBtn.addEventListener('click', applyCBS);

buildIdleInputs();
buildCharts();
updateTable();
setButtons(false);

function resizeAllCharts() {
  tcState.forEach((s) => {
    if (s.canvas) resizeCanvas(s);
  });
  if (totalChart.canvas) resizeCanvas(totalChart);
  if (pcpChart.canvas) resizeCanvas(pcpChart);
  if (pcpBreakdownChart.canvas) resizeCanvas(pcpBreakdownChart);
}
window.addEventListener('resize', () => {
  resizeAllCharts();
  tcState.forEach(drawChart);
  drawTotalChart();
  if (pcpChart.canvas) drawLineChart(pcpChart, [pcpHistory.ratio], ['#7dd3fc'], '%', 100);
  if (pcpBreakdownChart.canvas) drawLineChart(pcpBreakdownChart, [pcpHistory.pcp, pcpHistory.unknown], ['#6ee7b7', '#f472b6'], 'Mbps');
});
resizeAllCharts();
drawTotalChart();

const es = new EventSource('/events');
let lastIfacePayload = null;
let lastCapLines = null;
let lastRxBreakdown = null;
es.onmessage = (ev) => {
  const data = JSON.parse(ev.data);
  const rxTotal = Number.isFinite(data.total_mbps_calc) ? data.total_mbps_calc : (Number.isFinite(data.total_mbps) ? data.total_mbps : 0);
  const txTotal = (data.tx_tc_mbps || []).reduce((a, b) => a + b, 0);
  totalRxMbpsEl.textContent = rxTotal.toFixed(2);
  if (totalRxCalcEl) {
    const rxRaw = Number.isFinite(data.total_mbps) ? data.total_mbps : 0;
    totalRxCalcEl.textContent = rxRaw.toFixed(2);
  }
  if (totalRxWireEl) {
    const rxWire = Number.isFinite(data.total_mbps_wire) ? data.total_mbps_wire : 0;
    totalRxWireEl.textContent = rxWire.toFixed(2);
  }
  const rxPcp = Number.isFinite(data.total_mbps_pcp) ? data.total_mbps_pcp : 0;
  const unk = Number.isFinite(data.unknown_mbps) ? data.unknown_mbps : 0;
  if (totalRxPcpEl) {
    totalRxPcpEl.textContent = rxPcp.toFixed(2);
  }
  if (rxUnknownEl) {
    const eff = Number.isFinite(data.pkt_size_eff) ? data.pkt_size_eff : 0;
    rxUnknownEl.textContent = `${unk.toFixed(2)} / ${eff.toFixed(1)} B`;
  }
  if (pcpUnknownLineEl) {
    pcpUnknownLineEl.textContent = `${rxPcp.toFixed(2)} / ${unk.toFixed(2)}`;
  }
  let ratio = (data.pcp_ratio_count !== undefined) ? data.pcp_ratio_count : data.pcp_ratio;
  if (ratio === 0 && totalHistory.rx.length > 0 && totalHistory.rx[totalHistory.rx.length - 1] > 0) {
    const last = pcpHistory.ratio[pcpHistory.ratio.length - 1];
    if (last !== undefined) ratio = last / 100;
  }
  if (pcpCoverageEl) {
    const pcpRatio = ((ratio || 0) * 100).toFixed(1);
    const floor = data.pps_floor ? data.pps_floor : '';
    pcpCoverageEl.textContent = `${pcpRatio}% / ${floor}`;
  }
  totalTxMbpsEl.textContent = txTotal.toFixed(2);
  if (rxTxRatioEl) {
    const ratio = txTotal > 0 ? (rxTotal / txTotal) * 100 : 0;
    rxTxRatioEl.textContent = `${ratio.toFixed(1)}%`;
  }
  totalPktsEl.textContent = `${data.total_pkts} / drops ${data.drops}`;
  if (sumLineEl) {
    const predSum = (data.total_pred || 0).toFixed(2);
    const txSum = (data.total_tx || txTotal || 0).toFixed(2);
    const rxSum = rxTotal.toFixed(2);
    const rxTx = txTotal > 0 ? ((rxTotal / txTotal) * 100).toFixed(1) : '0.0';
    sumLineEl.textContent = `${predSum} / ${txSum} / ${rxSum} / ${rxTx}%`;
  }

  totalHistory.rx.push(rxTotal);
  totalHistory.tx.push(txTotal);
  if (totalHistory.rx.length > historyLen) totalHistory.rx.shift();
  if (totalHistory.tx.length > historyLen) totalHistory.tx.shift();
  drawTotalChart();

  pcpHistory.ratio.push(((ratio || 0) * 100));
  pcpHistory.pcp.push(rxPcp);
  pcpHistory.unknown.push(unk);
  if (pcpHistory.ratio.length > historyLen) pcpHistory.ratio.shift();
  if (pcpHistory.pcp.length > historyLen) pcpHistory.pcp.shift();
  if (pcpHistory.unknown.length > historyLen) pcpHistory.unknown.shift();
  if (pcpChart.canvas) drawLineChart(pcpChart, [pcpHistory.ratio], ['#7dd3fc'], '%', 100);
  if (pcpBreakdownChart.canvas) drawLineChart(pcpBreakdownChart, [pcpHistory.pcp, pcpHistory.unknown], ['#6ee7b7', '#f472b6'], 'Mbps');

  const sampleRow = {
    t: data.time_s,
    rx: data.total_mbps,
    tx: txTotal,
    pps: data.total_pps,
    pkts: data.total_pkts,
    drops: data.drops,
  };
  if (!window.__sampleHistory) window.__sampleHistory = [];
  window.__sampleHistory.push(sampleRow);
  if (window.__sampleHistory.length > sampleHistoryLen) window.__sampleHistory.shift();
  sampleTableEl.innerHTML = '';
  [...window.__sampleHistory].reverse().forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.t.toFixed(1)}</td>
      <td>${r.rx.toFixed(2)}</td>
      <td>${r.tx.toFixed(2)}</td>
      <td>${r.pps.toFixed(0)}</td>
      <td>${r.pkts}</td>
      <td>${r.drops}</td>
    `;
    sampleTableEl.appendChild(tr);
  });

  if (data.iface_delta) {
    const allZero = (obj) => obj && Object.values(obj).every((v) => Number(v || 0) === 0);
    const ifaceIsZero = allZero(data.iface_delta) && allZero(data.ingress_delta || {});
    if (ifaceIsZero && lastIfacePayload) {
      data.iface_delta = lastIfacePayload.iface_delta;
      data.ingress_delta = lastIfacePayload.ingress_delta;
    } else if (!ifaceIsZero) {
      lastIfacePayload = { iface_delta: data.iface_delta, ingress_delta: data.ingress_delta || {} };
    }
    ifaceTableEl.innerHTML = '';
    const rows = [
      { name: 'egress', d: data.iface_delta },
      { name: 'ingress', d: data.ingress_delta || {} },
    ];
    rows.forEach((r) => {
      const d = r.d || {};
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.name}</td>
        <td>${d.rx_packets || 0}</td>
        <td>${d.rx_bytes || 0}</td>
        <td>${d.rx_dropped || 0}</td>
        <td>${d.rx_errors || 0}</td>
        <td>${d.tx_packets || 0}</td>
        <td>${d.tx_bytes || 0}</td>
        <td>${d.tx_dropped || 0}</td>
        <td>${d.tx_errors || 0}</td>
      `;
      ifaceTableEl.appendChild(tr);
    });
  }

  if (rxBreakdownEl) {
    const currBreakdown = {
      vlan_pkts: data.vlan_pkts ?? 0,
      non_vlan_pkts: data.non_vlan_pkts ?? 0,
      seq_pkts: data.seq_pkts ?? 0,
      embedded_pcp_pkts: data.embedded_pcp_pkts ?? 0,
    };
    const isZero = Object.values(currBreakdown).every((v) => Number(v || 0) === 0);
    if (isZero && lastRxBreakdown) {
      Object.assign(currBreakdown, lastRxBreakdown);
    } else if (!isZero) {
      lastRxBreakdown = { ...currBreakdown };
    }
    rxBreakdownEl.innerHTML = '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${currBreakdown.vlan_pkts}</td>
      <td>${currBreakdown.non_vlan_pkts}</td>
      <td>${currBreakdown.seq_pkts}</td>
      <td>${currBreakdown.embedded_pcp_pkts}</td>
    `;
    rxBreakdownEl.appendChild(tr);
  }

  if (data.cap_mode && data.cap_lines) {
    capTableEl.innerHTML = '';
    const lines = data.cap_lines.length ? data.cap_lines : (lastCapLines || []);
    if (data.cap_lines.length) lastCapLines = data.cap_lines.slice();
    const view = lines.slice().reverse();
    view.forEach((line) => {
      if (data.cap_mode === 'tshark') {
        const parts = line.replace(/^\"|\"$/g, '').split('","');
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${parts[0] || ''}</td>
          <td>${parts[1] || ''}</td>
          <td>${parts[2] || ''}</td>
          <td>${parts[3] || ''}</td>
          <td>${parts[4] || ''}</td>
          <td>${parts[5] || ''}</td>
          <td>${parts[6] || ''}</td>
          <td>${parts[7] || ''}</td>
          <td>${parts[8] || ''}</td>
          <td>${parts[9] || ''}</td>
        `;
        capTableEl.appendChild(tr);
      } else {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td colspan="10" style="text-align:left;">${line}</td>
        `;
        capTableEl.appendChild(tr);
      }
    });
  }

  const useScaled = (data.pcp_ratio !== undefined && data.pcp_ratio < 0.9);
  for (let tc = 0; tc < 8; tc++) {
    const s = tcState[tc];
    const raw = data.per_tc_mbps[tc] || 0;
    const scaled = (data.per_tc_mbps_scaled && data.per_tc_mbps_scaled[tc]) ? data.per_tc_mbps_scaled[tc] : raw;
    s.measured = useScaled ? scaled : raw;
    s.measuredPps = (data.per_tc_pps && data.per_tc_pps[tc]) ? data.per_tc_pps[tc] : 0;
    s.tx = (data.tx_tc_mbps && data.tx_tc_mbps[tc]) ? data.tx_tc_mbps[tc] : 0;
    s.expected = (data.exp_mbps && data.exp_mbps[tc]) ? data.exp_mbps[tc] : s.pred;
    s.expectedPps = (data.exp_pps && data.exp_pps[tc]) ? data.exp_pps[tc] : 0;
    s.pass = data.pass[tc];
    s.history.push(s.measured);
    if (s.history.length > historyLen) s.history.shift();
    drawChart(s);
  }
  updateTable();
};
