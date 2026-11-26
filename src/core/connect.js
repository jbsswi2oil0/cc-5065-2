import { V } from './vec3.js';
import { isDeltaMaterial } from './materials.js';
import { splitFeasibility, evaluateStrategy } from './bdpt.js';

// ---------------------------------------------------------------------------
// 端点介质侧 / 可通行信息
// 场景可以声明与实体隔断共面的介质区域（透明界面）。每个顶点按位置归入一个
// 介质侧；连接段穿越界面时必须落在界面的可通行开口内。开口外的穿越必然击中
// 实体墙，因此这是可证明的几何上界剪枝：基线的可见性光线同样会失败。
// ---------------------------------------------------------------------------

export function mediumSideAt(scene, p) {
  const regions = scene.mediumRegions;
  if (!regions || regions.length === 0) return 0;
  let side = 0;
  for (const r of regions) {
    const d = V.dot(r.plane.n, V.sub(p, r.plane.p0));
    if (d >= 0) side |= r.positiveMask;
  }
  return side;
}

function segmentPlaneCross(pA, pB, plane) {
  const da = V.dot(plane.n, V.sub(pA, plane.p0));
  const db = V.dot(plane.n, V.sub(pB, plane.p0));
  // 端点贴在界面平面附近（与光线起点偏移 1.2e-4/可见性 eps 2e-4 同量级）视为
  // 相切：这种近墙短连接由实体墙自身的可见性逻辑（含偏移与自命中规避）处理，
  // 界面剪枝不得用理想平面几何否决它。只有两端都明确越过容差带且分居异侧时，
  // 才认定为真正的界面穿越。
  const onPlane = (d) => Math.abs(d) < 3e-4;
  if (onPlane(da) || onPlane(db) || !(da * db < 0)) return null;
  const t = da / (da - db);
  if (t <= 0 || t >= 1) return null;
  return { t, point: V.lerp(pA, pB, t) };
}

function pointInsideOpening(point, opening) {
  const u = V.dot(V.sub(point, opening.center), opening.u);
  const v = V.dot(V.sub(point, opening.center), opening.v);
  return Math.abs(u) <= opening.halfU && Math.abs(v) <= opening.halfV;
}

// 若连接段穿过任一介质界面，返回穿越点；穿越必须落在可通行开口内。
export function interfaceCrossing(scene, pA, pB) {
  const regions = scene.mediumRegions;
  if (!regions || regions.length === 0) return { crosses: false };
  for (const r of regions) {
    const hit = segmentPlaneCross(pA, pB, r.plane);
    if (!hit) continue;
    const passable = r.openings.some((o) => pointInsideOpening(hit.point, o));
    return {
      crosses: true,
      regionId: r.id,
      point: hit.point,
      t: hit.t,
      passable,
      sideA: V.dot(r.plane.n, V.sub(pA, r.plane.p0)) >= 0 ? r.positiveMask : 0,
      sideB: V.dot(r.plane.n, V.sub(pB, r.plane.p0)) >= 0 ? r.positiveMask : 0,
    };
  }
  return { crosses: false };
}

// ---------------------------------------------------------------------------
// 端点可连接报告：由子路径生成器在路径生成后填充，连接筛选器直接消费。
// connectible=false 的镜面端点不能做任意连接（事件条件），但纯前缀/t=0 保留。
// ---------------------------------------------------------------------------

export function endpointReport(vertex, scene) {
  const delta = vertex.kind === 'surface' && isDeltaMaterial(vertex.mat);
  return {
    kind: vertex.kind,
    materialType: vertex.mat?.type ?? null,
    connectible: !delta,
    delta,
    mediumSide: vertex.mediumSide ?? mediumSideAt(scene, vertex.p),
    point: vertex.p,
    normal: vertex.n,
  };
}

export function annotatePathSide(path, scene) {
  for (const v of path.vertices) {
    if (v.mediumSide === undefined) v.mediumSide = mediumSideAt(scene, v.p);
  }
  return path;
}

// ---------------------------------------------------------------------------
// 几何上界探针：只做叉积/点积，不发射光线。返回的 bound 是几何项的严格上界，
// 任何 bound=0 的候选都不可能产生贡献。
// ---------------------------------------------------------------------------

