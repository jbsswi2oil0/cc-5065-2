import { Rng, hashSeed } from '../src/core/rng.js';
import { createScene } from '../src/core/scenes.js';
import { orbitCameraParams, Camera } from '../src/core/camera.js';
import { traceUnidirectionalSample } from '../src/core/pathtracer.js';

const id = process.argv[2] || 'occlusion';
const W = 48;
const H = 30;
const scene = createScene(id);
const cp = orbitCameraParams(scene.camera.yaw, scene.camera.pitch, scene.camera.distance, scene.camera.target);
cp.fov = scene.camera.fov;
const camera = new Camera({ width: W, height: H, ...cp });
const sums = { radiance: [0, 0, 0], directNee: [0, 0, 0], emissionHit: [0, 0, 0], indirect: [0, 0, 0] };
const N = 4;
for (let s = 0; s < N; s++) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r = traceUnidirectionalSample(scene, camera, x, y, new Rng(hashSeed(55, s, y, x)), { maxCameraVertices: 6, rrStart: 2 });
    for (const k of Object.keys(sums)) {
      const v = k === 'radiance' ? r.radiance : r.parts[k];
      sums[k] = sums[k].map((a, i) => a + v[i]);
    }
  }
}
for (const [k, v] of Object.entries(sums)) {
  const mean = v.map((x) => x / (W * H * N));
  const lum = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
  console.log(k, mean.map((x) => x.toFixed(4)), 'lum', lum.toFixed(4));
}
