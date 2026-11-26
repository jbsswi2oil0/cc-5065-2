import { createScene } from '../src/core/scenes.js';
import { orbitCameraParams } from '../src/core/camera.js';
import { BdptRenderer } from '../src/core/renderer.js';

const id = process.argv[2] || 'occlusion';
const scene = createScene(id);
const cp = orbitCameraParams(scene.camera.yaw, scene.camera.pitch, scene.camera.distance, scene.camera.target);
cp.fov = scene.camera.fov;
const r = new BdptRenderer(scene, cp, 48, 30, { seedBase: 7 });
r.renderSynchronously(4);
for (const s of r.strategySummary()) {
  console.log(`${s.key}\t${s.meanLum.toFixed(6)}\taccepted=${s.accepted}`);
}
console.log('mean', r.meanLuminance());
