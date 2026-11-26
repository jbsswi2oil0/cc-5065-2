import { V, cosineHemisphereSample, reflectDirection } from './vec3.js';

export const EVENTS = {
  DIFFUSE: 1,
  GLOSSY: 2,
  SPECULAR: 4,
  EMISSIVE: 8,
};

export function isDeltaMaterial(mat) {
  return mat && mat.type === 'mirror';
}

export function isConnectibleMaterial(mat) {
  return mat && !isDeltaMaterial(mat);
}

export function emissionEval(mat, n, d) {
  if (!mat || mat.type !== 'light') return [0, 0, 0];
  if (V.dot(n, d) <= 0) return [0, 0, 0];
  return mat.emission;
}

export function emissionPdfW(mat, n, d) {
  if (!mat || mat.type !== 'light' || V.dot(n, d) <= 0) return 0;
  return V.dot(n, d) / Math.PI;
}

function ggxAlpha(mat) {
  const r = V.clamp(mat.roughness ?? 0.55, 0.04, 1);
  return Math.max(0.045, r * r);
}

function ggxPdf(mat, wo, wi, n) {
  if (V.dot(n, wo) <= 1e-5 || V.dot(n, wi) <= 1e-5) return 0;
  const h = V.norm(V.add(wo, wi));
  if (V.dot(n, h) <= 0 || V.dot(wo, h) <= 0) return 0;
  const alpha = ggxAlpha(mat);
  const nh = V.dot(n, h);
  const a2 = alpha * alpha;
  const d = a2 / (Math.PI * Math.pow(nh * nh * (a2 - 1) + 1, 2));
  return (d * nh) / (4 * Math.abs(V.dot(wo, h)));
}

function ggxSample(mat, wo, n, r1, r2) {
  const alpha = ggxAlpha(mat);
  const a2 = alpha * alpha;
  const phi = 2 * Math.PI * r1;
  const cosTheta = Math.sqrt((1 - r2) / (1 + (a2 - 1) * r2));
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const hLocal = [sinTheta * Math.cos(phi), cosTheta, sinTheta * Math.sin(phi)];
  const [t, b, nn] = [
    V.norm(V.cross(Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], n)),
    null,
    n,
  ];
  const bv = V.cross(n, t);
  const h = V.norm([
    t[0] * hLocal[0] + n[0] * hLocal[1] + bv[0] * hLocal[2],
    t[1] * hLocal[0] + n[1] * hLocal[1] + bv[1] * hLocal[2],
    t[2] * hLocal[0] + n[2] * hLocal[1] + bv[2] * hLocal[2],
  ]);
  const wi = reflectDirection(V.mul(wo, -1), h);
  return { wi: V.norm(wi), pdfW: ggxPdf(mat, wo, wi, n) };
}

function fresnelSchlick(cosTheta, f0) {
  const m = Math.pow(1 - V.clamp01(cosTheta), 5);
  return [f0[0] + (1 - f0[0]) * m, f0[1] + (1 - f0[1]) * m, f0[2] + (1 - f0[2]) * m];
}

function specularTerm(mat, wo, wi, n) {
  if (V.dot(n, wo) <= 1e-5 || V.dot(n, wi) <= 1e-5) return [0, 0, 0];
  const h = V.norm(V.add(wo, wi));
  const alpha = ggxAlpha(mat);
  const a2 = alpha * alpha;
  const nh = Math.max(0, V.dot(n, h));
  const nw = Math.max(1e-5, V.dot(n, wo));
  const ni = Math.max(1e-5, V.dot(n, wi));
  const d = a2 / (Math.PI * Math.pow(nh * nh * (a2 - 1) + 1, 2));
  const k = Math.pow((mat.roughness ?? 0.5) + 1, 2) / 8;
  const g1 = (x) => x / (x * (1 - k) + k);
  const g = g1(nw) * g1(ni);
  const f0 = mat.f0 || [0.04 + mat.color[0] * 0.25, 0.04 + mat.color[1] * 0.25, 0.04 + mat.color[2] * 0.25];
  const f = fresnelSchlick(Math.max(0, V.dot(wo, h)), f0);
  const denom = 4 * nw * ni;
  return [
    (d * g * f[0]) / denom,
    (d * g * f[1]) / denom,
    (d * g * f[2]) / denom,
  ];
}

export function bsdfFlags(mat) {
  if (!mat) return 0;
  if (mat.type === 'diffuse') return EVENTS.DIFFUSE | EVENTS.REFLECTION;
  if (mat.type === 'rough') return EVENTS.DIFFUSE | EVENTS.GLOSSY | EVENTS.REFLECTION;
  if (mat.type === 'mirror') return EVENTS.SPECULAR | EVENTS.REFLECTION;
  if (mat.type === 'light') return EVENTS.EMISSIVE;
  return 0;
}

export function bsdfEval(mat, wo, wi, n) {
  if (!mat || isDeltaMaterial(mat)) return [0, 0, 0];
  const sameSide = V.dot(n, wo) > 1e-5 && V.dot(n, wi) > 1e-5;
  if (!sameSide) return [0, 0, 0];
  if (mat.type === 'diffuse') {
    return V.mul(mat.color, 1 / Math.PI);
  }
  if (mat.type === 'rough') {
    const mixP = V.clamp(mat.diffuseMix ?? 0.62, 0.05, 0.95);
    const diffuse = V.mul(mat.color, mixP / Math.PI);
    const spec = V.mul(specularTerm(mat, wo, wi, n), 1 - mixP);
    return V.add(diffuse, spec);
  }
  return [0, 0, 0];
}

export function bsdfPdf(mat, wo, wi, n) {
  if (!mat || isDeltaMaterial(mat)) return 0;
  if (V.dot(n, wo) <= 1e-5 || V.dot(n, wi) <= 1e-5) return 0;
  const cos = V.dot(n, wi);
  const diffusePdf = cos / Math.PI;
  if (mat.type === 'diffuse') return diffusePdf;
  if (mat.type === 'rough') {
    const mixP = V.clamp(mat.diffuseMix ?? 0.62, 0.05, 0.95);
    return mixP * diffusePdf + (1 - mixP) * ggxPdf(mat, wo, wi, n);
  }
  return 0;
}

export function sampleBsdf(mat, wo, n, r1, r2, componentPick) {
  if (mat.type === 'mirror') {
    return {
      wi: V.norm(reflectDirection(V.mul(wo, -1), n)),
      pdfW: 1,
      delta: true,
      component: 'specular-reflection',
    };
  }
  if (mat.type === 'diffuse') {
    const wi = cosineHemisphereSample(n, r1, r2);
    return { wi, pdfW: bsdfPdf(mat, wo, wi, n), delta: false, component: 'diffuse' };
  }
  const mixP = V.clamp(mat.diffuseMix ?? 0.62, 0.05, 0.95);
  let wi;
  let component;
  if (componentPick < mixP) {
    wi = cosineHemisphereSample(n, r1, r2);
    component = 'rough-diffuse';
  } else {
    const s = ggxSample(mat, wo, n, r1, r2);
    wi = s.wi;
    component = 'ggx-rough-reflection';
  }
  return { wi: V.norm(wi), pdfW: bsdfPdf(mat, wo, wi, n), delta: false, component };
}

export function rrSurvival(mat, depth, options = {}) {
  const start = options.rrStart ?? 2;
  if (depth < start) return 1;
  if (!mat || mat.type === 'light') return 0.75;
  const c = mat.color || [0.5, 0.5, 0.5];
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return V.clamp(lum * 1.25, options.rrMin ?? 0.12, options.rrMax ?? 0.92);
}
