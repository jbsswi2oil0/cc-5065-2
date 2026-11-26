import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, swapInterfaceMedia } from '../src/core/scenes.js';
import { orbitCameraParams, Camera } from '../src/core/camera.js';
import { Rng } from '../src/core/rng.js';
import { generateCameraPath, generateLightPath } from '../src/core/pathgen.js';
import { evaluateAllStrategies } from '../src/core/bdpt.js';
import {
  planConnections,
  geometricUpperBound,
  interfaceCrossing,
  mediumSideAt,
  endpointReport,
} from '../src/core/connect.js';

function cameraFor(id, width = 16, height = 12) {
  const scene = createScene(id);
  const c = scene.camera;
  const params = orbitCameraParams(c.yaw, c.pitch, c.distance, c.target);
  params.fov = c.fov;
  return { scene, camera: new Camera({ width, height, ...params }), params };
}

const opts = { maxCameraVertices: 6, maxLightVertices: 6, rrStart: 2 };

function pairOutputs(scene, camera, cam, light, mode, budget = Infinity) {
  if (mode === 'baseline') {
    return {
      attempts: evaluateAllStrategies(scene, camera, cam, light, opts),
      cost: null,
    };
  }
  return planConnections(scene, camera, cam, light, cam.pixel, {
    ...opts,
    connectionMode: mode,
    connectionBudget: budget,
    connectionRng: new Rng(9917),
  });
}

function weightedLum(attempts) {
  let s = 0;
  for (const a of attempts) s += 0.2126 * a.weighted[0] + 0.7152 * a.weighted[1] + 0.0722 * a.weighted[2];
  return s;
}

test('几何上界剪枝只否决界面开口外的穿越，开口内连接保留', () => {
  const { scene } = cameraFor('interface');
  // 开口中心附近、两端分居界面两侧的连接段必须可通行。
  const front = [0.05, 1.7, 2.0];
  const back = [-0.05, 1.8, -2.0];
  const cross = interfaceCrossing(scene, front, back);
  assert.equal(cross.crosses, true);
  assert.equal(cross.passable, true);
  // 明显落在开口侧面之外的穿越：取两端 x 同号，穿越点保持在远离开口的位置。
  const missFront = [2.0, 1.7, 2.0];
  const missBack = [2.2, 1.8, -2.0];
  const miss = interfaceCrossing(scene, missFront, missBack);
  assert.equal(miss.crosses, true);
  assert.equal(miss.passable, false);
  // 同侧不穿越。
  assert.equal(interfaceCrossing(scene, front, [1, 1, 2.5]).crosses, false);
});

test('贴墙/贴地端点的相切连接不被界面剪枝误杀', () => {
  const { scene } = cameraFor('interface');
  // 端点落在界面平面上（浮点误差量级），线段与界面相切。
  const onWall = [1.15, 0.2, 0.15000000000000002];
  const other = [0.6, 0.0, 3.69];
  assert.equal(interfaceCrossing(scene, onWall, other).crosses, false);
  const bound = geometricUpperBound(
    { p: onWall, n: [0, 1, 0], kind: 'surface' },
    { p: other, n: [0, 1, 0], kind: 'surface' },
    scene,
  );
  assert.notEqual(bound.reason, 'interface-opening-miss');
});

test('端点报告携带介质侧与镜面可通行标记', () => {
  const { scene, camera } = cameraFor('interface');
  const rng = new Rng(7);
  const cam = generateCameraPath(scene, camera, 4, 4, rng, opts);
  const light = generateLightPath(scene, rng, opts);
  for (const v of [...cam.vertices, ...light.vertices]) {
    const rep = endpointReport(v, scene);
    assert.equal(typeof rep.mediumSide, 'number');
    assert.equal(rep.connectible, !rep.delta);
    if (rep.delta) assert.equal(rep.materialType, 'mirror');
  }
  // 介质侧标签在界面两侧确实不同。
  assert.notEqual(mediumSideAt(scene, [0, 1.5, 2.0]), mediumSideAt(scene, [0, 1.5, -2.0]));
});

