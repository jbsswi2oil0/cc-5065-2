import { Rng } from '../src/core/rng.js';
import { createScene } from '../src/core/scenes.js';
import { orbitCameraParams, Camera } from '../src/core/camera.js';
import { generateCameraPath, generateLightPath } from '../src/core/pathgen.js';
import { evaluateStrategy } from '../src/core/bdpt.js';
import { traceUnidirectionalSample } from '../src/core/pathtracer.js';

const id = process.argv[2] || 'corner';
const px = Number(process.argv[3] || 24);
const py = Number(process.argv[4] || 15);
const N = Number(process.argv[5] || 4000);
const scene = createScene(id);
const cp = orbitCameraParams(scene.camera.yaw, scene.camera.pitch, scene.camera.distance, scene.camera.target);
cp.fov = scene.camera.fov;
const camera = new Camera({ width: 48, height: 30, ...cp });
const opts = { maxCameraVertices: 6, maxLightVertices: 6, rrStart: 2 };

let bdpt21 = [0, 0, 0];
let bdpt21Raw = [0, 0, 0];
let bdptAll = [0, 0, 0];
let accepted21 = 0;
let pt = [0, 0, 0];
let ptNoMis = [0, 0, 0];
for (let i = 1; i <= N; i++) {
  let rng = new Rng(1000 + i);
  const cam = generateCameraPath(scene, camera, px, py, rng, opts);
  const light = generateLightPath(scene, new Rng(2000 + i), opts);
  const a = evaluateStrategy(scene, camera, cam, light, 2, 1, opts);
  bdpt21 = bdpt21.map((x, k) => x + a.weighted[k]);
  bdpt21Raw = bdpt21Raw.map((x, k) => x + a.unweighted[k]);
  if (a.accepted) accepted21++;
  for (const st of [[1, 1], [2, 2], [2, 3], [3, 1], [4, 1]]) {
    const z = evaluateStrategy(scene, camera, cam, light, st[0], st[1], opts);
    bdptAll = bdptAll.map((x, k) => x + z.weighted[k]);
  }
  const p1 = traceUnidirectionalSample(scene, camera, px, py, new Rng(3000 + i), opts);
  pt = pt.map((x, k) => x + p1.radiance[k]);
  const p2 = traceUnidirectionalSample(scene, camera, px, py, new Rng(3000 + i), { ...opts, mis: false });
  ptNoMis = ptNoMis.map((x, k) => x + p2.radiance[k]);
}
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
console.log({ id, px, py, N, accepted21: accepted21 / N });
console.log('bdpt21 weighted mean', bdpt21.map((x) => x / N), lum(bdpt21.map((x) => x / N)));
console.log('bdpt21 raw mean', bdpt21Raw.map((x) => x / N), lum(bdpt21Raw.map((x) => x / N)));
console.log('bdpt selected all mean', bdptAll.map((x) => x / N), lum(bdptAll.map((x) => x / N)));
console.log('pt mis mean', pt.map((x) => x / N), lum(pt.map((x) => x / N)));
console.log('pt no-mis mean', ptNoMis.map((x) => x / N), lum(ptNoMis.map((x) => x / N)));
