import { V, safeUnit } from './vec3.js';
import { Rng, hashSeed } from './rng.js';
import { Camera } from './camera.js';
import { makeRay, intersectScene, geometryTerm, visible } from './geometry.js';
import { sampleEmitter, emitterPdfA } from './scenes.js';
import { bsdfEval, bsdfPdf, sampleBsdf, rrSurvival, isDeltaMaterial } from './materials.js';

function powerWeight(pdfA, pdfB) {
  const a = pdfA * pdfA;
  const b = pdfB * pdfB;
  return a / (a + b || 1);
}

export function traceUnidirectionalSample(scene, camera, px, py, rng, options = {}) {
  const maxVertices = options.maxCameraVertices ?? 6;
  const rrStart = options.rrStart ?? 2;
  let ray = camera.rayForPixel(px, py, rng);
  let throughput = [1, 1, 1];
  let radiance = [0, 0, 0];
  const parts = { directNee: [0, 0, 0], emissionHit: [0, 0, 0], indirect: [0, 0, 0] };
  let lastBsdfPdfW = 1;
  let lastDelta = false;
  let depth = 0;
  const path = [];

  while (depth < maxVertices - 1) {
    const hit = intersectScene(scene, ray);
    if (!hit) break;
    const v = hit;
    path.push({ p: hit.p, materialId: hit.prim.materialId });
    const wo = V.mul(ray.d, -1);

    if (hit.material.type === 'light') {
      const toEye = wo;
      const le = hit.material.emission;
      let weight = 1;
      if (depth > 0 && !lastDelta) {
        const r2 = V.dist(hit.p, ray.o) ** 2;
        const cosLight = Math.abs(V.dot(hit.prim.normal, ray.d));
        const pdfLightA = emitterPdfA(scene, hit.prim);
        const pdfNeeW = (pdfLightA * r2) / Math.max(1e-6, cosLight);
        weight = powerWeight(lastBsdfPdfW, pdfNeeW);
      }
      if (depth === 0) weight = 1;
      const contribution = V.mulV(throughput, V.mul(le, weight));
      radiance = V.add(radiance, contribution);
      if (depth === 0) parts.emissionHit = V.add(parts.emissionHit, contribution);
      else parts.indirect = V.add(parts.indirect, contribution);
      break;
    }

    if (!isDeltaMaterial(hit.material)) {
      const emitter = sampleEmitter(scene, rng);
      const toLight = safeUnit(hit.p, emitter.p);
      const cosSurface = Math.max(0, V.dot(hit.n, toLight));
      const cosLight = Math.max(0, V.dot(emitter.n, V.mul(toLight, -1)));
      if (cosSurface > 0 && cosLight > 0 && visible(scene, hit.p, emitter.p)) {
        const g = geometryTerm({ p: hit.p, n: hit.n, kind: 'surface' }, emitter);
        const f = bsdfEval(hit.material, wo, toLight, hit.n);
        const pdfNeeW = (emitter.pdfA * V.dist(hit.p, emitter.p) ** 2) / cosLight;
        const pdfBsdfW = bsdfPdf(hit.material, wo, toLight, hit.n);
        const w = options.mis === false ? 1 : powerWeight(pdfNeeW, pdfBsdfW);
        const term = V.mulV(throughput, V.mulV(f, emitter.material.emission));
        const neeContribution = V.mul(term, (g * w) / emitter.pdfA);
        radiance = V.add(radiance, neeContribution);
        if (depth === 0) parts.directNee = V.add(parts.directNee, neeContribution);
        else parts.indirect = V.add(parts.indirect, neeContribution);
      }
    }

    depth++;
    if (depth >= rrStart) {
      const q = rrSurvival(hit.material, depth, options);
      if (rng.next() >= q) break;
      throughput = V.div(throughput, q);
    }

    const u1 = rng.next();
    const u2 = rng.next();
    const pick = rng.next();
    const sampled = sampleBsdf(hit.material, wo, hit.n, u1, u2, pick);
    if (!sampled.delta && sampled.pdfW <= 1e-8) break;
    lastBsdfPdfW = sampled.pdfW;
    lastDelta = !!sampled.delta;
    if (sampled.delta) {
      throughput = V.mulV(throughput, hit.material.color || [1, 1, 1]);
    } else {
      const f = bsdfEval(hit.material, wo, sampled.wi, hit.n);
      const cos = Math.abs(V.dot(hit.n, sampled.wi));
      throughput = V.mulV(throughput, V.div(V.mulV(f, [cos, cos, cos]), sampled.pdfW));
    }
    if (!throughput.every(Number.isFinite) || Math.max(...throughput) > 1e8) break;
    ray = makeRay(V.add(hit.p, V.mul(hit.n, 1.2e-4)), sampled.wi);
  }
  return { radiance, parts, path };
}