export function geometricUpperBound(a, b, scene) {
  const d = V.sub(b.p, a.p);
  const r2 = V.dot(d, d);
  if (!(r2 > 1e-12)) return { connectible: false, reason: 'degenerate-endpoints' };
  const dir = V.div(d, Math.sqrt(r2));
  const cosA = a.kind === 'camera' ? 1 : Math.abs(V.dot(a.n, dir));
  const cosB = b.kind === 'camera' ? 1 : Math.abs(V.dot(b.n, V.mul(dir, -1)));
  const zeroCosine =
    (a.kind !== 'camera' && cosA <= 1e-9) || (b.kind !== 'camera' && cosB <= 1e-9);
  const crossing = interfaceCrossing(scene, a.p, b.p);
  const interfaceMiss = crossing.crosses && !crossing.passable;
  return {
    connectible: !zeroCosine && !interfaceMiss,
    reason: interfaceMiss
      ? 'interface-opening-miss'
      : zeroCosine
        ? 'geometry-zero-cosine'
        : null,
    bound: (cosA * cosB) / r2,
    cosA,
    cosB,
    zeroCosine,
    crossing,
  };
}

export function eventConnectible(full, s) {
  return splitFeasibility(full, s);
}

// ---------------------------------------------------------------------------
// 候选枚举：与 evaluateAllStrategies 相同的 (s,t) 对及 t=0 前缀。
// ---------------------------------------------------------------------------

function enumeratePairs(cam, light) {
  const pairs = [];
  for (let s = 1; s <= cam.vertices.length; s++) {
    for (let t = 1; t <= light.vertices.length; t++) pairs.push({ s, t, t0: false });
  }
  for (let s = 1; s <= cam.vertices.length; s++) {
    const v = cam.vertices[s - 1];
    if (v.kind === 'light' || v.mat?.type === 'light') pairs.push({ s, t: 0, t0: true });
  }
  return pairs;
}

// 分层抽取：候选数超过可见性预算时，用互质步长在候选环上均匀落点，保证稀有
// 有效端点不会因为排在枚举尾部而被系统性丢弃。返回保留集合与每个候选的保留
// 概率 p；被保留候选的贡献乘 1/p，使估计量保持无偏（逆概率加权）。
function stratifiedPick(count, budget, rng) {
  if (budget >= count) return { keep: null, probability: 1 };
  const keep = new Set();
  const offset = rng ? rng.int(count) : 0;
  const stride = Math.max(1, Math.floor(count / budget));
  let candidate = offset % count;
  while (keep.size < budget) {
    while (keep.has(candidate)) candidate = (candidate + 1) % count;
    keep.add(candidate);
    candidate = (candidate + stride) % count;
  }
  // 每个候选被选中的边际概率为 budget/count（均匀环抽样），期望下预算恰好用满。
  return { keep, probability: budget / count };
}

function blankAttempt(s, t) {
  return {
    key: `${s},${t}`,
    s,
    t,
    accepted: false,
    visible: null,
    geometry: 0,
    visibility: 1,
    unweighted: [0, 0, 0],
    misWeight: 0,
    weighted: [0, 0, 0],
    status: 'not-evaluated',
    full: null,
    mis: null,
    cameraResponse: null,
    endpointPdfs: null,
  };
}

// ---------------------------------------------------------------------------
// 连接规划器
//   mode='baseline'  全部候选都走完整 evaluateStrategy（旧双向路径行为）
//   mode='prune'     廉价探针先行 + 界面硬剪枝；其余候选仍完整求值并保留 MIS，
//                    与基线逐像素一致，只省下界面未命中候选的可见性光线
//   mode='optimized' 在 prune 基础上对剩余可见性检查施加每像素样本预算，超额
//                    候选分层抽取；被拒候选归还预算，稀有有效端点不会被吞掉
//
// 拒绝级别：
//   hard  可证明零贡献且基线也必然零贡献（界面开口未命中），不发射可见性光线
//   soft  事件/零余弦/相机出界等探针命中，登记预过滤但仍完整求值以保留 MIS 记录
// ---------------------------------------------------------------------------

