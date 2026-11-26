import { Rng } from '../src/core/rng.js';
import { createScene } from '../src/core/scenes.js';
import { orbitCameraParams, Camera } from '../src/core/camera.js';
import { generateCameraPath, generateLightPath } from '../src/core/pathgen.js';
import { evaluateStrategy } from '../src/core/bdpt.js';

const scene = createScene('occlusion');
const cp = orbitCameraParams(scene.camera.yaw, scene.camera.pitch, scene.camera.distance, scene.camera.target);
cp.fov = scene.camera.fov;
const camera = new Camera({ width: 48, height: 30, ...cp });
const opts = { maxCameraVertices: 6, maxLightVertices: 6, rrStart: 2 };
outer: for (let seed = 1; seed < 500; seed++) {
  for (let y = 0; y < 30; y++) for (let x = 0; x < 48; x++) {
    const rng = new Rng(seed * 100000 + y * 48 + x);
    const cam = generateCameraPath(scene, camera, x, y, rng, opts);
    if (cam.vertices.at(-1)?.mat?.type !== 'light') continue;
    const light = generateLightPath(scene, new Rng(999 + seed), opts);
    const s = cam.vertices.length;
    const a = evaluateStrategy(scene, camera, cam, light, s, 0, opts);
    if (!a.accepted) continue;
    console.log('found', { seed, x, y, s, status: a.status, un: a.unweighted, w: a.misWeight, wt: a.weighted });
    console.log(a.mis.candidates.map((c) => `${c.s},${c.t} val=${c.value?.toExponential?.(3)} feas=${c.feasible} reason=${c.reason} w=${c.weight}`).join('\n'));
    break outer;
  }
}