export class PtReferenceRenderer {
  constructor(scene, cameraParams, width, height, options = {}) {
    this.scene = scene;
    this.width = width;
    this.height = height;
    this.camera = new Camera({ width, height, ...cameraParams });
    this.options = options;
    this.accum = new Float64Array(width * height * 3);
    this.samples = 0;
    this.seedBase = options.seedBase ?? 424242;
    this.luminanceHistory = [];
  }

  setCameraParams(params) {
    this.camera = new Camera({ width: this.width, height: this.height, ...params });
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
          const y = Math.floor(idx / this.width);
          const x = idx - y * this.width;
          const rng = new Rng(hashSeed(this.seedBase, sampleIndex, y, x, 'pt'));
          const { radiance } = traceUnidirectionalSample(this.scene, this.camera, x, y, rng, this.options);
          const i = idx * 3;
          this.accum[i] += radiance[0];
          this.accum[i + 1] += radiance[1];
          this.accum[i + 2] += radiance[2];
        }
        cursor = end;
        if (onProgress) onProgress({ phase: 'chunk', sample: this.samples + 1, pixelCursor: cursor, totalPixels: total });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (this.stopRequested) break;
      this.samples++;
      this.luminanceHistory.push(this.meanLuminance());
      if (onProgress) await onProgress({ phase: 'sample', sample: this.samples, targetSpp, renderer: this });
    }
    return { stopped: this.stopRequested, samples: this.samples };
  }

  requestStop() {
    this.stopRequested = true;
  }

  displayData(exposure = 1.1) {
    const out = new Float32Array(this.width * this.height * 4);
    const n = Math.max(1, this.samples);
    for (let i = 0, j = 0; i < this.accum.length; i += 3, j += 4) {
      out[j] = toneChannel((this.accum[i] / n) * exposure);
      out[j + 1] = toneChannel((this.accum[i + 1] / n) * exposure);
      out[j + 2] = toneChannel((this.accum[i + 2] / n) * exposure);
      out[j + 3] = 255;
    }
    return out;
  }

  renderSynchronously(spp) {
    for (let n = 0; n < spp; n++) {
      const sampleIndex = this.samples + n;
      for (let y = 0; y < this.height; y++) {
        for (let x = 0; x < this.width; x++) {
          const rng = new Rng(hashSeed(this.seedBase, sampleIndex, y, x, 'pt'));
          const { radiance } = traceUnidirectionalSample(this.scene, this.camera, x, y, rng, this.options);
          const i = (y * this.width + x) * 3;
          this.accum[i] += radiance[0];
          this.accum[i + 1] += radiance[1];
          this.accum[i + 2] += radiance[2];
        }
      }
      this.luminanceHistory.push(this.meanLuminanceAfter(this.samples + n + 1));
    }
    this.samples += spp;
  }

  meanLuminanceAfter(n) {
    let sum = 0;
    for (let i = 0; i < this.accum.length; i += 3) {
      sum += 0.2126 * (this.accum[i] / n) + 0.7152 * (this.accum[i + 1] / n) + 0.0722 * (this.accum[i + 2] / n);
    }
    return sum / (this.width * this.height);
  }

  meanLuminance() {
    return this.meanLuminanceAfter(Math.max(1, this.samples));
  }
}

function toneChannel(x) {
  const v = 1 - Math.exp(-Math.max(0, x));
  return Math.round(Math.pow(Math.min(1, v), 1 / 2.2) * 255);
}