test('prune 模式与基线逐样本加权贡献完全一致，且硬剪枝对应基线零贡献', () => {
  for (const id of ['corner', 'slit', 'occlusion', 'interface']) {
    const { scene, camera } = cameraFor(id);
    let checked = 0;
    let hardPruned = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (let py = 0; py < 6; py++) {
        for (let px = 0; px < 8; px++) {
          const rng = new Rng(seed * 7 + px);
          const cam = generateCameraPath(scene, camera, px, py, rng, opts);
          const light = generateLightPath(scene, rng, opts);
          const base = pairOutputs(scene, camera, cam, light, 'baseline').attempts;
          const planned = pairOutputs(scene, camera, cam, light, 'prune');
          const map = new Map(base.map((a) => [a.key, a]));
          for (const z of planned.attempts) {
            const y = map.get(z.key);
            checked++;
            for (let k = 0; k < 3; k++) assert.ok(Math.abs(y.weighted[k] - z.weighted[k]) < 1e-14);
            assert.equal(y.accepted, z.accepted);
            if (z.status === 'interface-opening-miss') {
              hardPruned++;
              assert.equal(y.accepted, false);
              for (let k = 0; k < 3; k++) assert.ok(Math.abs(y.weighted[k]) < 1e-14);
            }
          }
        }
      }
    }
    assert.ok(checked > 1000, `${id}: 样本不足 ${checked}`);
    if (id === 'slit' || id === 'interface') assert.ok(hardPruned > 100, `${id}: 界面剪枝未生效`);
    else assert.equal(hardPruned, 0);
  }
});

test('大量不可连接端点加一个稀有有效端点：剪枝节省工作但不吞掉最后的贡献', () => {
  const { scene, camera } = cameraFor('interface');
  // 收集产生至少一个 accepted 连接的稀有样本，其余样本绝大多数候选被剪枝。
  let rareKept = 0;
  let totalHardPruned = 0;
  let rareContributionLost = 0;
  let inspected = 0;
  for (let seed = 1; seed <= 120; seed++) {
    for (let py = 0; py < 4; py++) {
      for (let px = 0; px < 4; px++) {
        const rng = new Rng(seed * 13 + px * 3);
        const cam = generateCameraPath(scene, camera, px, py, rng, opts);
        const light = generateLightPath(scene, rng, opts);
        const base = pairOutputs(scene, camera, cam, light, 'baseline').attempts;
        const planned = pairOutputs(scene, camera, cam, light, 'prune');
        inspected++;
        totalHardPruned += planned.cost.hardPruned;
        const baseAccepted = base.filter((a) => a.accepted);
        if (baseAccepted.length === 0) continue;
        const pruneAccepted = planned.attempts.filter((a) => a.accepted);
        rareKept++;
        // 基线下每一个接受连接，剪枝模式都必须保留且加权一致。
        const pmap = new Map(pruneAccepted.map((a) => [a.key, a]));
        for (const b of baseAccepted) {
          const z = pmap.get(b.key);
          if (!z) {
            rareContributionLost++;
            continue;
          }
          for (let k = 0; k < 3; k++) assert.ok(Math.abs(b.weighted[k] - z.weighted[k]) < 1e-12);
        }
      }
    }
  }
  assert.ok(rareKept > 5, '场景中找不到稀有有效端点样本，边界条件未被覆盖');
  assert.ok(totalHardPruned > 500, '不可连接端点数量不足以体现剪枝负载');
  assert.equal(rareContributionLost, 0, '剪枝吞掉了稀有有效贡献');
});

