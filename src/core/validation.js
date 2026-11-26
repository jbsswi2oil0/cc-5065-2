import { Rng } from './rng.js';
import { createScene } from './scenes.js';
import { orbitCameraParams, Camera } from './camera.js';
import { generateCameraPath, generateLightPath } from './pathgen.js';
import { evaluateAllStrategies } from './bdpt.js';
import { visible } from './geometry.js';
import { BdptRenderer } from './renderer.js';
import { PtReferenceRenderer } from './pathtracer.js';

function cameraFor(id, width = 40, height = 26) {
  const scene = createScene(id);
  const params = orbitCameraParams(scene.camera.yaw, scene.camera.pitch, scene.camera.distance, scene.camera.target);
  params.fov = scene.camera.fov;
  return { scene, camera: new Camera({ width, height, ...params }), params };
}

export function validateMisWeights(samplesPerScene = 160) {
  const results = [];
  for (const id of ['corner', 'slit', 'occlusion']) {
    const { scene, camera } = cameraFor(id);
    const options = { maxCameraVertices: 5, maxLightVertices: 5, rrStart: 2 };
    let checked = 0;
    let maxSumError = 0;
    let zeroActualWeight = 0;
    for (let i = 0; i < samplesPerScene; i++) {
      const px = i % camera.width;
      const py = Math.floor(i / camera.width) % camera.height;
      const cam = generateCameraPath(scene, camera, px, py, new Rng(10000 + i), options);
      const light = generateLightPath(scene, new Rng(90000 + i), options);
      const attempts = evaluateAllStrategies(scene, camera, cam, light, options);
      for (const a of attempts) {
        if (!a.mis || !a.accepted) continue;
        checked++;
        const err = Math.abs(a.mis.weightSum - 1);
        maxSumError = Math.max(maxSumError, err);
        if (!(a.misWeight > 0)) zeroActualWeight++;
      }
    }
    results.push({ name: `MIS weights normalize: ${id}`, checked, maxSumError, zeroActualWeight, pass: checked > 20 && maxSumError < 1e-10 && zeroActualWeight === 0 });
  }
  return results;
}

export function validateDensityRecords(samplesPerScene = 120) {
  const results = [];
  for (const id of ['corner', 'slit', 'occlusion']) {
    const { scene, camera } = cameraFor(id);
    const options = { maxCameraVertices: 5, maxLightVertices: 5, rrStart: 2 };
    let vertices = 0;
    let maxReciprocityError = 0;
    let bad = 0;
    for (let i = 0; i < samplesPerScene; i++) {
      const cam = generateCameraPath(scene, camera, i % camera.width, Math.floor(i / camera.width) % camera.height, new Rng(30000 + i), options);
      for (const v of cam.vertices) {
        if (!v.densityRecord || v.mat?.type === 'mirror') continue;
        vertices++;
        const d = v.densityRecord;
        maxReciprocityError = Math.max(maxReciprocityError, d.reciprocalBsdfDifference || 0);
        if (!(d.pdfForwardW >= 0) || !(d.pdfReverseW >= 0) || !Number.isFinite(d.pdfForwardArea + d.pdfReverseArea)) bad++;
        if (d.pdfForwardW > 1e-8 && d.pdfForwardArea <= 0) bad++;
      }
    }
    results.push({ name: `forward/reverse density records: ${id}`, vertices, maxReciprocityError, bad, pass: vertices > 100 && bad === 0 && maxReciprocityError < 1e-10 });
  }
  return results;
}

export function validateVisibility() {
  const scene = createScene('occlusion');
  const blocked = !visible(scene, [0.05, 1.2, 1.35], [0.05, 1.2, -1.75]);
  const clearSide = visible(scene, [2.72, 1.85, 1.2], [2.72, 1.85, -1.8]);
  return {
    name: 'segment visibility rejects blocker and accepts open side',
    blocked,
    clearSide,
    pass: blocked && clearSide,
  };
}

