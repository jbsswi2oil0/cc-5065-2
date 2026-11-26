import { V } from './vec3.js';

export class Camera {
  constructor({ width, height, eye, target, fov = 48, up = [0, 1, 0] }) {
    this.width = width;
    this.height = height;
    this.eye = eye;
    this.target = target;
    this.fov = fov;
    this.forward = V.norm(V.sub(target, eye));
    this.right = V.norm(V.cross(this.forward, up));
    this.up = V.cross(this.right, this.forward);
    this.scale = Math.tan((fov * Math.PI) / 360);
    this.pixelSize = (2 * this.scale) / height;
    this.pixelAreaW = this.pixelSize * this.pixelSize;
  }

  clone(overrides = {}) {
    return new Camera({
      width: this.width,
      height: this.height,
      eye: overrides.eye || this.eye,
      target: overrides.target || this.target,
      fov: overrides.fov || this.fov,
    });
  }

  localSlope(x, y) {
    return {
      sx: ((x - this.width / 2) * 2 * this.scale) / this.height,
      sy: ((this.height / 2 - y) * 2 * this.scale) / this.height,
    };
  }

  rayForPixel(px, py, rng) {
    const x = px + (rng ? rng.next() : 0.5);
    const y = py + (rng ? rng.next() : 0.5);
    const { sx, sy } = this.localSlope(x, y);
    const unnorm = V.add(this.forward, V.add(V.mul(this.right, sx), V.mul(this.up, sy)));
    const d = V.norm(unnorm);
    const rPlane2 = 1 + sx * sx + sy * sy;
    const pdfW = Math.pow(rPlane2, 1.5) / this.pixelAreaW;
    return { o: this.eye, d, pdfW, pixel: [px, py], sampleXY: [x, y] };
  }

  directionToPixelSlope(d) {
    const dz = V.dot(d, this.forward);
    if (dz <= 1e-6) return null;
    const dx = V.dot(d, this.right);
    const dy = V.dot(d, this.up);
    return { sx: dx / dz, sy: dy / dz, dz };
  }

  projectDirection(d) {
    const s = this.directionToPixelSlope(d);
    if (!s) return null;
    const x = this.width / 2 + (s.sx * this.height) / (2 * this.scale);
    const y = this.height / 2 - (s.sy * this.height) / (2 * this.scale);
    return { x, y, dz: s.dz };
  }

  rayPdfWForDirection(d) {
    const s = this.directionToPixelSlope(d);
    if (!s) return 0;
    return 1 / (Math.pow(s.dz, 3) * this.pixelAreaW);
  }

  weForPixel(px, py, d) {
    const p = this.projectDirection(d);
    if (!p) return { we: [0, 0, 0], pdfW: 0, projection: null, inside: false };
    const inside = p.x >= px && p.x < px + 1 && p.y >= py && p.y < py + 1;
    const pdfW = this.rayPdfWForDirection(d);
    return {
      we: inside ? [pdfW, pdfW, pdfW] : [0, 0, 0],
      pdfW: inside ? pdfW : 0,
      projection: p,
      inside,
    };
  }

  projectPoint(p) {
    const d = V.norm(V.sub(p, this.eye));
    const pr = this.projectDirection(d);
    if (!pr) return null;
    return { x: pr.x, y: pr.y, depth: V.dist(this.eye, p), visibleSide: pr.dz > 0 };
  }
}

export function orbitCameraParams(yaw, pitch, distance, target) {
  const cp = Math.cos(pitch);
  return {
    target,
    eye: [
      target[0] + distance * Math.sin(yaw) * cp,
      target[1] + distance * Math.sin(pitch),
      target[2] + distance * Math.cos(yaw) * cp,
    ],
  };
}