test('optimized 预算超额时逆概率加权保持期望无偏', () => {
  const { scene, camera } = cameraFor('interface');
  const trials = 240;
  const budget = 8;
  const baseVals = [];
  const optVals = [];
  for (let i = 0; i < trials; i++) {
    const seed = 31337 + i * 17;
    const rng = new Rng(seed);
    const cam = generateCameraPath(scene, camera, 6, 5, rng, opts);
    const light = generateLightPath(scene, rng, opts);
    const base = pairOutputs(scene, camera, cam, light, 'baseline').attempts;
    const opt = pairOutputs(scene, camera, cam, light, 'optimized', budget);
    baseVals.push(weightedLum(base));
    optVals.push(weightedLum(opt.attempts));
    assert.ok(opt.cost.visibilityRays <= budget + 1, '可见性预算被突破');
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const ratio = mean(optVals) / Math.max(1e-9, mean(baseVals));
  assert.ok(ratio > 0.75 && ratio < 1.33, `optimized 偏差超容差: ratio=${ratio}`);
});

test('交换透明界面两侧介质后，同一光路贡献不被统计两遍', () => {
  const { scene, camera } = cameraFor('interface');
  const swapped = createScene('interface');
  swapInterfaceMedia(swapped);
  let beforeSum = 0;
  let afterSum = 0;
  let compared = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rng1 = new Rng(seed * 5 + 1);
    const rng2 = new Rng(seed * 5 + 1);
    const cam1 = generateCameraPath(scene, camera, 5, 5, rng1, opts);
    const light1 = generateLightPath(scene, rng1, opts);
    const cam2 = generateCameraPath(swapped, camera, 5, 5, rng2, opts);
    const light2 = generateLightPath(swapped, rng2, opts);
    const a1 = pairOutputs(scene, camera, cam1, light1, 'prune').attempts;
    const a2 = pairOutputs(swapped, camera, cam2, light2, 'prune').attempts;
    // 介质交换只翻转侧标签，几何/BSSRDF 不变，因此每条策略权重一致。
    const m2 = new Map(a2.map((a) => [a.key, a]));
    for (const x of a1) {
      const y = m2.get(x.key);
      assert.ok(y, '交换后策略集合改变');
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(x.weighted[k] - y.weighted[k]) < 1e-12);
      compared++;
    }
    beforeSum += weightedLum(a1);
    afterSum += weightedLum(a2);
  }
  assert.ok(compared > 0);
  // 两侧渲染结果相同，而不是把同一光路在两个介质侧各计一次（那样会接近 2 倍）。
  const ratio = afterSum / Math.max(1e-9, beforeSum);
  assert.ok(Math.abs(ratio - 1) < 1e-9, `介质交换后贡献被重复计数: ratio=${ratio}`);
});

test('被拒候选归还采样预算，预算账实一致', () => {
  const { scene, camera } = cameraFor('slit');
  let refundChecks = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const rng = new Rng(seed * 11 + 2);
    const cam = generateCameraPath(scene, camera, 4, 4, rng, opts);
    const light = generateLightPath(scene, rng, opts);
    const planned = planConnections(scene, camera, cam, light, cam.pixel, {
      ...opts,
      connectionMode: 'prune',
    });
    const c = planned.cost;
    // 归还预算 = 硬剪枝 + 全部廉价软预过滤（事件/零几何/相机出界），每个被拒
    // 候选恰好归还一次。
    const expectedRefund = c.hardPruned + c.softPrefiltered;
    assert.equal(c.budgetRefunded, expectedRefund);
    // softPrefiltered 本身是三类廉价拒绝的总和。
    assert.equal(
      c.softPrefiltered,
      c.eventRejected + c.geometryZeroProbes + c.cameraRejected,
    );
    // 候选三种归宿：硬剪枝（不发射光线）、相机出界提前返回（evaluateStrategy
    // 内部不调用 visible()）、其余进入完整可见性检查。
    assert.equal(
      c.visibilityRays + c.hardPruned + c.cameraRejected,
      c.candidates,
    );
    // 软预过滤候选仍会完整求值以保留 MIS 记录，因此不超过光线计数。
    assert.ok(c.softPrefiltered - c.cameraRejected <= c.visibilityRays);
    refundChecks++;
  }
  assert.ok(refundChecks > 0);
});
