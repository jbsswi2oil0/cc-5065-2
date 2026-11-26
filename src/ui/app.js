import { createScene } from '../core/scenes.js';
import { orbitCameraParams } from '../core/camera.js';
import { BdptRenderer, inspectPath } from '../core/renderer.js';
import { PtReferenceRenderer } from '../core/pathtracer.js';
import { classifyStrategy } from '../core/bdpt.js';
import { runValidation, validateBrightness } from '../core/validation.js';

const $ = (id) => document.getElementById(id);

const RESOLUTIONS = {
  '72x45': [72, 45],
  '96x60': [96, 60],
  '128x80': [128, 80],
};

const state = {
  sceneId: 'corner',
  scene: createScene('corner'),
  width: 96,
  height: 60,
  params: null,
  options: {},
  renderer: null,
  pt: null,
  view: 'beauty',
  focusStrategy: null,
  selectedPixel: { x: 48, y: 30 },
  inspect: null,
  selectedAttemptKey: null,
  renderToken: 0,
  referenceToken: 0,
  activeReferenceToken: null,
  cameraTimer: null,
};

const offscreen = document.createElement('canvas');
const offCtx = offscreen.getContext('2d');

function fmt(v, digits = 4) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 10000 || a < 0.0001) return v.toExponential(2);
  return v.toFixed(digits);
}
function vec(v, digits = 3) {
  if (!Array.isArray(v)) return '—';
  return `[${v.map((x) => fmt(x, digits)).join(', ')}]`;
}
function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function rgbLuminance(d, i) {
  return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
}
function toneChannel(x, exposure) {
  const v = 1 - Math.exp(-Math.max(0, x * exposure));
  return Math.round(Math.pow(Math.min(1, v), 1 / 2.2) * 255);
}

function readCameraParams() {
  const c = state.scene.camera;
  const target = [c.target[0], Number($('targetY').value), c.target[2]];
  const params = orbitCameraParams(
    Number($('yaw').value),
    Number($('pitch').value),
    Number($('distance').value),
    target,
  );
  params.fov = Number($('fov').value);
  return params;
}

function readOptions() {
  const maxVertices = Number($('maxVertices').value);
  return {
    maxVertices,
    maxCameraVertices: maxVertices,
    maxLightVertices: maxVertices,
    rrStart: Number($('rrStart').value),
    mis: $('mis').value,
    connectionMode: $('connectionMode').value,
    connectionBudget: Number($('connectionBudget').value),
  };
}

function syncControlLabels() {
  $('yawValue').textContent = Number($('yaw').value).toFixed(2);
  $('pitchValue').textContent = Number($('pitch').value).toFixed(2);
  $('distanceValue').textContent = Number($('distance').value).toFixed(2);
  $('targetYValue').textContent = Number($('targetY').value).toFixed(2);
  $('fovValue').textContent = `${$('fov').value}°`;
  $('exposureValue').textContent = Number($('exposure').value).toFixed(2);
  $('maxVerticesValue').textContent = $('maxVertices').value;
  $('rrStartValue').textContent = $('rrStart').value;
  $('connectionBudgetValue').textContent = $('connectionBudget').value;
  const budgetEnabled = $('connectionMode').value === 'optimized';
  $('connectionBudget').disabled = !budgetEnabled;
}

