import { Rng, hashSeed } from './rng.js';
import { Camera } from './camera.js';
import { generateCameraPath, generateLightPath } from './pathgen.js';
import { evaluateAllStrategies } from './bdpt.js';

export class BdptRenderer {
  constructor(scene, cameraParams, width, height, options = {}) {
    this.scene = scene;
    this.width = width;
    this.height = height;
    this.cameraParams = cameraParams;
    this.camera = this.makeCamera();
    this.options = { maxCameraVertices: 6, maxLightVertices: 6, rrStart: 2, mis: 'power', ...options };
    this.beauty = new Float64Array(width * height * 3);
    this.strategies = new Map();
    this.samples = 0;
    this.seedBase = options.seedBase ?? 918273;
    this.statusCounts = new Map();
    this.sampleLuminance = [];
    this.stopRequested = false;
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
    const attempts = evaluateAllStrategies(this.scene, this.camera, cam, light, this.options);
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
  const opts = { maxCameraVertices: 6, maxLightVertices: 6, rrStart: 2, ...options };
  const cam = generateCameraPath(scene, camera, px, py, rng, opts);
  const light = generateLightPath(scene, rng, opts);
  const attempts = evaluateAllStrategies(scene, camera, cam, light, opts);
  return { camera, cam, light, attempts };
}
