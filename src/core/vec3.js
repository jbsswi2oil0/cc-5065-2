export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  mulV: (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]],
  div: (a, s) => [a[0] / s, a[1] / s, a[2] / s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  length: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
  },
  lerp: (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  clamp01: (x) => Math.min(1, Math.max(0, x)),
};

export function absDot(n, d) {
  return Math.abs(V.dot(n, d));
}

export function faceNormal(n, d) {
  return V.dot(n, d) < 0 ? n : V.mul(n, -1);
}

export function orthonormalBasis(n) {
  const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t = V.norm(V.cross(a, n));
  const b = V.cross(n, t);
  return [t, b, n];
}

export function cosineHemisphereSample(n, r1, r2) {
  const [t, b, nn] = orthonormalBasis(n);
  const r = Math.sqrt(r1);
  const phi = 2 * Math.PI * r2;
  const x = r * Math.cos(phi);
  const y = r * Math.sin(phi);
  const z = Math.sqrt(Math.max(0, 1 - r1));
  return V.norm([
    t[0] * x + b[0] * y + nn[0] * z,
    t[1] * x + b[1] * y + nn[1] * z,
    t[2] * x + b[2] * y + nn[2] * z,
  ]);
}

export function reflectDirection(wi, n) {
  return V.sub(wi, V.mul(n, 2 * V.dot(wi, n)));
}

export function safeUnit(a, b) {
  return V.norm(V.sub(b, a));
}