function renderConnectionCost() {
  const panel = $('connectionCost');
  const body = $('connectionCostBody');
  const r = state.renderer;
  if (!r || r.options.connectionMode === 'baseline') {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const cb = r.costBreakdown();
  const p = cb.perPixel;
  body.textContent = [
    `模式: ${cb.mode}`,
    `候选/像素: ${p.candidates.toFixed(2)}`,
    `可见性光线/像素: ${p.visibilityRays.toFixed(2)}（占候选 ${(cb.traceFraction * 100).toFixed(1)}%）`,
    `界面硬剪枝/像素: ${p.interfacePruned.toFixed(2)}`,
    `事件/零几何/相机软拒绝/像素: ${p.eventPruned.toFixed(2)} / ${p.geometryPruned.toFixed(2)} / ${p.cameraRejected.toFixed(2)}`,
    `预算递延/像素: ${p.budgetDeferred.toFixed(2)}`,
    `归还预算/像素: ${p.budgetRefunded.toFixed(2)}`,
    `已发射光线阻断率: ${(cb.blockedRayRate * 100).toFixed(1)}%`,
  ].join('\n');
}

function loadSceneControls(id) {
  state.sceneId = id;
  state.scene = createScene(id);
  const c = state.scene.camera;
  $('yaw').value = c.yaw;
  $('pitch').value = c.pitch;
  $('distance').value = c.distance;
  $('targetY').value = c.target[1];
  $('fov').value = c.fov;
  $('sceneDescription').textContent = state.scene.description;
  syncControlLabels();
  state.params = readCameraParams();
}

function setKernelState(mode, text) {
  const el = $('kernelState');
  el.dataset.state = mode;
  el.textContent = text;
}

function makeRenderer() {
  state.options = readOptions();
  state.params = readCameraParams();
  if (state.pt) {
    state.referenceToken++;
    state.pt.requestStop?.();
  }
  state.pt = null;
  state.renderer = new BdptRenderer(state.scene, state.params, state.width, state.height, {
    seedBase: 918273,
    ...state.options,
  });
  state.focusStrategy = null;
}

async function startRender() {
  const myToken = ++state.renderToken;
  try { state.renderer?.requestStop?.(); } catch { /* noop */ }
  makeRenderer();
  clampPixelToBuffer();
  setKernelState('running', 'BDPT 内核渲染中');
  $('renderStatus').textContent = '初始化子路径生成器…';
  const targetSpp = Number($('targetSpp').value);

  const result = await state.renderer.renderSppAsync(targetSpp, {
    chunkPixels: 900,
    onProgress: (e) => {
      if (myToken !== state.renderToken) return;
      if (e.phase === 'chunk') {
        const done = (state.renderer.samples * state.width * state.height + e.pixelCursor);
        const total = targetSpp * state.width * state.height;
        $('renderProgress').style.width = `${Math.min(100, (done / total) * 100)}%`;
        drawMain();
      } else {
        $('renderProgress').style.width = `${(e.sample / targetSpp) * 100}%`;
        $('renderStatus').textContent = `已完成 ${e.sample}/${targetSpp} SPP`;
        updateMetrics();
        drawMain();
        renderStrategyGrid();
        drawConvergence();
      }
    },
  });

  if (myToken !== state.renderToken) return;
  updateMetrics();
  drawMain();
  renderStrategyGrid();
  drawConvergence();
  renderConnectionCost();
  if (result.stopped) {
    setKernelState('idle', '渲染已停止');
    $('renderStatus').textContent = `已停止，保留 ${state.renderer.samples} SPP 累积`;
  } else {
    setKernelState('done', `BDPT ${state.renderer.samples} SPP 完成`);
    $('renderStatus').textContent = `完成：${state.renderer.samples} SPP，${state.width}×${state.height} 内部缓冲`;
  }
}

function scheduleCameraRestart() {
  syncControlLabels();
  state.params = readCameraParams();
  clearTimeout(state.cameraTimer);
  setKernelState('running', '相机参数已变更，等待内核重启');
  state.cameraTimer = setTimeout(() => {
    $('referenceStatus').textContent = '相机已变更，旧参照正在停止';
    startRender();
    inspectPixel();
  }, 220);
}

function clampPixelToBuffer() {
  state.selectedPixel.x = clampInt($('pixelX').value, 0, state.width - 1, Math.floor(state.width / 2));
  state.selectedPixel.y = clampInt($('pixelY').value, 0, state.height - 1, Math.floor(state.height / 2));
  $('pixelX').max = state.width - 1;
  $('pixelY').max = state.height - 1;
  $('pixelX').value = state.selectedPixel.x;
  $('pixelY').value = state.selectedPixel.y;
}

function categoryData(category) {
  const r = state.renderer;
  const exposure = Number($('exposure').value);
  const raw = new Float64Array(r.width * r.height * 3);
  for (const b of r.strategies.values()) {
    if (classifyStrategy(b.s, b.t) !== category) continue;
    for (let i = 0; i < raw.length; i++) raw[i] += b.data[i];
  }
  const out = new Float32Array(r.width * r.height * 4);
  const n = Math.max(1, r.samples);
  for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
    out[j] = toneChannel(raw[i] / n, exposure);
    out[j + 1] = toneChannel(raw[i + 1] / n, exposure);
    out[j + 2] = toneChannel(raw[i + 2] / n, exposure);
    out[j + 3] = 255;
  }
  return out;
}

