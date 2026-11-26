import { V, safeUnit, cosineHemisphereSample } from './vec3.js';
import { makeRay, intersectScene } from './geometry.js';
import { sampleEmitter } from './scenes.js';
import {
  bsdfEval,
  bsdfPdf,
  sampleBsdf,
  rrSurvival,
  isDeltaMaterial,
  emissionPdfW,
} from './materials.js';

function clone3(x) {
  return [x[0], x[1], x[2]];
}

function areaConversion(sourceP, target, d) {
  const r = V.dist(sourceP, target.p);
  if (r < 1e-9) return { r, cosTarget: 1, factor: 1e30 };
  const cosTarget = target.kind === 'camera' ? 1 : Math.abs(V.dot(target.n, d));
  return { r, cosTarget, factor: cosTarget / (r * r) };
}

function rrRecord(v, depth, options, rng, maxVertices = options.maxVertices ?? 6) {
  if (depth >= maxVertices - 1) {
    return { depth, applicable: false, q: 0, draw: null, survived: false, terminationProbability: 1, reason: 'max-length' };
  }
  const start = options.rrStart ?? 2;
  if (depth < start) {
    return { depth, applicable: false, q: 1, draw: null, survived: true, terminationProbability: 0, reason: 'minimum-bounces' };
  }
  const q = rrSurvival(v.mat, depth, options);
  const draw = rng.next();
  return {
    depth,
    applicable: true,
    q,
    draw,
    survived: draw < q,
    terminationProbability: 1 - q,
    reason: draw < q ? 'survived' : 'russian-roulette-terminated',
  };
}

function makeSurfaceVertex(hit, prev, edgeInfo, alpha) {
  return {
    kind: 'surface',
    p: hit.p,
    n: hit.n,
    gn: hit.gn,
    primId: hit.prim.id,
    materialId: hit.prim.materialId,
    mat: hit.material,
    uv: hit.uv,
    distance: hit.t,
    alpha: clone3(alpha),
    edge: edgeInfo,
    rr: null,
    densityRecord: null,
  };
}

function updateDensityRecords(path) {
  const vs = path.vertices;
  for (let i = 1; i < vs.length; i++) {
    const v = vs[i];
    if (v.kind !== 'surface' || i + 1 >= vs.length) continue;
    const prev = vs[i - 1];
    const next = vs[i + 1];
    const wo = safeUnit(v.p, prev.p);
    const wi = safeUnit(v.p, next.p);
    const rNext = V.dist(v.p, next.p);
    const rPrev = V.dist(v.p, prev.p);
    const fwdW = bsdfPdf(v.mat, wo, wi, v.n);
    const revW = bsdfPdf(v.mat, wi, wo, v.n);
    const cosNext = next.kind === 'camera' ? 1 : Math.abs(V.dot(next.n, wi));
    const dirToPrev = V.mul(wo, -1);
    const cosPrev = prev.kind === 'camera' ? 1 : Math.abs(V.dot(prev.n, dirToPrev));
    v.densityRecord = {
      wo,
      wi,
      pdfForwardW: fwdW,
      pdfReverseW: revW,
      pdfForwardArea: (fwdW * cosNext) / (rNext * rNext),
      pdfReverseArea: (revW * cosPrev) / (rPrev * rPrev),
      reciprocalBsdfDifference: maxAbsDiff(bsdfEval(v.mat, wo, wi, v.n), bsdfEval(v.mat, wi, wo, v.n)),
      specular: isDeltaMaterial(v.mat),
    };
  }
}

