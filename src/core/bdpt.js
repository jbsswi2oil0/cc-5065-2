import { V, safeUnit } from './vec3.js';
import { geometryTerm, visible } from './geometry.js';
import {
  bsdfEval,
  bsdfPdf,
  emissionEval,
  emissionPdfW,
  isDeltaMaterial,
} from './materials.js';
import { emitterPdfA } from './scenes.js';

export function assembleFullPath(cam, light, s, t) {
  const full = [];
  for (let i = 0; i < s; i++) full.push(cam.vertices[i]);
  if (t > 0) {
    for (let j = t - 1; j >= 0; j--) full.push(light.vertices[j]);
  }
  return full;
}

function rrQ(vertex, depth, options) {
  const start = options.rrStart ?? 2;
  if (depth < start) return 1;
  if (!vertex.mat) return 1;
  if (vertex.rr && vertex.rr.depth === depth && typeof vertex.rr.q === 'number') return vertex.rr.q;
  const c = vertex.mat.color || [0.5, 0.5, 0.5];
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return V.clamp(lum * 1.25, options.rrMin ?? 0.12, options.rrMax ?? 0.92);
}

function mirrorDirectionValid(v, wo, wi) {
  const expected = (() => {
    const neg = V.mul(wo, -1);
    const dot = V.dot(neg, v.n);
    return V.norm(V.sub(neg, V.mul(v.n, 2 * dot)));
  })();
  return V.dist(expected, wi) < 1e-4;
}

function areaFactor(target, d) {
  const r2 = V.dot(d, d);
  if (r2 < 1e-12) return { r: 0, cos: 1, factor: 1e30 };
  const dir = V.div(d, Math.sqrt(r2));
  const cos = target.kind === 'camera' ? 1 : Math.abs(V.dot(target.n, dir));
  return { r: Math.sqrt(r2), cos, factor: cos / r2 };
}

function cameraEdgeDensity(full, i, camera, pixel, options) {
  const a = full[i];
  const b = full[i + 1];
  const dVec = V.sub(b.p, a.p);
  const dist = Math.sqrt(V.dot(dVec, dVec));
  const dir = V.div(dVec, dist);
  const q = rrQ(a, i, options);
  if (a.kind === 'camera') {
    const we = camera.weForPixel(pixel[0], pixel[1], dir);
    if (!we.inside) return { value: 0, feasible: false, reason: 'outside-pixel' };
    const af = areaFactor(b, dVec);
    return { value: q * we.pdfW * af.factor, q, pdfW: we.pdfW, areaFactor: af.factor, delta: false };
  }
  const wo = safeUnit(a.p, full[i - 1].p);
  if (isDeltaMaterial(a.mat)) {
    if (!mirrorDirectionValid(a, wo, dir)) return { value: 0, feasible: false, reason: 'bad-specular-chain' };
    return { value: q, q, pdfW: 1, areaFactor: null, delta: true };
  }
  const pW = bsdfPdf(a.mat, wo, dir, a.n);
  if (!(pW > 1e-12)) return { value: 0, feasible: false, reason: 'zero-bsdf-pdf' };
  const af = areaFactor(b, dVec);
  return { value: q * pW * af.factor, q, pdfW: pW, areaFactor: af.factor, delta: false };
}