function strategyData(b) {
  const exposure = Number($('exposure').value);
  const n = Math.max(1, state.renderer.samples);
  const out = new Float32Array(state.width * state.height * 4);
  for (let i = 0, j = 0; i < b.data.length; i += 3, j += 4) {
    out[j] = toneChannel(b.data[i] / n, exposure);
    out[j + 1] = toneChannel(b.data[i + 1] / n, exposure);
    out[j + 2] = toneChannel(b.data[i + 2] / n, exposure);
    out[j + 3] = 255;
  }
  return out;
}

function differenceData() {
  const exposure = Number($('exposure').value);
  const a = state.renderer.displayData(exposure);
  const b = state.pt.displayData(exposure);
  const out = new Float32Array(state.width * state.height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = Math.max(0, Math.min(255, 128 + (a[i] - b[i]) * 4));
    out[i + 1] = Math.max(0, Math.min(255, 128 + (a[i + 1] - b[i + 1]) * 4));
    out[i + 2] = Math.max(0, Math.min(255, 128 + (a[i + 2] - b[i + 2]) * 4));
    out[i + 3] = 255;
  }
  return out;
}

function paintPixelData(canvas, data, w, h) {
  offscreen.width = w;
  offscreen.height = h;
  offCtx.clearRect(0, 0, w, h);
  const bytes = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
  offCtx.putImageData(new ImageData(bytes, w, h), 0, 0);

  const scale = Math.max(1, Math.floor(760 / w));
  if (canvas.width !== w * scale || canvas.height !== h * scale) {
    canvas.width = w * scale;
    canvas.height = h * scale;
  }
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
  return ctx;
}

function drawMain() {
  const canvas = $('renderCanvas');
  if (!state.renderer) return;
  let data;
  let notice = '';
  if (state.focusStrategy) {
    const b = state.renderer.strategies.get(state.focusStrategy);
    data = b ? strategyData(b) : state.renderer.displayData(Number($('exposure').value));
  } else if (state.view === 'reference') {
    if (state.pt?.samples) data = state.pt.displayData(Number($('exposure').value));
    else { data = state.renderer.displayData(Number($('exposure').value)); notice = 'PT 参照尚未运行：当前显示 BDPT'; }
  } else if (state.view === 'difference') {
    if (state.pt?.samples) data = differenceData();
    else { data = state.renderer.displayData(Number($('exposure').value)); notice = '运行 PT 参照后显示 ×4 差异'; }
  } else if (state.view === 'direct' || state.view === 'indirect') {
    data = categoryData(state.view);
  } else {
    data = state.renderer.displayData(Number($('exposure').value));
  }
  const ctx = paintPixelData(canvas, data, state.width, state.height);
  if (notice) {
    ctx.fillStyle = 'rgba(5,8,13,.72)';
    ctx.fillRect(0, canvas.height - 42, canvas.width, 42);
    ctx.fillStyle = '#ffd166';
    ctx.font = `${Math.max(16, canvas.width / 42)}px system-ui`;
    ctx.fillText(notice, 18, canvas.height - 15);
  }
  const focus = state.focusStrategy ? ` · 策略 ${state.focusStrategy}` : '';
  $('imageMeta').textContent = `${state.width}×${state.height} · ${state.renderer.samples} SPP${focus}`;
}

function renderStrategyGrid() {
  const grid = $('strategyGrid');
  const summaries = state.renderer.strategySummary();
  grid.innerHTML = '';
  for (const s of summaries) {
    const b = state.renderer.strategies.get(s.key);
    const card = document.createElement('div');
    card.className = `strategy-card${state.focusStrategy === s.key ? ' selected' : ''}`;
    card.dataset.key = s.key;
    const canvas = document.createElement('canvas');
    canvas.width = state.width;
    canvas.height = state.height;
    const ctx = canvas.getContext('2d');
    const bytes = new Uint8ClampedArray(strategyData(b));
    ctx.putImageData(new ImageData(bytes, state.width, state.height), 0, 0);
    const cls = classifyStrategy(s.s, s.t);
    card.appendChild(canvas);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `
      <div class="title"><span>(${s.s},${s.t})</span><span>${cls === 'direct' ? '直接' : '间接'}</span></div>
      <div class="sub">L=${fmt(s.meanLum, 5)} · ✓${s.accepted}</div>`;
    card.appendChild(meta);
    grid.appendChild(card);
  }
  $('strategySummary').innerHTML = summaries
    .filter((s) => s.meanLum > 0 || s.accepted > 0)
    .sort((a, b) => b.meanLum - a.meanLum)
    .slice(0, 14)
    .map((s) => `<span class="pill">(${s.s},${s.t}) <b>${fmt(s.meanLum, 5)}</b> · ${s.accepted}</span>`)
    .join('');
}