export function validateSpecularFiltering(samplesPerScene = 180) {
  const counts = {
    'camera-end-specular-not-connectible': 0,
    'light-end-specular-not-connectible': 0,
    mirrorDensityRecords: 0,
  };
  for (const id of ['corner', 'slit', 'occlusion']) {
    const scene = createScene(id);
    const params = orbitCameraParams(scene.camera.yaw, scene.camera.pitch, scene.camera.distance, scene.camera.target);
    params.fov = scene.camera.fov;
    const camera = new Camera({ width: 48, height: 30, ...params });
    const options = { maxCameraVertices: 6, maxLightVertices: 6, rrStart: 2 };
    for (let i = 0; i < samplesPerScene; i++) {
      const cam = generateCameraPath(scene, camera, i % camera.width, Math.floor(i / camera.width) % camera.height, new Rng(1234 + i), options);
      const light = generateLightPath(scene, new Rng(5678 + i), options);
      for (const v of [...cam.vertices, ...light.vertices]) {
        if (v.densityRecord?.specular) counts.mirrorDensityRecords++;
      }
      for (const a of evaluateAllStrategies(scene, camera, cam, light, options)) {
        if (a.status in counts) counts[a.status]++;
      }
    }
  }
  return {
    name: 'specular endpoints are filtered before arbitrary connections',
    ...counts,
    pass: counts['camera-end-specular-not-connectible'] > 0
      && counts['light-end-specular-not-connectible'] > 0
      && counts.mirrorDensityRecords > 0,
  };
}

export function validateStrategyPartition() {
  const results = [];
  for (const id of ['corner', 'slit', 'occlusion']) {
    const scene = createScene(id);
    const params = orbitCameraParams(scene.camera.yaw, scene.camera.pitch, scene.camera.distance, scene.camera.target);
    params.fov = scene.camera.fov;
    const renderer = new BdptRenderer(scene, params, 28, 18, {
      seedBase: 31337,
      maxCameraVertices: 5,
      maxLightVertices: 5,
    });
    renderer.renderSynchronously(2);
    const partition = new Float64Array(renderer.beauty.length);
    for (const buffer of renderer.strategies.values()) {
      for (let i = 0; i < partition.length; i++) partition[i] += buffer.data[i];
    }
    let maxRelativeError = 0;
    for (let i = 0; i < partition.length; i++) {
      const error = Math.abs(partition[i] - renderer.beauty[i]);
      maxRelativeError = Math.max(maxRelativeError, error / Math.max(1e-12, Math.abs(renderer.beauty[i])));
    }
    results.push({
      name: `strategy buffers partition beauty exactly: ${id}`,
      strategies: renderer.strategies.size,
      maxRelativeError,
      pass: maxRelativeError < 1e-10,
    });
  }
  return results;
}

export function validateBrightness() {
  const out = [];
  for (const id of ['corner', 'slit', 'occlusion']) {
    const scene = createScene(id);
    const params = orbitCameraParams(scene.camera.yaw, scene.camera.pitch, scene.camera.distance, scene.camera.target);
    params.fov = scene.camera.fov;
    const W = 36;
    const H = 22;
    const bdpt = new BdptRenderer(scene, params, W, H, { seedBase: 77, maxCameraVertices: 5, maxLightVertices: 5 });
    bdpt.renderSynchronously(8);
    const pt = new PtReferenceRenderer(scene, params, W, H, { seedBase: 88, maxCameraVertices: 6 });
    pt.renderSynchronously(32);
    const ratio = bdpt.meanLuminance() / Math.max(1e-6, pt.meanLuminance());
    out.push({ name: `brightness ratio BDPT8/PT32: ${id}`, bdpt: bdpt.meanLuminance(), pt: pt.meanLuminance(), ratio, pass: ratio > 0.55 && ratio < 1.65 });
  }
  return out;
}

export function runValidation({ brightness = false } = {}) {
  const checks = [
    ...validateMisWeights(),
    ...validateDensityRecords(),
    validateVisibility(),
    validateSpecularFiltering(),
    ...validateStrategyPartition(),
  ];
  if (brightness) checks.push(...validateBrightness());
  return {
    ok: checks.every((c) => c.pass),
    checks,
  };
}