function lightEdgeDensity(full, j, options) {
  const a = full[j];
  const b = full[j - 1];
  const n = full.length;
  const lightDepth = n - 1 - j;
  const dVec = V.sub(b.p, a.p);
  const dist = Math.sqrt(V.dot(dVec, dVec));
  const dir = V.div(dVec, dist);
  const q = rrQ(a, lightDepth, options);
  if (a.kind === 'light' || a.mat?.type === 'light') {
    const pW = emissionPdfW(a.mat, a.n, dir);
    if (!(pW > 0)) return { value: 0, feasible: false, reason: 'backside-emission' };
    const af = areaFactor(b, dVec);
    return { value: q * pW * af.factor, q, pdfW: pW, areaFactor: af.factor, delta: false };
  }
  const wo = safeUnit(a.p, full[j + 1].p);
  if (isDeltaMaterial(a.mat)) {
    if (!mirrorDirectionValid(a, wo, dir)) return { value: 0, feasible: false, reason: 'bad-reverse-specular-chain' };
    return { value: q, q, pdfW: 1, areaFactor: null, delta: true };
  }
  const pW = bsdfPdf(a.mat, wo, dir, a.n);
  if (!(pW > 1e-12)) return { value: 0, feasible: false, reason: 'zero-reverse-bsdf-pdf' };
  const af = areaFactor(b, dVec);
  return { value: q * pW * af.factor, q, pdfW: pW, areaFactor: af.factor, delta: false };
}

function emitterPointDensity(scene, v) {
  if (typeof v.pdfPointA === 'number') return v.pdfPointA;
  const prim = scene.prims.find((p) => p.id === v.primId);
  return prim ? emitterPdfA(scene, prim) : 0;
}

export function splitFeasibility(full, s) {
  const n = full.length;
  if (s >= n) return { feasible: true };
  const a = full[s - 1];
  const b = full[s];
  if (s > 1 && a.kind === 'surface' && isDeltaMaterial(a.mat)) {
    return { feasible: false, reason: 'camera-end-specular-not-connectible' };
  }
  if (n - s > 1 && b.kind === 'surface' && isDeltaMaterial(b.mat)) {
    return { feasible: false, reason: 'light-end-specular-not-connectible' };
  }
  return { feasible: true };
}

export function techniqueDensity(scene, camera, pixel, full, s, options = {}) {
  const n = full.length;
  const maxCam = options.maxCameraVertices ?? options.maxVertices ?? 6;
  const maxLight = options.maxLightVertices ?? options.maxVertices ?? 6;
  const components = [];
  const fail = (reason) => ({ s, t: n - s, value: 0, logValue: -Infinity, feasible: false, reason, components });
  if (s === n) {
    if (n > maxCam) return fail('camera-max-length');
    let p = 1;
    let logValue = 0;
    for (let i = 0; i < n - 1; i++) {
      const e = cameraEdgeDensity(full, i, camera, pixel, options);
      components.push({ edge: `${i}->${i + 1}`, side: 'camera', ...e });
      if (e.feasible === false || !(e.value > 0)) return fail(e.reason || 'zero-density');
      p *= e.value;
      logValue += Math.log(e.value);
    }
    return { s, t: 0, value: p, logValue: Number.isFinite(logValue) ? logValue : Math.log(p), feasible: true, components };
  }

  const t = n - s;
  if (s < 1 || t < 1) return fail('endpoint-count');
  if (s > maxCam || t > maxLight) return fail('strategy-max-length');
  const event = splitFeasibility(full, s);
  if (!event.feasible) return fail(event.reason);

  const emitterP = emitterPointDensity(scene, full[n - 1]);
  let p = emitterP;
  let logValue = Math.log(emitterP);
  components.push({ part: 'emitter-area', value: emitterP });
  if (!(emitterP > 0)) return fail('emitter-density');

  for (let i = 0; i <= s - 2; i++) {
    const e = cameraEdgeDensity(full, i, camera, pixel, options);
    components.push({ edge: `${i}->${i + 1}`, side: 'camera', ...e });
    if (e.feasible === false || !(e.value > 0)) return fail(e.reason || 'zero-camera-density');
    p *= e.value;
    logValue += Math.log(e.value);
  }
  for (let j = n - 1; j >= s + 1; j--) {
    const e = lightEdgeDensity(full, j, options);
    components.push({ edge: `${j}->${j - 1}`, side: 'light-reverse', ...e });
    if (e.feasible === false || !(e.value > 0)) return fail(e.reason || 'zero-light-density');
    p *= e.value;
    logValue += Math.log(e.value);
  }
  return { s, t, value: p, logValue: Number.isFinite(logValue) ? logValue : Math.log(p), feasible: true, components };
}