function updateMetrics() {
  if (!state.renderer) return;
  const bdptMean = state.renderer.meanLuminance();
  $('metricBdpt').textContent = fmt(bdptMean, 5);
  $('metricSpp').textContent = state.renderer.samples;
  const accepted = state.renderer.statusCounts.get('accepted') || 0;
  $('metricAccepted').textContent = accepted.toLocaleString('zh-CN');
  if (state.pt?.samples) {
    const ptMean = state.pt.meanLuminance();
    $('metricPt').textContent = fmt(ptMean, 5);
    $('metricRatio').textContent = fmt(bdptMean / Math.max(1e-8, ptMean), 3);
    $('metricRmse').textContent = `${fmt(relativeLuminanceRmse() * 100, 2)}%`;
  }
}

function relativeLuminanceRmse() {
  const r = state.renderer;
  const p = state.pt;
  const nB = Math.max(1, r.samples);
  const nP = Math.max(1, p.samples);
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < r.beauty.length; i += 3) {
    const lb = rgbLuminance(r.beauty, i) / nB;
    const lp = rgbLuminance(p.accum, i) / nP;
    sumSq += (lb - lp) ** 2;
    count++;
  }
  const rmse = Math.sqrt(sumSq / count);
  return rmse / Math.max(1e-6, p.meanLuminance());
}

async function runReference() {
  if (!state.renderer) return;
  const myToken = ++state.referenceToken;
  state.activeReferenceToken = myToken;
  $('runReference').disabled = true;
  $('referenceStatus').textContent = 'PT 参照生成中…';
  state.pt = new PtReferenceRenderer(state.scene, state.params, state.width, state.height, {
    seedBase: 884422,
    maxCameraVertices: Number($('maxVertices').value),
    rrStart: Number($('rrStart').value),
    mis: $('mis').value,
  });
  const target = Number($('referenceSpp').value);
  try {
    const result = await state.pt.renderSppAsync(target, {
      chunkPixels: 900,
      onProgress: (e) => {
        if (myToken !== state.referenceToken) return;
        if (e.phase === 'sample') {
          $('referenceStatus').textContent = `PT ${e.sample}/${target} SPP`;
          if (state.view === 'reference' || state.view === 'difference') drawMain();
          drawConvergence();
        }
      },
    });
    if (myToken !== state.referenceToken || !state.pt) return;
    $('referenceStatus').textContent = result.stopped ? '参照已停止' : `PT 参照完成：${state.pt.samples} SPP`;
    updateMetrics();
    drawMain();
    drawConvergence();
  } finally {
    if (state.activeReferenceToken === myToken) {
      state.activeReferenceToken = null;
      $('runReference').disabled = false;
    }
  }
}

function drawConvergence() {
  const canvas = $('convergenceCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#080d14';
  ctx.fillRect(0, 0, W, H);
  const b = state.renderer?.sampleLuminance || [];
  const p = state.pt?.luminanceHistory || [];
  const all = [...b, ...p];
  if (all.length < 1) return;
  let max = Math.max(...all) * 1.15;
  let min = Math.min(...all) * 0.85;
  if (!(max > min)) { max += 0.001; min = Math.max(0, min - 0.001); }
  const padL = 58;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const xMax = Math.max(b.length, p.length, 2);
  const X = (i) => padL + (i / Math.max(1, xMax - 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);

  ctx.strokeStyle = '#26354a';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#91a4ba';
  ctx.font = '11px ui-monospace, monospace';
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * (H - padT - padB);
    const value = max - (g / 4) * (max - min);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(fmt(value, 4), 8, y + 4);
  }
  ctx.fillText('SPP →', W - 58, H - 8);

  const line = (arr, color, dashed = false) => {
    if (!arr.length) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    if (dashed) ctx.setLineDash([7, 5]);
    ctx.beginPath();
    arr.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)));
    ctx.stroke();
    ctx.restore();
  };
  line(b, '#69d2ff');
  line(p, '#ffc46b', true);
}

