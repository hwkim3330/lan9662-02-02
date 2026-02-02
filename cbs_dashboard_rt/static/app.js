const statusEl = document.getElementById('status');
const totalMbpsEl = document.getElementById('totalMbps');
const totalPktsEl = document.getElementById('totalPkts');
const sumLineEl = document.getElementById('sumLine');
const chartsEl = document.getElementById('charts');
const idleInputsEl = document.getElementById('idleSlopeInputs');
const tcTableEl = document.getElementById('tcTable').querySelector('tbody');
const sampleTableEl = document.getElementById('sampleTable').querySelector('tbody');
const totalChartCanvas = document.getElementById('totalChart');
const ifaceTableEl = document.getElementById('ifaceTable').querySelector('tbody');
const capTableEl = document.getElementById('capTable').querySelector('tbody');

const fields = {
  ingress: document.getElementById('ingress'),
  egress: document.getElementById('egress'),
  dstmac: document.getElementById('dstmac'),
  vlan: document.getElementById('vlan'),
  duration: document.getElementById('duration'),
  pktsize: document.getElementById('pktsize'),
  egressPort: document.getElementById('egressPort'),
  ingressPort: document.getElementById('ingressPort'),
  rate: document.getElementById('rate'),
  tol: document.getElementById('tol'),
  idleScale: document.getElementById('idleScale'),
  dstip: document.getElementById('dstip'),
  smooth: document.getElementById('smooth'),
  rxBatch: document.getElementById('rxBatch'),
  txBatch: document.getElementById('txBatch'),
  rxCpu: document.getElementById('rxCpu'),
  txCpu: document.getElementById('txCpu'),
};

const defaultIdle = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const historyLen = 120;
const sampleHistoryLen = 24;
const totalHistory = { rx: [], tx: [] };
const totalChart = { canvas: totalChartCanvas, ctx: totalChartCanvas.getContext('2d'), size: null };
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
    const status = s.pass ? 'PASS' : 'FAIL';
    tr.innerHTML = `
      <td>${s.tc}</td>
      <td>${(s.tx || 0).toFixed(2)}</td>
      <td>${s.measured.toFixed(2)}</td>
      <td>${s.pred.toFixed(2)}</td>
      <td>${(s.expected || 0).toFixed(2)}</td>
      <td><span class="badge ${s.pass ? 'ok' : 'bad'}">${status}</span></td>
    `;
    tcTableEl.appendChild(tr);
  });
}

function readIdleSlopes() {
  const values = [];
  const scale = parseFloat(fields.idleScale.value);
  const scaleVal = Number.isFinite(scale) && scale > 0 ? scale : 1.0;
  for (let i = 0; i < 8; i++) {
    const v = parseInt(document.getElementById(`idle${i}`).value, 10);
    const raw = Number.isFinite(v) ? v : 0;
    const scaled = Math.round(raw * scaleVal);
    values.push(scaled);
    tcState[i].pred = scaled / 1000;
  }
  return values;
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `badge ${cls}`;
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
  const idle = readIdleSlopes();
  fetch('/start', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(collectPayload({ apply_first: false }))
  });
  setStatus('RUNNING', 'ok');
}

function stop() {
  fetch('/stop', {method:'POST'});
  setStatus('STOPPED', 'warn');
}

document.getElementById('startBtn').addEventListener('click', start);
document.getElementById('stopBtn').addEventListener('click', stop);
document.getElementById('applyBtn').addEventListener('click', applyCBS);

buildIdleInputs();
buildCharts();
updateTable();

function resizeAllCharts() {
  tcState.forEach((s) => {
    if (s.canvas) resizeCanvas(s);
  });
  if (totalChart.canvas) resizeCanvas(totalChart);
}
window.addEventListener('resize', () => {
  resizeAllCharts();
  tcState.forEach(drawChart);
  drawTotalChart();
});
resizeAllCharts();
drawTotalChart();

const es = new EventSource('/events');
es.onmessage = (ev) => {
  const data = JSON.parse(ev.data);
  totalMbpsEl.textContent = data.total_mbps.toFixed(2);
  totalPktsEl.textContent = `${data.total_pkts} / drops ${data.drops}`;
  if (sumLineEl) {
    const predSum = (data.total_pred || 0).toFixed(2);
    const txSum = (data.total_tx || 0).toFixed(2);
    const ratio = ((data.rx_ratio || 0) * 100).toFixed(1);
    sumLineEl.textContent = `${predSum} / ${txSum} / ${ratio}%`;
  }

  const txTotal = (data.tx_tc_mbps || []).reduce((a, b) => a + b, 0);
  totalHistory.rx.push(data.total_mbps);
  totalHistory.tx.push(txTotal);
  if (totalHistory.rx.length > historyLen) totalHistory.rx.shift();
  if (totalHistory.tx.length > historyLen) totalHistory.tx.shift();
  drawTotalChart();

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

  if (data.cap_mode && data.cap_lines) {
    capTableEl.innerHTML = '';
    const lines = data.cap_lines.slice().reverse();
    lines.forEach((line) => {
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

  for (let tc = 0; tc < 8; tc++) {
    const s = tcState[tc];
    s.measured = data.per_tc_mbps[tc] || 0;
    s.tx = (data.tx_tc_mbps && data.tx_tc_mbps[tc]) ? data.tx_tc_mbps[tc] : 0;
    s.expected = (data.exp_mbps && data.exp_mbps[tc]) ? data.exp_mbps[tc] : s.pred;
    s.pass = data.pass[tc];
    s.history.push(s.measured);
    if (s.history.length > historyLen) s.history.shift();
    drawChart(s);
  }
  updateTable();
};
