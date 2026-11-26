import { Rng, hashSeed } from './rng.js';
import { Camera } from './camera.js';
import { generateCameraPath, generateLightPath } from './pathgen.js';
import { evaluateAllStrategies } from './bdpt.js';
import { evaluateAllStrategiesPlanned } from './connect.js';

function makeCostAccumulator() {
  return {
    pixelSamples: 0,
    candidates: 0,
    eventPruned: 0,
    geometryPruned: 0,
    interfacePruned: 0,
    cameraRejected: 0,
    budgetPruned: 0,
    visibilityRays: 0,
    visibilityBlocked: 0,
    budgetRefunded: 0,
  };
}

export class BdptRenderer {
  constructor(scene, cameraParams, width, height, options = {}) {
    this.scene = scene;
    this.width = width;
    this.height = height;
    this.cameraParams = cameraParams;
    this.camera = this.makeCamera();
    this.options = {
      maxCameraVertices: 6,
      maxLightVertices: 6,
      rrStart: 2,
      mis: 'power',
      connectionMode: 'baseline',
      connectionBudget: Infinity,
      ...options,
    };
    this.beauty = new Float64Array(width * height * 3);
    this.strategies = new Map();
    this.samples = 0;
    this.seedBase = options.seedBase ?? 918273;
    this.statusCounts = new Map();
    this.sampleLuminance = [];
    this.stopRequested = false;
    this.connectionCost = makeCostAccumulator();
  }

  requestStop() {
    this.stopRequested = true;
  }

  makeCamera() {
    const p = this.cameraParams;
    return new Camera({
      width: this.width,
      height: this.height,
      eye: p.eye,
      target: p.target,
      fov: p.fov ?? 48,
    });
  }

  setCameraParams(params) {
    this.cameraParams = { ...this.cameraParams, ...params };
    this.camera = this.makeCamera();
  }

  clear() {
    this.beauty.fill(0);
    this.strategies.clear();
    this.samples = 0;
    this.statusCounts.clear();
    this.sampleLuminance = [];
    this.stopRequested = false;
    this.connectionCost = makeCostAccumulator();
  }

  strategyBuffer(key, s, t) {
    let b = this.strategies.get(key);
    if (!b) {
      b = { key, s, t, data: new Float64Array(this.width * this.height * 3), total: [0, 0, 0], accepted: 0 };
      this.strategies.set(key, b);
    }
    return b;
  }

  renderPixelSample(px, py, sampleIndex) {
    const seed = hashSeed(this.seedBase, sampleIndex, py, px);
    const rng = new Rng(seed);
    const cam = generateCameraPath(this.scene, this.camera, px, py, rng, this.options);
    const light = generateLightPath(this.scene, rng, this.options);
    let attempts;
    if (this.options.connectionMode === 'baseline') {
      attempts = evaluateAllStrategies(this.scene, this.camera, cam, light, this.options);
      this.accumulateBaselineCost(cam, light, attempts);
    } else {
      const budgetRng = new Rng(hashSeed(seed, 'connection-budget'));
      const planned = evaluateAllStrategiesPlanned(this.scene, this.camera, cam, light, {
        ...this.options,
        connectionRng: budgetRng,
      });
      attempts = planned.attempts;
      this.accumulateCost(planned.cost);
    }
    const sum = [0, 0, 0];
    const idx = (py * this.width + px) * 3;
    for (const a of attempts) {
      const b = this.strategyBuffer(a.key, a.s, a.t);
      b.data[idx] += a.weighted[0];
      b.data[idx + 1] += a.weighted[1];
      b.data[idx + 2] += a.weighted[2];
      if (a.accepted) b.accepted++;
      b.total[0] += a.weighted[0];
      b.total[1] += a.weighted[1];
      b.total[2] += a.weighted[2];
      sum[0] += a.weighted[0];
      sum[1] += a.weighted[1];
      sum[2] += a.weighted[2];
      this.statusCounts.set(a.status, (this.statusCounts.get(a.status) || 0) + 1);
    }
    this.beauty[idx] += sum[0];
    this.beauty[idx + 1] += sum[1];
    this.beauty[idx + 2] += sum[2];
    return { cam, light, attempts, sum };
  }

  accumulateCost(cost) {
    const c = this.connectionCost;
    c.pixelSamples++;
    c.candidates += cost.candidates;
    c.eventPruned += cost.eventRejected;
    c.geometryPruned += cost.geometryZeroProbes;
    c.interfacePruned += cost.interfacePruned;
    c.cameraRejected += cost.cameraRejected;
    c.budgetPruned += cost.budgetDeferred;
    c.visibilityRays += cost.visibilityRays;
    c.visibilityBlocked += cost.visibilityBlocked;
    c.budgetRefunded += cost.budgetRefunded;
  }

  // 基线模式下没有规划器，直接从尝试结果统计真实可见性工作量，作为对照基准。
  accumulateBaselineCost(cam, light, attempts) {
    const c = this.connectionCost;
    c.pixelSamples++;
    c.candidates += cam.vertices.length * light.vertices.length;
    for (const a of attempts) {
      if (a.t === 0) continue;
      if (a.visible !== null) c.visibilityRays++;
      if (a.visible === false) c.visibilityBlocked++;
    }
  }