function inspectPixel() {
  clampPixelToBuffer();
  const px = state.selectedPixel.x;
  const py = state.selectedPixel.y;
  const seed = clampInt($('pathSeed').value, 0, 2 ** 31 - 1, 20261126);
  state.options = readOptions();
  state.inspect = inspectPath(state.scene, state.params, state.width, state.height, px, py, seed, state.options);
  const accepted = state.inspect.attempts.filter((a) => a.accepted);
  state.selectedAttemptKey = (accepted[0] || state.inspect.attempts[0])?.key || null;
  const statusCounts = new Map();
  for (const a of state.inspect.attempts) statusCounts.set(a.status, (statusCounts.get(a.status) || 0) + 1);
  const summary = [...statusCounts.entries()].map(([k, v]) => `${k}×${v}`).join('，');
  const costText = state.inspect.cost
    ? ` 连接规划：候选 ${state.inspect.cost.candidates}，硬剪枝 ${state.inspect.cost.hardPruned}，可见性光线 ${state.inspect.cost.visibilityRays}，归还预算 ${state.inspect.cost.budgetRefunded}。`
    : '';
  $('inspectStatus').textContent = `相机路径 ${state.inspect.cam.vertices.length} 顶点（${state.inspect.cam.termination}）；灯光路径 ${state.inspect.light.vertices.length} 顶点（${state.inspect.light.termination}）。${accepted.length} 个加权接受连接。${costText} 内核状态：${summary}`;
  renderAttemptList();
  renderDetail();
  drawTopView();
}

function renderAttemptList() {
  const host = $('attemptList');
  if (!state.inspect) {
    host.textContent = '尚未生成尝试。';
    return;
  }
  const attempts = [...state.inspect.attempts].sort((a, b) => Number(b.accepted) - Number(a.accepted) || a.s - b.s || a.t - b.t);
  host.innerHTML = '';
  for (const a of attempts) {
    const kind = a.accepted ? 'accepted' : a.status === 'occluded' ? 'occluded' : 'neutral';
    const el = document.createElement('button');
    el.className = `attempt${state.selectedAttemptKey === a.key ? ' selected' : ''}`;
    el.dataset.key = a.key;
    const lum = a.weighted ? 0.2126 * a.weighted[0] + 0.7152 * a.weighted[1] + 0.0722 * a.weighted[2] : 0;
    el.innerHTML = `
      <div class="row1"><span>策略 (${a.s},${a.t}) · ${classifyStrategy(a.s, a.t) === 'direct' ? '直接' : '间接'}</span><span class="badge ${kind}">${a.accepted ? 'accepted' : a.status}</span></div>
      <div class="row2"><span>MIS w=${fmt(a.misWeight, 4)}</span><span>${a.geometry ? `G=${fmt(a.geometry, 3)}` : 't=0'} · L=${fmt(lum, 5)}</span></div>`;
    host.appendChild(el);
  }
}

function selectedAttempt() {
  return state.inspect?.attempts.find((a) => a.key === state.selectedAttemptKey) || null;
}

function renderDetail() {
  const host = $('detailPanel');
  const a = selectedAttempt();
  if (!a) {
    host.textContent = '选择一次策略尝试后显示完整路径记录。';
    return;
  }
  const ep = a.endpointPdfs || {};
  const candidates = a.mis?.candidates || [];
  host.innerHTML = `
    <div class="kv">
      <span>status</span><code>${a.status}</code>
      <span>accepted</span><b>${a.accepted}</b>
      <span>visible</span><b>${a.visible === null ? '未做线段检查' : a.visible}</b>
      <span>geometry term</span><code>${fmt(a.geometry, 6)}</code>
      <span>MIS</span><b>${a.mis?.heuristic || '—'} · actual=${fmt(a.misWeight, 8)} · Σw=${fmt(a.mis?.weightSum, 10)}</b>
      <span>unweighted RGB</span><code>${vec(a.unweighted, 5)}</code>
      <span>weighted RGB</span><code>${vec(a.weighted, 5)}</code>
      <span>camera We/pdf</span><code>${a.cameraResponse ? `${vec(a.cameraResponse.we, 3)} / ${fmt(a.cameraResponse.pdfW, 3)}` : 'not s=1'}</code>
      <span>endpoint pdfs</span><code>${Object.keys(ep).length ? Object.entries(ep).map(([k, v]) => `${k}=${Array.isArray(v) ? vec(v, 2) : fmt(v, 4)}`).join('<br>') : '—'}</code>
    </div>
    <h2>完整路径顶点与正反密度</h2>
    <table>
      <thead><tr><th>#</th><th>端点/材质</th><th>介质侧</th><th>p</th><th>BSDF pdf 正/反 W</th><th>面积 pdf 正/反</th><th>RR</th></tr></thead>
      <tbody>${a.full.map((v, i) => vertexRow(v, i)).join('')}</tbody>
    </table>
    <h2>同一光路的可行拆分 / MIS 候选</h2>
    <table>
      <thead><tr><th>split</th><th>状态</th><th>log p</th><th>scaled</th><th>weight</th></tr></thead>
      <tbody>${candidates.map((c) => {
        const key = `${c.s},${c.t}`;
        const linked = state.inspect.attempts.some((x) => x.key === key);
        return `
        <tr class="mis-row${c.isActual ? ' actual' : ''}${linked ? '' : ' unlinked'}" data-key="${key}" title="${linked ? '查看该前缀组合的连接记录' : '密度已沿完整路径重算；该拆分超出本轮两条子路径的可用前缀'}">
          <td>(${c.s},${c.t})${c.isActual ? ' ★' : ''}${linked ? '' : ' ·密度'}</td>
          <td>${c.feasible ? 'feasible' : `<span class="badge bad">${c.reason}</span>`}</td>
          <td><code>${Number.isFinite(c.logValue) ? c.logValue.toFixed(2) : '-∞'}</code></td>
          <td>${fmt(c.scaledScore, 5)}</td>
          <td><b>${fmt(c.weight, 6)}</b></td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;
}