export function computeMisWeights(scene, camera, pixel, full, actualS, options = {}) {
  const n = full.length;
  const beta = options.mis === 'balance' ? 1 : 2;
  const candidates = [];
  for (let s = 1; s < n; s++) {
    candidates.push(techniqueDensity(scene, camera, pixel, full, s, options));
  }
  if (full[n - 1]?.kind === 'light' || full[n - 1]?.mat?.type === 'light') {
    candidates.push(techniqueDensity(scene, camera, pixel, full, n, options));
  }
  let maxLogScore = -Infinity;
  for (const c of candidates) {
    c.logScore = c.feasible && Number.isFinite(c.logValue) ? beta * c.logValue : -Infinity;
    if (c.logScore > maxLogScore) maxLogScore = c.logScore;
  }
  let total = 0;
  for (const c of candidates) {
    c.scaledScore = Number.isFinite(c.logScore) && Number.isFinite(maxLogScore)
      ? Math.exp(c.logScore - maxLogScore)
      : 0;
    total += c.scaledScore;
  }
  for (const c of candidates) {
    c.weight = total > 0 ? c.scaledScore / total : 0;
    c.isActual = c.s === actualS;
  }
  const actual = candidates.find((c) => c.s === actualS && c.t === n - actualS);
  const weightSum = candidates.reduce((a, c) => a + c.weight, 0);
  return { candidates, actual, weightSum, heuristic: beta === 2 ? 'power-2' : 'balance' };
}

function mul(a, b) {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}
function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function classifyStrategy(s, t) {
  const internalSurfaces = s + t - 2;
  if (internalSurfaces <= 1) return 'direct';
  return 'indirect';
}

