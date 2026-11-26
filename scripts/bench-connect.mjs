// 双向路径连接基准：在相同场景、相同 SPP、相同种子下对照三种连接模式。
//   baseline  旧双向路径，全量可见性光线（运行参照，不许伪报）
//   prune     几何/事件探针 + 界面硬剪枝，图像与基线逐像素一致
//   optimized 剪枝 + 可见性预算 + 分层逆概率加权
// 输出：耗时、可见性光线/候选、剪枝率、阻断率、均值与像素统计误差（RMSE）。
// 用法：node scripts/bench-connect.mjs [scene] [spp] [budget]
import { createScene } from '../src/core/scenes.js';
import { orbitCameraParams } from '../src/core/camera.js';
import { BdptRenderer } from '../src/core/renderer.js';

const sceneId = process.argv[2] || 'slit';
const spp = Number(process.argv[3] || 16);
const budget = Number(process.argv[4] || 12);
const width = 72;
const height = 45;

const scene = createScene(sceneId);
const c = scene.camera;
const cp = orbitCameraParams(c.yaw, c.pitch, c.distance, c.target);
cp.fov = c.fov;

function makeRenderer(mode) {
  return new BdptRenderer(scene, cp, width, height, {
    seedBase: 20261126,
    maxCameraVertices: 6,
    maxLightVertices: 6,
    connectionMode: mode,
    connectionBudget: mode === 'optimized' ? budget : Infinity,
  });
}

function perPixelLuminance(renderer) {
  const n = Math.max(1, renderer.samples);
  const out = new Float64Array(width * height);
  for (let i = 0, p = 0; i < renderer.beauty.length; i += 3, p++) {
    out[p] =
      (0.2126 * renderer.beauty[i] + 0.7152 * renderer.beauty[i + 1] + 0.0722 * renderer.beauty[i + 2]) / n;
  }
  return out;
}

function rmseAgainst(reference, candidate) {
  let sumSq = 0;
  for (let i = 0; i < reference.length; i++) sumSq += (reference[i] - candidate[i]) ** 2;
  return Math.sqrt(sumSq / reference.length);
}

console.log(`# scene=${sceneId} ${width}x${height} spp=${spp} optimizedBudget=${budget}`);
const runs = {};
for (const mode of ['baseline', 'prune', 'optimized']) {
  const renderer = makeRenderer(mode);
  const t0 = process.hrtime.bigint();
  renderer.renderSynchronously(spp);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const cost = renderer.costBreakdown();
  runs[mode] = { renderer, elapsedMs, cost, image: perPixelLuminance(renderer) };
}

const refMean = runs.baseline.renderer.meanLuminance();
for (const mode of ['baseline', 'prune', 'optimized']) {
  const r = runs[mode];
  const rmse = rmseAgainst(runs.baseline.image, r.image);
  const mean = r.renderer.meanLuminance();
  const pp = r.cost.perPixel;
  console.log(
    [
      mode.padEnd(10),
      `ms=${r.elapsedMs.toFixed(1)}`,
      `mean=${mean.toFixed(6)}`,
      `meanRatio=${(mean / Math.max(1e-12, refMean)).toFixed(4)}`,
      `rmseVsBase=${rmse.toExponential(3)}`,
      `relRmse=${(rmse / Math.max(1e-12, refMean)).toFixed(4)}`,
      `rays/px=${pp.visibilityRays.toFixed(2)}`,
      `cand/px=${pp.candidates.toFixed(2)}`,
      `hardPruned/px=${(pp.interfacePruned || 0).toFixed(2)}`,
      `softRejected/px=${(pp.eventPruned + pp.geometryPruned + pp.cameraRejected).toFixed(2)}`,
      `deferred/px=${pp.budgetDeferred.toFixed(2)}`,
      `blockedRate=${r.cost.blockedRayRate.toFixed(3)}`,
      `traceFrac=${r.cost.traceFraction.toFixed(3)}`,
    ].join('  '),
  );
}

// 撤回护栏：prune 必须与基线数值一致；若优化引入了连接成本/统计误差之外的行为
// 退化（图像均值或 RMSE 异常），以非零码退出，供 CI 撤回该优化。
const pruneRatio = runs.prune.renderer.meanLuminance() / Math.max(1e-12, refMean);
const pruneRmse = rmseAgainst(runs.baseline.image, runs.prune.image);
const guardFailures = [];
if (Math.abs(pruneRatio - 1) > 1e-9) guardFailures.push(`prune mean ratio ${pruneRatio} != 1`);
if (pruneRmse > 1e-12) guardFailures.push(`prune RMSE ${pruneRmse} above exact-match tolerance`);
if (runs.prune.cost.perPixel.visibilityRays > runs.baseline.cost.perPixel.visibilityRays) {
  guardFailures.push('prune traced more visibility rays than baseline');
}
if (guardFailures.length) {
  console.error('GUARD FAIL (撤回连接候选优化):', guardFailures.join('; '));
  process.exit(1);
}
console.log('GUARD PASS: prune 与基线精确一致且可见性工作量不增加');