function vertexRow(v, i) {
  const d = v.densityRecord;
  const rr = v.rr || {};
  const role = i === 0 ? 'camera' : v.kind === 'light' ? 'light' : v.mat?.type || v.kind;
  const forwardW = d ? `${fmt(d.pdfForwardW, 4)} / ${fmt(d.pdfReverseW, 4)}` : (v.edge ? `edge ${fmt(v.edge.sampledPdfW, 3)}` : '—');
  const forwardA = d ? `${fmt(d.pdfForwardArea, 4)} / ${fmt(d.pdfReverseArea, 4)}` : (v.edge?.jointAreaPdf ? fmt(v.edge.jointAreaPdf, 4) : '—');
  const rrText = rr.reason
    ? `q=${rr.q === null || rr.q === undefined ? '—' : fmt(rr.q, 3)}<br>${rr.reason}${rr.draw !== null && rr.draw !== undefined ? `<br>draw=${fmt(rr.draw, 3)}` : ''}`
    : '—';
  return `<tr>
    <td>${i}</td><td><code>${role}</code><br>${v.materialId || v.cameraId || ''}</td>
    <td><code>side ${v.mediumSide ?? 0}</code></td>
    <td><code>${vec(v.p, 2)}</code></td>
    <td>${forwardW}</td><td>${forwardA}</td><td>${rrText}</td>
  </tr>`;
}

function drawTopView() {
  const canvas = $('topCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#080d14';
  ctx.fillRect(0, 0, W, H);

  const minX = -3.45, maxX = 3.45, minZ = -3.25, maxZ = 5.95;
  const pad = 28;
  const scale = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxZ - minZ));
  const ox = (W - (maxX - minX) * scale) / 2;
  const oy = (H - (maxZ - minZ) * scale) / 2;
  const X = (x) => ox + (x - minX) * scale;
  const Y = (z) => oy + (z - minZ) * scale;

  ctx.strokeStyle = 'rgba(145,164,186,.16)';
  ctx.lineWidth = 1;
  for (let x = -3; x <= 3; x++) {
    ctx.beginPath(); ctx.moveTo(X(x), Y(minZ)); ctx.lineTo(X(x), Y(maxZ)); ctx.stroke();
  }
  for (let z = -3; z <= 5; z++) {
    ctx.beginPath(); ctx.moveTo(X(minX), Y(z)); ctx.lineTo(X(maxX), Y(z)); ctx.stroke();
  }

  for (const prim of state.scene.prims) {
    const mat = state.scene.materials[prim.materialId];
    const c = mat?.color || [0.5, 0.5, 0.5];
    const fill = `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},.13)`;
    const stroke = mat?.type === 'light' ? 'rgba(255,209,102,.9)' : `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},.42)`;
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = mat?.type === 'light' ? 2 : 1;
    ctx.beginPath();
    if (prim.kind === 'sphere') {
      ctx.arc(X(prim.c[0]), Y(prim.c[2]), prim.r * scale, 0, Math.PI * 2);
    } else {
      const pts = [prim.p00, prim.e11, prim.p11, prim.e21];
      pts.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[2])) : ctx.moveTo(X(p[0]), Y(p[2])));
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
  }

  if (!state.inspect) {
    ctx.fillStyle = '#91a4ba';
    ctx.font = '13px system-ui';
    ctx.fillText('点击“生成并连接”后显示俯视路径', 72, H / 2);
    return;
  }

  for (const a of state.inspect.attempts) {
    if (!a.accepted || a.t <= 0) continue;
    const av = state.inspect.cam.vertices[a.s - 1];
    const bv = state.inspect.light.vertices[a.t - 1];
    if (!av || !bv) continue;
    ctx.strokeStyle = 'rgba(103,232,165,.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(av.p[0]), Y(av.p[2]));
    ctx.lineTo(X(bv.p[0]), Y(bv.p[2]));
    ctx.stroke();
  }

  drawSubPath(ctx, state.inspect.cam.vertices, X, Y, '#65d8ff');
  drawSubPath(ctx, state.inspect.light.vertices, X, Y, '#ffd166');

  const a = selectedAttempt();
  if (a && a.t > 0) {
    const av = state.inspect.cam.vertices[a.s - 1];
    const bv = state.inspect.light.vertices[a.t - 1];
    if (av && bv) {
      ctx.save();
      ctx.strokeStyle = a.visible === false ? '#ff5d73' : '#67e8a5';
      ctx.lineWidth = 3;
      if (a.visible === false) ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(X(av.p[0]), Y(av.p[2]));
      ctx.lineTo(X(bv.p[0]), Y(bv.p[2]));
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#e6edf7';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(`(${a.s},${a.t}) ${a.status}`, 12, 18);
    }
  }
}