export function evaluateStrategy(scene, camera, cam, light, s, t, options = {}) {
  const pixel = cam.pixel;
  const key = `${s},${t}`;
  const base = {
    key,
    s,
    t,
    classification: classifyStrategy(s, t),
    accepted: false,
    visible: null,
    geometry: 0,
    visibility: 1,
    unweighted: [0, 0, 0],
    misWeight: 0,
    weighted: [0, 0, 0],
    status: 'not-evaluated',
    full: null,
    mis: null,
    cameraResponse: null,
    endpointPdfs: null,
  };
  if (s < 1 || s > cam.vertices.length) return { ...base, status: 'camera-prefix-missing' };
  if (t < 0 || t > light.vertices.length) return { ...base, status: 'light-prefix-missing' };
  const maxCam = options.maxCameraVertices ?? options.maxVertices ?? 6;
  const maxLight = options.maxLightVertices ?? options.maxVertices ?? 6;
  if (s > maxCam) return { ...base, status: 'strategy-max-camera-length' };
  if (t > maxLight) return { ...base, status: 'strategy-max-light-length' };

  if (t === 0) {
    const v = cam.vertices[s - 1];
    if (v.kind !== 'light' && v.mat?.type !== 'light') return { ...base, status: 't0-last-vertex-not-emitter' };
    const toPrev = safeUnit(v.p, cam.vertices[s - 2].p);
    const le = emissionEval(v.mat, v.n, toPrev);
    const unweighted = mul(v.alpha, le);
    const full = assembleFullPath(cam, light, s, 0);
    const mis = computeMisWeights(scene, camera, pixel, full, s, options);
    const w = mis.actual?.weight ?? 0;
    const emissionPositive = le.some((x) => x > 0);
    return {
      ...base,
      accepted: emissionPositive && w > 0,
      visible: true,
      geometry: null,
      unweighted,
      misWeight: w,
      weighted: scale(unweighted, w),
      status: !emissionPositive ? 'emission-backface' : !(w > 0) ? 'mis-density-infeasible' : 'accepted',
      full,
      mis,
    };
  }

  const a = cam.vertices[s - 1];
  const b = light.vertices[t - 1];
  const event = splitFeasibility([...cam.vertices.slice(0, s), ...[...light.vertices.slice(0, t)].reverse()], s);
  if (!event.feasible) return { ...base, status: event.reason };

  const dirAB = safeUnit(a.p, b.p);
  let cameraResponse = null;
  if (s === 1) {
    cameraResponse = camera.weForPixel(pixel[0], pixel[1], dirAB);
    if (!cameraResponse.inside) {
      const full = assembleFullPath(cam, light, s, t);
      const mis = computeMisWeights(scene, camera, pixel, full, s, options);
      return { ...base, status: 'camera-response-outside-pixel', cameraResponse, full, mis, misWeight: mis.actual?.weight ?? 0 };
    }
  }

  const vis = visible(scene, a.p, b.p);
  const g = geometryTerm(a, b);
  let rgb = mul(a.alpha, b.alpha);
  const endpointPdfs = {};

  if (s === 1) {
    rgb = mul(rgb, cameraResponse.we);
    endpointPdfs.cameraWeW = cameraResponse.pdfW;
  } else if (a.kind === 'surface') {
    const woA = safeUnit(a.p, cam.vertices[s - 2].p);
    const fA = bsdfEval(a.mat, woA, dirAB, a.n);
    endpointPdfs.cameraEndpointPdfW = bsdfPdf(a.mat, woA, dirAB, a.n);
    endpointPdfs.cameraEndpointReversePdfW = bsdfPdf(a.mat, dirAB, woA, a.n);
    rgb = mul(rgb, fA);
  }

  const dirBA = V.mul(dirAB, -1);
  if (t === 1) {
    endpointPdfs.emissionPdfW = emissionPdfW(b.mat, b.n, dirBA);
    endpointPdfs.emission = b.mat.emission;
  } else if (b.kind === 'surface') {
    const woB = safeUnit(b.p, light.vertices[t - 2].p);
    const fB = bsdfEval(b.mat, woB, dirBA, b.n);
    endpointPdfs.lightEndpointPdfW = bsdfPdf(b.mat, woB, dirBA, b.n);
    endpointPdfs.lightEndpointReversePdfW = bsdfPdf(b.mat, dirBA, woB, b.n);
    rgb = mul(rgb, fB);
  }

  rgb = scale(rgb, g * (vis ? 1 : 0));
  const full = assembleFullPath(cam, light, s, t);
  const mis = computeMisWeights(scene, camera, pixel, full, s, options);
  const w = mis.actual?.weight ?? 0;
  const finite = rgb.every(Number.isFinite) && Number.isFinite(w);
  const positive = finite && rgb.some((x) => x > 0);
  return {
    ...base,
    accepted: vis && g > 0 && positive && w > 0,
    visible: vis,
    geometry: g,
    visibility: vis ? 1 : 0,
    unweighted: finite ? rgb : [0, 0, 0],
    misWeight: finite ? w : 0,
    weighted: finite ? scale(rgb, w) : [0, 0, 0],
    status: !vis
      ? 'occluded'
      : g <= 0
        ? 'zero-geometry'
        : !positive
          ? 'zero-bsdf-or-emission'
          : !(w > 0)
            ? 'mis-density-infeasible'
            : 'accepted',
    full,
    mis,
    cameraResponse,
    endpointPdfs,
  };
}

export function evaluateAllStrategies(scene, camera, cam, light, options = {}) {
  const attempts = [];
  for (let s = 1; s <= cam.vertices.length; s++) {
    for (let t = 1; t <= light.vertices.length; t++) {
      attempts.push(evaluateStrategy(scene, camera, cam, light, s, t, options));
    }
  }
  for (let s = 1; s <= cam.vertices.length; s++) {
    if (cam.vertices[s - 1]?.kind === 'light' || cam.vertices[s - 1]?.mat?.type === 'light') {
      attempts.push(evaluateStrategy(scene, camera, cam, light, s, 0, options));
    }
  }
  return attempts;
}
