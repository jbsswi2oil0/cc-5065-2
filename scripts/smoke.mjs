import { createScene } from '../src/core/scenes.js';
import { orbitCameraParams } from '../src/core/camera.js';
import { BdptRenderer } from '../src/core/renderer.js';
import { PtReferenceRenderer } from '../src/core/pathtracer.js';

const ids = process.argv.slice(2);
const scenes = ids.length ? ids : ['corner', 'slit', 'occlusion'];
for (const id of scenes) {
  const scene = createScene(id);
  const cp = orbitCameraParams(scene.camera.yaw, scene.camera.pitch, scene.camera.distance, scene.camera.target);
  cp.fov = scene.camera.fov;
  const r = new BdptRenderer(scene, cp, 64, 40, { seedBase: 7 });
  const t0 = Date.now();
  r.renderSynchronously(1);
  const dt = Date.now() - t0;
  let mx = 0;
  let nan = 0;
  let sum = 0;
  for (let i = 0; i < r.beauty.length; i += 3) {
    if (![r.beauty[i], r.beauty[i + 1], r.beauty[i + 2]].every(Number.isFinite)) nan++;
    const l = 0.2126 * r.beauty[i] + 0.7152 * r.beauty[i + 1] + 0.0722 * r.beauty[i + 2];
    sum += l;
    mx = Math.max(mx, l);
  }
  console.log(id, { dt, mean: sum / (64 * 40), mx, nan });
  console.log(' top', r.strategySummary().sort((a, b) => b.meanLum - a.meanLum).slice(0, 6).map((x) => `${x.key}:${x.meanLum.toFixed(3)}`).join(' '));
}