  costBreakdown() {
    const c = this.connectionCost;
    const n = Math.max(1, c.pixelSamples);
    const traced = Math.max(1, c.visibilityRays);
    return {
      mode: this.options.connectionMode,
      pixelSamples: c.pixelSamples,
      perPixel: {
        candidates: c.candidates / n,
        visibilityRays: c.visibilityRays / n,
        eventPruned: c.eventPruned / n,
        geometryPruned: c.geometryPruned / n,
        interfacePruned: c.interfacePruned / n,
        cameraRejected: c.cameraRejected / n,
        budgetDeferred: c.budgetPruned / n,
        budgetRefunded: c.budgetRefunded / n,
      },
      totals: { ...c },
      blockedRayRate: c.visibilityBlocked / traced,
      traceFraction: c.visibilityRays / Math.max(1, c.candidates),
      pruneRate: (c.eventPruned + c.geometryPruned + c.cameraRejected) / Math.max(1, c.candidates),
    };
  }

  renderSynchronously(spp = 1) {
    for (let n = 0; n < spp; n++) {
      const sampleIndex = this.samples + n;
      for (let py = 0; py < this.height; py++) {
        for (let px = 0; px < this.width; px++) {
          this.renderPixelSample(px, py, sampleIndex);
        }
      }
      const mean = this.meanLuminanceAfterSamples(this.samples + n + 1);
      this.sampleLuminance.push(mean);
    }
    this.samples += spp;
  }

  async renderSppAsync(targetSpp, { chunkPixels = 1200, onProgress } = {}) {
    this.stopRequested = false;
    const total = this.width * this.height;
    while (this.samples < targetSpp && !this.stopRequested) {
      const sampleIndex = this.samples;
      let cursor = 0;
      while (cursor < total && !this.stopRequested) {
        const end = Math.min(total, cursor + chunkPixels);
        for (let idx = cursor; idx < end; idx++) {
          const py = Math.floor(idx / this.width);
          const px = idx - py * this.width;
          this.renderPixelSample(px, py, sampleIndex);
        }
        cursor = end;
        if (onProgress) onProgress({ phase: 'chunk', sample: this.samples + 1, pixelCursor: cursor, totalPixels: total });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (this.stopRequested) break;
      this.samples++;
      this.sampleLuminance.push(this.meanLuminance());
      if (onProgress) await onProgress({ phase: 'sample', sample: this.samples, targetSpp, renderer: this });
    }
    return { stopped: this.stopRequested, samples: this.samples };
  }

  displayData(exposure = 1.1) {
    const out = new Float32Array(this.width * this.height * 4);
    const n = Math.max(1, this.samples);
    for (let i = 0, j = 0; i < this.beauty.length; i += 3, j += 4) {
      const r = toneMapChannel((this.beauty[i] / n) * exposure);
      const g = toneMapChannel((this.beauty[i + 1] / n) * exposure);
      const b = toneMapChannel((this.beauty[i + 2] / n) * exposure);
      out[j] = r;
      out[j + 1] = g;
      out[j + 2] = b;
      out[j + 3] = 255;
    }
    return out;
  }

  meanLuminance() {
    const n = Math.max(1, this.samples);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < this.beauty.length; i += 3) {
      const r = this.beauty[i] / n;
      const g = this.beauty[i + 1] / n;
      const b = this.beauty[i + 2] / n;
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count++;
    }
    return sum / count;
  }

  meanLuminanceAfterSamples(n) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < this.beauty.length; i += 3) {
      sum += 0.2126 * (this.beauty[i] / n) + 0.7152 * (this.beauty[i + 1] / n) + 0.0722 * (this.beauty[i + 2] / n);
      count++;
    }
    return sum / count;
  }

  strategySummary() {
    const n = Math.max(1, this.samples * this.width * this.height);
    return [...this.strategies.values()]
      .map((b) => ({
        key: b.key,
        s: b.s,
        t: b.t,
        meanLum: (0.2126 * b.total[0] + 0.7152 * b.total[1] + 0.0722 * b.total[2]) / n,
        accepted: b.accepted,
      }))
      .sort((a, b) => a.s - b.s || a.t - b.t);
  }
}

function toneMapChannel(x) {
  const v = 1 - Math.exp(-Math.max(0, x));
  return Math.round(Math.pow(Math.min(1, v), 1 / 2.2) * 255);
}

export function inspectPath(scene, cameraParams, width, height, px, py, seed = 1, options = {}) {
  const camera = new Camera({ width, height, ...cameraParams });
  const rng = new Rng(seed);
  const opts = { maxCameraVertices: 6, maxLightVertices: 6, rrStart: 2, connectionMode: 'baseline', ...options };
  const cam = generateCameraPath(scene, camera, px, py, rng, opts);
  const light = generateLightPath(scene, rng, opts);
  let attempts;
  let cost = null;
  let reports = null;
  if (opts.connectionMode === 'baseline') {
    attempts = evaluateAllStrategies(scene, camera, cam, light, opts);
  } else {
    const planned = evaluateAllStrategiesPlanned(scene, camera, cam, light, {
      ...opts,
      connectionRng: new Rng(hashSeed(seed, 'inspect-budget')),
    });
    attempts = planned.attempts;
    cost = planned.cost;
    reports = planned.reports;
  }
  return { camera, cam, light, attempts, cost, reports, connectionMode: opts.connectionMode };
}
