import { createScene } from '../src/core/scenes.js';
import { orbitCameraParams } from '../src/core/camera.js';
import { BdptRenderer } from '../src/core/renderer.js';

const id = process.argv[2] || 'occlusion';
const px = Number(process.argv[3] || 24);
const py = Number(process.argv[4] || 16);
const scene = createScene(id);
const cp = orbitCameraParams(scene.camera.yaw, scene.camera.pitch, scene.camera.distance, scene.camera.target);
cp.fov = scene.camera.fov;
const r = new BdptRenderer(scene, cp, 48, 32, { seedBase: 7 });
const out = r.renderPixelSample(px, py, 0);
for (const a of out.attempts.filter((a) => a.key === '2,1' || a.key === '1,2').slice(0, 4)) {
  console.log(a.key, a.status, 'un', a.unweighted.map((x) => x.toFixed(3)), 'w', a.misWeight.toFixed(4), 'wt', a.weighted.map((x) => x.toFixed(3)));
  if (a.mis) {
    console.log(a.mis.candidates.map((c) => `${c.s},${c.t} p=${c.feasible ? c.value.toExponential(2) : '0'} w=${c.weight.toFixed(3)}`).join(' | '));
  }
}