export function planConnections(scene, camera, cam, light, pixel, options = {}) {
  const mode = options.connectionMode ?? 'baseline';
  const visibilityBudget = options.connectionBudget ?? Infinity;
  const rng = options.connectionRng ?? null;
  const pairs = enumeratePairs(cam, light);
  const cost = {
    mode,
    candidates: pairs.filter((p) => !p.t0).length,
    t0Prefixes: pairs.filter((p) => p.t0).length,
    eventRejected: 0,
    geometryZeroProbes: 0,
    cameraRejected: 0,
    interfacePruned: 0,
    hardPruned: 0,
    softPrefiltered: 0,
    budgetDeferred: 0,
    visibilityRays: 0,
    visibilityBlocked: 0,
    budgetRefunded: 0,
    budgetUsed: 0,
    budgetInitial: Number.isFinite(visibilityBudget) ? visibilityBudget : null,
  };
  const reports = {
    camera: cam.vertices.map((v) => endpointReport(v, scene)),
    light: light.vertices.map((v) => endpointReport(v, scene)),
  };

  const t0Pairs = [];
  const entries = [];

  for (const pair of pairs) {
    const { s, t, t0 } = pair;
    if (t0) {
      t0Pairs.push(pair);
      continue;
    }
    const a = cam.vertices[s - 1];
    const b = light.vertices[t - 1];
    const full = [...cam.vertices.slice(0, s), ...light.vertices.slice(0, t).reverse()];

    const event = eventConnectible(full, s);
    if (!event.feasible) {
      cost.eventRejected++;
      cost.softPrefiltered++;
      cost.budgetRefunded++;
      entries.push({ pair, kind: 'trace', prefilter: event.reason });
      continue;
    }

    let cameraOutside = false;
    if (s === 1) {
      const dirAB = V.norm(V.sub(b.p, a.p));
      const response = camera.weForPixel(pixel[0], pixel[1], dirAB);
      if (!response.inside) cameraOutside = true;
    }

    const geo = geometricUpperBound(a, b, scene);
    if (geo.reason === 'interface-opening-miss') {
      // 硬剪枝：实体墙保证该连接的可见性光线必失败，基线贡献同样为零。
      cost.interfacePruned++;
      cost.hardPruned++;
      cost.budgetRefunded++;
      entries.push({ pair, kind: 'hard', status: 'interface-opening-miss' });
      continue;
    }
    // 软预过滤每个候选至多登记一次（相机出界与零余弦取其一），并归还一次预算。
    if (cameraOutside) {
      cost.cameraRejected++;
      cost.softPrefiltered++;
      cost.budgetRefunded++;
    } else if (geo.zeroCosine) {
      cost.geometryZeroProbes++;
      cost.softPrefiltered++;
      cost.budgetRefunded++;
    }
    entries.push({ pair, kind: 'trace', prefilter: cameraOutside ? 'camera-response-outside-pixel' : (geo.zeroCosine ? geo.reason : null) });
  }

  const traceable = entries.filter((e) => e.kind === 'trace');
  let keepSet = null;
  let keepProbability = 1;
  if (mode === 'optimized' && Number.isFinite(visibilityBudget) && traceable.length > visibilityBudget) {
    const picked = stratifiedPick(traceable.length, visibilityBudget, rng);
    keepSet = picked.keep;
    keepProbability = picked.probability;
  }

  const attempts = [];
  let traceCursor = 0;
  for (const entry of entries) {
    const { s, t } = entry.pair;
    if (entry.kind === 'hard') {
      attempts.push({ ...blankAttempt(s, t), status: entry.status });
      continue;
    }
    if (keepSet && !keepSet.has(traceCursor)) {
      cost.budgetDeferred++;
      // 未抽中的候选本轮不发射可见性光线、不计贡献；被抽中者乘 1/p 补偿，
      // 使子采样估计量在期望上等于完整求值，稀有有效端点不会被预算吞掉。
      attempts.push({ ...blankAttempt(s, t), status: 'connection-budget-deferred' });
      traceCursor++;
      continue;
    }
    traceCursor++;
    const attempt = evaluateStrategy(scene, camera, cam, light, s, t, options);
    // evaluateStrategy 仅在相机响应通过后才发射线段可见性光线；相机出界的候选
    // 提前返回（visible 字段为 null），不计入光线工作量，与基线口径一致。
    if (attempt.visible !== null) cost.visibilityRays++;
    if (attempt.visible === false) cost.visibilityBlocked++;
    if (keepSet) {
      const invP = 1 / keepProbability;
      attempt.weighted = attempt.weighted.map((x) => x * invP);
      attempt.subSampled = true;
      attempt.keepProbability = keepProbability;
    }
    if (entry.prefilter) attempt.prefilter = entry.prefilter;
    attempts.push(attempt);
  }

  for (const pair of t0Pairs) {
    attempts.push(evaluateStrategy(scene, camera, cam, light, pair.s, 0, options));
  }

  cost.budgetUsed = cost.visibilityRays;
  return { attempts, cost, reports };
}

export function evaluateAllStrategiesPlanned(scene, camera, cam, light, options = {}) {
  const pixel = cam.pixel;
  const { attempts, cost, reports } = planConnections(scene, camera, cam, light, pixel, options);
  return { attempts, cost, reports };
}
