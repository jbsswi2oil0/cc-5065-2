// 同预算均值/方差对照：对同一组独立种子分别运行 baseline / prune / optimized，
// 比较每像素样本平均亮度的期望与样本方差。prune 必须与 baseline 完全一致；
// optimized 在更少可见性光线下均值应在蒙特卡洛容差内，且方差不得显著恶化。
import { createScene } from '../src/core/scenes.js';
import { orbitCameraParams, Camera } from '../src/core/camera.js';
import { Rng, hashSeed } from '../src/core/rng.js';
import { generateCameraPath, generateLightPath } from '../src/core/pathgen.js';
import { evaluateAllStrategies } from '../src/core/bdpt.js';
import { evaluateAllStrategiesPlanned } from '../src/core/connect.js';

const id = process.argv[2] || 'interface';
const trials = Number(process.argv[3] || 40);
const scene = createScene(id);
const c = scene.camera;
const cp = orbitCameraParams(c.yaw, c.pitch, c.distance, c.target);
cp.fov = c.fov;
const camera = new Camera({ width: 12, height: 10, ...cp });
const options = { maxCameraVertices: 6, maxLightVertices: 6, rrStart: 2 };

function lum(v) {
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

function runTrial(mode, seed, budget) {
  const rng = new Rng(seed);
  const cam = generateCameraPath(scene, camera, 6, 5, rng, options);
  const light = generateLightPath(scene, rng, options);
  let attempts;
  if (mode === 'baseline') {
    attempts = evaluateAllStrategies(scene, camera, cam, light, options);
  } else {
    const planned = evaluateAllStrategiesPlanned(scene, camera, cam, light, {
      ...options,
      connectionMode: mode,
      connectionBudget: budget,
      connectionRng: new Rng(hashSeed(seed, 'budget')),
    });
    attempts = planned.attempts;
  }
  let total = 0;
  let accepted = 0;
  for (const a of attempts) {
    total += lum(a.weighted);
    if (a.accepted) accepted++;
  }
  return { total, accepted };
}

function stats(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, variance, relStd: Math.sqrt(variance) / Math.max(1e-12, Math.abs(mean)) };
}

const budget = Number(process.env.BUDGET || 10);
const modes = ['baseline', 'prune', 'optimized'];
const results = Object.fromEntries(modes.map((m) => [m, { totals: [], accepted: [] }]));
for (let i = 0; i < trials; i++) {
  const seed = 4242 + i * 101;
  for (const m of modes) {
    const r = runTrial(m, seed, budget);
    results[m].totals.push(r.total);
    results[m].accepted.push(r.accepted);
  }
}

const baseStats = stats(results.baseline.totals);
console.log(`# ${id}  trials=${trials}  optimized visibility budget=${budget}`);
for (const m of modes) {
  const s = stats(results[m].totals);
  const acc = stats(results[m].accepted);
  const ratio = s.mean / baseStats.mean;
  console.log(
    `${m.padEnd(10)} mean=${s.mean.toFixed(6)} var=${s.variance.toExponential(3)} relStd=${(s.relStd * 100).toFixed(1)}% acceptedMean=${acc.mean.toFixed(2)} meanRatioVsBase=${ratio.toFixed(4)}`,
  );
}