function drawSubPath(ctx, vertices, X, Y, color) {
  if (!vertices.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  vertices.forEach((v, i) => {
    const x = X(v.p[0]);
    const y = Y(v.p[2]);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.stroke();
  vertices.forEach((v, i) => {
    ctx.beginPath();
    ctx.fillStyle = i === 0 ? '#ffffff' : color;
    ctx.arc(X(v.p[0]), Y(v.p[2]), i === 0 ? 5 : 3.6, 0, Math.PI * 2);
    ctx.fill();
    if (i > 0) {
      ctx.fillStyle = '#c9d7e8';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(String(i), X(v.p[0]) + 5, Y(v.p[2]) - 5);
    }
  });
}

async function runNumericValidation() {
  const out = $('validationOutput');
  $('runValidation').disabled = true;
  out.textContent = '内核正在枚举 MIS 拆分并运行亮度对照…';
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const base = runValidation();
    const brightness = validateBrightness();
    const checks = [...base.checks, ...brightness];
    const ok = checks.every((c) => c.pass);
    let text = `${ok ? 'ALL PASS' : 'HAS FAILURE'}\n`;
    for (const c of checks) {
      text += `\n[${c.pass ? 'PASS' : 'FAIL'}] ${c.name}\n`;
      if (c.name.startsWith('MIS')) text += `  checked=${c.checked}, maxSumError=${c.maxSumError.toExponential(3)}, zeroActualWeight=${c.zeroActualWeight}\n`;
      if (c.name.startsWith('forward/reverse')) text += `  vertices=${c.vertices}, bad=${c.bad}, reciprocityError=${c.maxReciprocityError}\n`;
      if (c.name === 'segment visibility rejects blocker and accepts open side') text += `  blocked=${c.blocked}, clearSide=${c.clearSide}\n`;
      if ('ratio' in c) text += `  bdpt=${c.bdpt.toFixed(6)}, pt=${c.pt.toFixed(6)}, ratio=${c.ratio.toFixed(3)}\n`;
    }
    text += '\n命令行等价检查：npm run check';
    out.textContent = text;
    setKernelState(ok ? 'done' : 'error', ok ? '数值验证全部通过' : '数值验证存在失败');
  } catch (error) {
    out.textContent = `验证器抛出内核错误：\n${error?.stack || error}`;
    setKernelState('error', '验证器错误');
  } finally {
    $('runValidation').disabled = false;
  }
}

function wireEvents() {
  for (const id of ['yaw', 'pitch', 'distance', 'targetY', 'fov']) {
    $(id).addEventListener('input', scheduleCameraRestart);
  }
  $('exposure').addEventListener('input', () => {
    syncControlLabels();
    drawMain();
    renderStrategyGrid();
  });
  $('maxVertices').addEventListener('input', () => {
    syncControlLabels();
    clearTimeout(state.cameraTimer);
    state.cameraTimer = setTimeout(() => {
      startRender();
      inspectPixel();
    }, 220);
  });
  $('rrStart').addEventListener('input', () => {
    syncControlLabels();
    clearTimeout(state.cameraTimer);
    state.cameraTimer = setTimeout(() => {
      startRender();
      inspectPixel();
    }, 220);
  });
  $('mis').addEventListener('change', () => {
    startRender();
    inspectPixel();
  });
  $('connectionMode').addEventListener('change', () => {
    syncControlLabels();
    startRender();
    inspectPixel();
  });
  $('connectionBudget').addEventListener('input', () => {
    syncControlLabels();
    clearTimeout(state.cameraTimer);
    state.cameraTimer = setTimeout(() => {
      startRender();
      inspectPixel();
    }, 220);
  });
  $('sceneSelect').addEventListener('change', (e) => {
    loadSceneControls(e.target.value);
    state.selectedPixel = { x: Math.floor(state.width / 2), y: Math.floor(state.height / 2) };
    $('pixelX').value = state.selectedPixel.x;
    $('pixelY').value = state.selectedPixel.y;
    startRender();
    inspectPixel();
  });
  $('resolution').addEventListener('change', (e) => {
    const [w, h] = RESOLUTIONS[e.target.value];
    state.width = w;
    state.height = h;
    state.selectedPixel = { x: Math.floor(w / 2), y: Math.floor(h / 2) };
    clampPixelToBuffer();
    startRender();
    inspectPixel();
  });
  $('targetSpp').addEventListener('change', () => {
    if (!state.renderer) startRender();
    else {
      const target = Number($('targetSpp').value);
      if (target >= state.renderer.samples) startRender();
    }
  });
  $('restartRender').addEventListener('click', startRender);
  $('stopRender').addEventListener('click', () => {
    state.renderer?.requestStop();
    $('stopRender').disabled = true;
    setTimeout(() => { $('stopRender').disabled = false; }, 120);
    setKernelState('running', '已请求停止，等待当前像素块结束');
  });
  $('runReference').addEventListener('click', runReference);
  $('runValidation').addEventListener('click', runNumericValidation);
  $('inspectPath').addEventListener('click', inspectPixel);
  $('pixelX').addEventListener('change', () => { clampPixelToBuffer(); });
  $('pixelY').addEventListener('change', () => { clampPixelToBuffer(); });
  $('pathSeed').addEventListener('change', () => {});

  $('renderCanvas').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    state.selectedPixel.x = clampInt(((e.clientX - rect.left) / rect.width) * state.width, 0, state.width - 1, 0);
    state.selectedPixel.y = clampInt(((e.clientY - rect.top) / rect.height) * state.height, 0, state.height - 1, 0);
    $('pixelX').value = state.selectedPixel.x;
    $('pixelY').value = state.selectedPixel.y;
    inspectPixel();
  });

  $('viewMode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    state.focusStrategy = null;
    for (const b of $('viewMode').querySelectorAll('button')) b.classList.toggle('active', b === btn);
    drawMain();
    renderStrategyGrid();
  });

  $('strategyGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.strategy-card');
    if (!card) return;
    state.focusStrategy = state.focusStrategy === card.dataset.key ? null : card.dataset.key;
    for (const b of $('viewMode').querySelectorAll('button')) b.classList.remove('active');
    drawMain();
    renderStrategyGrid();
  });

  $('attemptList').addEventListener('click', (e) => {
    const btn = e.target.closest('.attempt');
    if (!btn) return;
    state.selectedAttemptKey = btn.dataset.key;
    renderAttemptList();
    renderDetail();
    drawTopView();
  });

  $('detailPanel').addEventListener('click', (e) => {
    const row = e.target.closest('.mis-row');
    if (!row || !state.inspect) return;
    const key = row.dataset.key;
    if (state.inspect.attempts.some((a) => a.key === key)) {
      state.selectedAttemptKey = key;
      renderAttemptList();
      renderDetail();
      drawTopView();
    }
  });
}

function init() {
  const initialResolution = RESOLUTIONS[$('resolution').value] || RESOLUTIONS['96x60'];
  state.width = initialResolution[0];
  state.height = initialResolution[1];
  loadSceneControls($('sceneSelect').value);
  clampPixelToBuffer();
  wireEvents();
  drawConvergence();
  inspectPixel();
  startRender();
}

init();