function maxAbsDiff(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

function traceExtension(scene, rng, path, options) {
  const vs = path.vertices;
  const v = vs[vs.length - 1];
  const depth = vs.length - 1;
  const maxVertices = path.side === 'light'
    ? (options.maxLightVertices ?? options.maxVertices ?? 6)
    : (options.maxCameraVertices ?? options.maxVertices ?? 6);
  if (v.mat && v.mat.type === 'light') {
    v.rr = { depth, applicable: false, q: null, draw: null, survived: false, terminationProbability: 0, reason: 'emitter-hit' };
    path.termination = 'emitter-hit';
    return;
  }
  const rr = rrRecord(v, depth, options, rng, maxVertices);
  v.rr = rr;
  if (!rr.survived) {
    path.termination = rr.reason;
    return;
  }

  const prev = vs[depth - 1];
  const wo = safeUnit(v.p, prev.p);
  const u1 = rng.next();
  const u2 = rng.next();
  const pick = rng.next();
  const s = sampleBsdf(v.mat, wo, v.n, u1, u2, pick);
  v.outgoing = { ...s, sampledUsing: { u1, u2, pick } };
  if (!s.delta && (!(s.pdfW > 1e-8) || !Number.isFinite(s.pdfW))) {
    path.termination = 'zero-bsdf-pdf';
    return;
  }
  const origin = V.add(v.p, V.mul(v.n, 1.2e-4));
  const ray = makeRay(origin, s.wi);
  const hit = intersectScene(scene, ray);
  if (!hit) {
    path.termination = 'miss';
    return;
  }
  const d = safeUnit(v.p, hit.p);
  const conv = areaConversion(v.p, { p: hit.p, n: hit.n, kind: 'surface' }, d);
  const q = rr.q ?? 1;
  let nextAlpha;
  if (s.delta) {
    nextAlpha = V.mulV(v.alpha, V.div(v.mat.color || [1, 1, 1], q));
  } else {
    const f = bsdfEval(v.mat, wo, s.wi, v.n);
    const cos = Math.abs(V.dot(v.n, s.wi));
    const factor = V.mul(V.mulV(f, [cos, cos, cos]), 1 / (q * s.pdfW));
    nextAlpha = V.mulV(v.alpha, factor);
  }
  if (!nextAlpha.every(Number.isFinite) || Math.max(...nextAlpha) > 1e8) {
    path.termination = 'throughput-guard';
    return;
  }
  const edge = {
    from: v.index,
    to: depth + 1,
    component: s.component,
    delta: !!s.delta,
    sampledPdfW: s.pdfW,
    rrQ: q,
    cosTarget: conv.cosTarget,
    distance: conv.r,
    areaPdfNoRR: s.delta ? null : s.pdfW * conv.factor,
    jointAreaPdf: s.delta ? null : q * s.pdfW * conv.factor,
    deltaConversion: s.delta ? conv.factor : null,
  };
  const nv = makeSurfaceVertex(hit, v, edge, nextAlpha);
  nv.index = vs.length;
  vs.push(nv);
  path.length = vs.length;
  traceExtension(scene, rng, path, options);
}

export function generateCameraPath(scene, camera, px, py, rng, options = {}) {
  const ray = camera.rayForPixel(px, py, rng);
  const path = {
    side: 'camera',
    pixel: [px, py],
    seed: rng.startSeed,
    vertices: [],
    termination: 'running',
    primaryPdfW: ray.pdfW,
  };
  path.vertices.push({
    kind: 'camera',
    index: 0,
    p: camera.eye,
    n: camera.forward,
    cameraId: 'pinhole',
    pixel: [px, py],
    alpha: [1, 1, 1],
    rr: { depth: 0, applicable: false, q: 1, reason: 'camera-endpoint' },
  });
  const hit = intersectScene(scene, ray);
  if (!hit) {
    path.termination = 'camera-miss';
    updateDensityRecords(path);
    return path;
  }
  const r = V.dist(camera.eye, hit.p);
  const cosHit = Math.abs(V.dot(hit.n, ray.d));
  const pdfA = (ray.pdfW * cosHit) / (r * r);
  const edge = {
    from: 0,
    to: 1,
    component: 'pinhole-ray',
    delta: false,
    sampledPdfW: ray.pdfW,
    rrQ: 1,
    cosTarget: cosHit,
    distance: r,
    areaPdfNoRR: pdfA,
    jointAreaPdf: pdfA,
  };
  const v = makeSurfaceVertex(hit, path.vertices[0], edge, [1, 1, 1]);
  v.index = 1;
  path.vertices.push(v);
  path.length = path.vertices.length;
  traceExtension(scene, rng, path, options);
  updateDensityRecords(path);
  return path;
}

export function generateLightPath(scene, rng, options = {}) {
  const emitter = sampleEmitter(scene, rng);
  const path = {
    side: 'light',
    seed: rng.startSeed,
    vertices: [],
    termination: 'running',
    emitterPdfA: emitter.pdfA,
  };
  const le = emitter.material.emission;
  path.vertices.push({
    kind: 'light',
    index: 0,
    p: emitter.p,
    n: emitter.n,
    primId: emitter.prim.id,
    materialId: emitter.prim.materialId,
    mat: emitter.material,
    pdfPointA: emitter.pdfA,
    chooseP: emitter.chooseP,
    alpha: V.div(le, emitter.pdfA),
    rr: { depth: 0, applicable: false, q: 1, reason: 'emitter-endpoint' },
  });

  const u1 = rng.next();
  const u2 = rng.next();
  const wi = cosineHemisphereSample(emitter.n, u1, u2);
  const pdfW = emissionPdfW(emitter.material, emitter.n, wi);
  if (pdfW <= 0) {
    path.termination = 'emission-direction-zero';
    return path;
  }
  const origin = V.add(emitter.p, V.mul(emitter.n, 1.2e-4));
  const hit = intersectScene(scene, makeRay(origin, wi));
  if (!hit) {
    path.termination = 'light-miss';
    return path;
  }
  const d = safeUnit(emitter.p, hit.p);
  const conv = areaConversion(emitter.p, { p: hit.p, n: hit.n, kind: 'surface' }, d);
  const factor = Math.abs(V.dot(emitter.n, wi)) / pdfW;
  const alpha1 = V.mul(path.vertices[0].alpha, factor);
  const edge = {
    from: 0,
    to: 1,
    component: 'diffuse-emission',
    delta: false,
    sampledPdfW: pdfW,
    rrQ: 1,
    cosSource: Math.abs(V.dot(emitter.n, wi)),
    cosTarget: conv.cosTarget,
    distance: conv.r,
    areaPdfNoRR: pdfW * conv.factor,
    jointAreaPdf: pdfW * conv.factor,
  };
  const v = makeSurfaceVertex(hit, path.vertices[0], edge, alpha1);
  v.index = 1;
  path.vertices.push(v);
  path.length = path.vertices.length;
  traceExtension(scene, rng, path, options);
  updateDensityRecords(path);
  return path;
}
