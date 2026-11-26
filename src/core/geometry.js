import { V } from './vec3.js';

export class Quad {
  constructor(id, p00, e1, e2, materialId) {
    this.kind = 'quad';
    this.id = id;
    this.p00 = p00;
    this.e1 = e1;
    this.e2 = e2;
    this.materialId = materialId;
    this.e11 = V.add(p00, e1);
    this.e21 = V.add(p00, e2);
    this.p11 = V.add(this.e11, e2);
    const un = V.cross(e1, e2);
    this.normal = V.norm(un);
    this.area = V.length(un);
  }

  point(u, v) {
    return V.add(this.p00, V.add(V.mul(this.e1, u), V.mul(this.e2, v)));
  }

  sampleArea(r1, r2) {
    return { p: this.point(r1, r2), n: this.normal, pdfA: 1 / this.area };
  }

  intersect(ray) {
    const un = V.cross(this.e1, this.e2);
    const den = V.dot(ray.d, un);
    if (Math.abs(den) < 1e-10) return null;
    const op = V.sub(this.p00, ray.o);
    const t = V.dot(op, un) / den;
    if (t < ray.tMin || t > ray.tMax) return null;
    const h = V.sub(V.add(ray.o, V.mul(ray.d, t)), this.p00);
    const uu = V.dot(V.cross(h, this.e2), un) / V.dot(un, un);
    const vv = V.dot(V.cross(this.e1, h), un) / V.dot(un, un);
    if (uu < 0 || uu > 1 || vv < 0 || vv > 1) return null;
    let n = this.normal;
    if (V.dot(n, ray.d) > 0) n = V.mul(n, -1);
    return { t, p: V.add(ray.o, V.mul(ray.d, t)), n, gn: this.normal, prim: this, uv: [uu, vv] };
  }
}

export class Sphere {
  constructor(id, c, r, materialId) {
    this.kind = 'sphere';
    this.id = id;
    this.c = c;
    this.r = r;
    this.materialId = materialId;
    this.area = 4 * Math.PI * r * r;
  }

  sampleArea(r1, r2) {
    const z = 1 - 2 * r1;
    const a = 2 * Math.PI * r2;
    const rr = Math.sqrt(Math.max(0, 1 - z * z));
    const n = [rr * Math.cos(a), z, rr * Math.sin(a)];
    return { p: V.add(this.c, V.mul(n, this.r)), n, pdfA: 1 / this.area };
  }

  intersect(ray) {
    const oc = V.sub(ray.o, this.c);
    const b = V.dot(oc, ray.d);
    const c = V.dot(oc, oc) - this.r * this.r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    let t = -b - sq;
    if (t < ray.tMin || t > ray.tMax) t = -b + sq;
    if (t < ray.tMin || t > ray.tMax) return null;
    const p = V.add(ray.o, V.mul(ray.d, t));
    const gn = V.norm(V.sub(p, this.c));
    let n = gn;
    if (V.dot(n, ray.d) > 0) n = V.mul(n, -1);
    return { t, p, n, gn, prim: this, uv: null };
  }
}

export function makeRay(o, d, tMax = 1e30) {
  return { o, d: V.norm(d), tMin: 1e-5, tMax };
}

export function intersectScene(scene, ray) {
  let best = null;
  for (const prim of scene.prims) {
    const hit = prim.intersect(ray);
    if (hit && (!best || hit.t < best.t)) best = hit;
  }
  if (best) best.material = scene.materials[best.prim.materialId];
  return best;
}

export function visible(scene, a, b, eps = 2e-4) {
  const d = V.sub(b, a);
  const dist = V.length(d);
  if (dist < eps * 10) return true;
  const ray = makeRay(a, V.div(d, dist), dist - eps);
  ray.tMin = eps;
  const hit = intersectScene(scene, ray);
  return !hit;
}

export function geometryTerm(a, b) {
  const d = V.sub(b.p, a.p);
  const r2 = V.dot(d, d);
  if (r2 < 1e-12) return 0;
  const dir = V.div(d, Math.sqrt(r2));
  let ca = 1;
  let cb = 1;
  if (a.kind !== 'camera') ca = Math.abs(V.dot(a.n, dir));
  if (b.kind !== 'camera') cb = Math.abs(V.dot(b.n, V.mul(dir, -1)));
  return (ca * cb) / r2;
}
