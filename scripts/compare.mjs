import { createScene } from '../src/core/scenes.js';
import { orbitCameraParams } from '../src/core/camera.js';
import { BdptRenderer } from '../src/core/renderer.js';
import { PtReferenceRenderer } from '../src/core/pathtracer.js';

const id = process.argv[2] || 'corner';
const width = Number(process.env.W || 72);
const height = Number(process.env.H || 44);
const refSpp = Number(process.env.REF || 128);
const scene = createScene(id);
const cp = orbitCameraParams(scene.camera.yaw, scene.camera.pitch, scene.camera.distance, scene.camera.target);
cp.fov = scene.camera.fov;

function imageMean(renderer) {
  return renderer.meanLuminance();
}

const bdpt = new BdptRenderer(scene, cp, width, height, { seedBase: 2026 });
console.log(`# ${id} ${width}x${height}`);
for (const spp of [1, 1, 2, 4, 8, 16]) {
  bdpt.renderSynchronously(spp);
  console.log(`BDPT spp=${bdpt.samples} meanLum=${imageMean(bdpt).toFixed(6)}`);
}

const pt = new PtReferenceRenderer(scene, cp, width, height, { seedBase: 909 });
const t0 = Date.now();
const bucket = 16;
while (pt.samples < refSpp) {
  pt.renderSynchronously(Math.min(bucket, refSpp - pt.samples));
  console.log(`PT spp=${pt.samples} meanLum=${pt.meanLuminance().toFixed(6)} elapsed=${Date.now() - t0}ms`);
}

function rmse(a, b, na, nb) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const x = a[i + k] / na;
      const y = b[i + k] / nb;
      s += (x - y) ** 2;
      n++;
    }
  }
  return Math.sqrt(s / n);
}
console.log(`RMSE BDPT16 vs PT${refSpp}=${rmse(bdpt.beauty, pt.accum, bdpt.samples, pt.samples).toFixed(6)}`);
console.log(`mean ratio BDPT/PT=${(bdpt.meanLuminance() / pt.meanLuminance()).toFixed(3)}`);
