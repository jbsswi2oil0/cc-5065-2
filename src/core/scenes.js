import { Quad, Sphere } from './geometry.js';

let primId = 0;
const q = (name, p00, e1, e2, materialId) => new Quad(`${name}-${primId++}`, p00, e1, e2, materialId);
const rect = (name, c, ux, uy, w, h, mat) =>
  q(
    name,
    [c[0] - (ux[0] * w) / 2 - (uy[0] * h) / 2, c[1] - (ux[1] * w) / 2 - (uy[1] * h) / 2, c[2] - (ux[2] * w) / 2 - (uy[2] * h) / 2],
    [ux[0] * w, ux[1] * w, ux[2] * w],
    [uy[0] * h, uy[1] * h, uy[2] * h],
    mat,
  );
const sph = (name, c, r, mat) => new Sphere(`${name}-${primId++}`, c, r, mat);

const materials = {
  white: { id: 'white', type: 'diffuse', color: [0.74, 0.72, 0.68] },
  warmWhite: { id: 'warmWhite', type: 'diffuse', color: [0.86, 0.78, 0.66] },
  red: { id: 'red', type: 'diffuse', color: [0.58, 0.12, 0.08] },
  blue: { id: 'blue', type: 'diffuse', color: [0.08, 0.22, 0.52] },
  dark: { id: 'dark', type: 'diffuse', color: [0.24, 0.25, 0.27] },
  tealRough: { id: 'tealRough', type: 'rough', color: [0.05, 0.42, 0.46], roughness: 0.34, diffuseMix: 0.52 },
  ochreRough: { id: 'ochreRough', type: 'rough', color: [0.72, 0.43, 0.12], roughness: 0.48, diffuseMix: 0.68 },
  plumRough: { id: 'plumRough', type: 'rough', color: [0.38, 0.12, 0.42], roughness: 0.27, diffuseMix: 0.45 },
  mirror: { id: 'mirror', type: 'mirror', color: [0.92, 0.95, 1.0] },
  lightWarm: { id: 'lightWarm', type: 'light', color: [1, 0.86, 0.62], emission: [13, 10.5, 7.2] },
  lightCool: { id: 'lightCool', type: 'light', color: [0.62, 0.78, 1], emission: [8.5, 11.5, 15] },
  lightRed: { id: 'lightRed', type: 'light', color: [1, 0.35, 0.22], emission: [8, 2.4, 1.4] },
};

function roomShell(prefix, bright = 'white') {
  return [
    rect(`${prefix}-floor`, [0, 0, 0.5], [1, 0, 0], [0, 0, -1], 6, 7, bright),
    rect(`${prefix}-ceiling`, [0, 3.4, 0.5], [1, 0, 0], [0, 0, 1], 6, 7, 'white'),
    rect(`${prefix}-back`, [0, 1.7, -3], [1, 0, 0], [0, 1, 0], 6, 3.4, 'white'),
    rect(`${prefix}-left`, [-3, 1.7, 0.5], [0, 0, -1], [0, 1, 0], 7, 3.4, 'red'),
    rect(`${prefix}-right`, [3, 1.7, 0.5], [0, 0, 1], [0, 1, 0], 7, 3.4, 'blue'),
  ];
}

function cornerScene() {
  const prims = [
    ...roomShell('corner'),
    rect('corner-baffle', [-1.0, 1.62, -0.35], [1, 0, 0], [0, 1, 0], 3.2, 3.24, 'warmWhite'),
    rect('corner-return-rough', [0.62, 1.42, -1.45], [0, 0, 1], [0, 1, 0], 2.2, 2.84, 'tealRough'),
    rect('corner-inner-red', [-2.965, 1.35, -1.4], [0, 0, -1], [0, 1, 0], 2.1, 2.7, 'red'),
    rect('corner-light', [-1.35, 3.385, -1.65], [1, 0, 0], [0, 0, 1], 1.45, 0.82, 'lightWarm'),
    sph('corner-rough-sphere', [1.72, 0.58, 0.95], 0.58, 'ochreRough'),
    sph('corner-mirror-sphere', [-2.05, 0.62, 1.25], 0.62, 'mirror'),
    rect('corner-rough-panel', [1.55, 1.55, -2.94], [1, 0, 0], [0, 1, 0], 1.25, 1.55, 'plumRough'),
  ];
  return {
    id: 'corner',
    label: '拐角间接照明 + 镜面链',
    description: '高隔断遮住顶部光源，连接必须绕过拐角；镜面球用于筛选不可连接的镜面端点。',
    prims,
    materials,
    lightPrimIds: prims.filter((p) => p.materialId.startsWith('light')).map((p) => p.id),
    camera: { target: [-0.35, 1.38, -0.75], yaw: 0.16, pitch: 0.075, distance: 6.35, fov: 49 },
    topView: { centerZ: 0.2, span: 7.2 },
  };
}

function slitScene() {
  const x0 = -0.15;
  const x1 = 0.15;
  const y0 = 0.9;
  const y1 = 2.52;
  const wallZ = 0.15;
  const prims = [
    ...roomShell('slit', 'dark'),
    rect('slit-wall-left', [(-3 + x0) / 2, 1.7, wallZ], [1, 0, 0], [0, 1, 0], x0 + 3, 3.4, 'dark'),
    rect('slit-wall-right', [(x1 + 3) / 2, 1.7, wallZ], [1, 0, 0], [0, 1, 0], 3 - x1, 3.4, 'dark'),
    rect('slit-wall-bottom', [0, y0 / 2, wallZ], [1, 0, 0], [0, 1, 0], x1 - x0, y0, 'dark'),
    rect('slit-wall-top', [0, (y1 + 3.4) / 2, wallZ], [1, 0, 0], [0, 1, 0], x1 - x0, 3.4 - y1, 'dark'),
    rect('slit-light-cool', [0, 3.385, -1.65], [1, 0, 0], [0, 0, 1], 1.25, 0.72, 'lightCool'),
    rect('slit-light-red', [-2.1, 2.75, -2.94], [1, 0, 0], [0, 1, 0], 0.7, 0.9, 'lightRed'),
    sph('slit-rough-sphere', [0.02, 0.62, -1.35], 0.62, 'tealRough'),
    rect('slit-target-rough', [1.65, 1.25, -2.94], [1, 0, 0], [0, 1, 0], 1.2, 1.7, 'ochreRough'),
    sph('slit-front-mirror', [-1.85, 0.55, 1.65], 0.55, 'mirror'),
  ];
  return {
    id: 'slit',
    label: '狭窄开口',
    description: '厚墙片段留出 30cm 窄缝；大量相机—灯光连接会因开口边界或可见性失败。',
    prims,
    materials,
    mediumRegions: [
      {
        id: 'slit-interface',
        plane: { p0: [0, 0, wallZ], n: [0, 0, -1] },
        positiveMask: 1,
        openings: [
          {
            id: 'slit-opening',
            center: [0, (y0 + y1) / 2, wallZ],
            u: [1, 0, 0],
            v: [0, 1, 0],
            halfU: (x1 - x0) / 2,
            halfV: (y1 - y0) / 2,
          },
        ],
        swapped: false,
      },
    ],
    lightPrimIds: prims.filter((p) => p.materialId.startsWith('light')).map((p) => p.id),
    camera: { target: [0, 1.62, 0.05], yaw: 0, pitch: 0.035, distance: 5.65, fov: 46 },
    topView: { centerZ: 0.1, span: 7.0 },
  };
}

function occlusionScene() {
  const prims = [
    ...roomShell('occ'),
    rect('occ-blocker', [0.05, 1.18, -0.55], [1, 0, 0], [0, 1, 0], 1.45, 2.36, 'dark'),
    rect('occ-blocker-edge-rough', [0.82, 1.25, -0.55], [0, 0, 1], [0, 1, 0], 0.55, 2.5, 'plumRough'),
    sph('occ-left-rough', [-1.65, 0.62, 0.35], 0.62, 'tealRough'),
    sph('occ-right-diffuse', [1.75, 0.72, -1.35], 0.72, 'ochreRough'),
    rect('occ-light-warm', [-1.85, 3.385, -1.35], [1, 0, 0], [0, 0, 1], 1.35, 0.8, 'lightWarm'),
    rect('occ-light-cool', [2.15, 2.55, -2.94], [1, 0, 0], [0, 1, 0], 0.8, 1.1, 'lightCool'),
    rect('occ-mirror-panel', [-2.94, 1.45, 1.1], [0, 0, 1], [0, 1, 0], 1.4, 2.1, 'mirror'),
  ];
  return {
    id: 'occlusion',
    label: '遮挡连接核查',
    description: '候选连接先算几何项，再做线段可见性；阻断连接返回 occluded，不产生图像贡献。',
    prims,
    materials,
    lightPrimIds: prims.filter((p) => p.materialId.startsWith('light')).map((p) => p.id),
    camera: { target: [0, 1.25, -0.65], yaw: 0.02, pitch: 0.08, distance: 6.2, fov: 50 },
    topView: { centerZ: 0.25, span: 7.4 },
  };
}

function interfaceScene() {
  // 实体隔断墙把房间分成两个介质侧，墙上只有一个小开口
  // （y∈[1.05,2.45], x∈[-0.18,0.18]）。介质界面与实体墙共面：连接段若在开口
  // 外穿越界面，必然击中实体墙（可见性光线也会失败），因此界面剪枝是可证明的
  // 几何上界，不会丢弃任何基线本会接受的贡献。交换介质只翻转侧标签，不动几何。
  const planeZ = 0.15;
  const halfU = 0.18;
  const y0 = 1.05;
  const y1 = 2.45;
  const opening = {
    id: 'iface-opening',
    center: [0, (y0 + y1) / 2, planeZ],
    u: [1, 0, 0],
    v: [0, 1, 0],
    halfU,
    halfV: (y1 - y0) / 2,
  };
  const mediumRegions = [
    {
      id: 'transparent-interface',
      plane: { p0: [0, 0, planeZ], n: [0, 0, -1] },
      positiveMask: 1,
      openings: [opening],
      swapped: false,
    },
  ];
  const prims = [
    ...roomShell('iface', 'dark'),
    rect('iface-wall-left', [(-3 - halfU) / 2, 1.7, planeZ], [1, 0, 0], [0, 1, 0], 3 - halfU, 3.4, 'dark'),
    rect('iface-wall-right', [(3 + halfU) / 2, 1.7, planeZ], [1, 0, 0], [0, 1, 0], 3 - halfU, 3.4, 'dark'),
    rect('iface-wall-bottom', [0, y0 / 2, planeZ], [1, 0, 0], [0, 1, 0], halfU * 2, y0, 'dark'),
    rect('iface-wall-top', [0, (y1 + 3.4) / 2, planeZ], [1, 0, 0], [0, 1, 0], halfU * 2, 3.4 - y1, 'dark'),
    rect('iface-light-warm', [-1.6, 3.385, -1.55], [1, 0, 0], [0, 0, 1], 1.35, 0.8, 'lightWarm'),
    rect('iface-light-cool', [1.95, 2.5, -2.94], [1, 0, 0], [0, 1, 0], 0.8, 1.05, 'lightCool'),
    sph('iface-back-rough', [-1.55, 0.6, -1.45], 0.6, 'tealRough'),
    sph('iface-back-diffuse', [1.55, 0.72, -1.05], 0.72, 'ochreRough'),
    sph('iface-front-mirror', [-1.95, 0.55, 1.75], 0.55, 'mirror'),
    rect('iface-front-rough', [1.7, 1.3, -2.92], [1, 0, 0], [0, 1, 0], 1.15, 1.6, 'plumRough'),
  ];
  return {
    id: 'interface',
    label: '透明界面窄开口（介质交换核查）',
    description: '虚拟界面分隔两种介质侧，连接段只有穿过小开口才可通行；交换界面两侧介质后重新分配预算，稀有有效路径仍须保留且只计一次。',
    prims,
    materials,
    mediumRegions,
    lightPrimIds: prims.filter((p) => p.materialId.startsWith('light')).map((p) => p.id),
    camera: { target: [0, 1.6, -0.2], yaw: 0, pitch: 0.04, distance: 5.55, fov: 46 },
    topView: { centerZ: 0.15, span: 7.0 },
  };
}

export const SCENES = {
  corner: cornerScene,
  slit: slitScene,
  occlusion: occlusionScene,
  interface: interfaceScene,
};

export function createScene(id) {
  const factory = SCENES[id] || cornerScene;
  const scene = factory();
  scene.emitters = scene.prims.filter((p) => scene.lightPrimIds.includes(p.id));
  return scene;
}

// 交换透明界面两侧的介质标签：不改动任何 BSDF 与几何，只翻转平面法线朝向与
// 正侧掩码，便于做“同一光路、介质侧互换”的不重复计数核查。
export function swapInterfaceMedia(scene) {
  if (!scene.mediumRegions) return scene;
  for (const region of scene.mediumRegions) {
    region.plane = { p0: region.plane.p0, n: [-region.plane.n[0], -region.plane.n[1], -region.plane.n[2]] };
    region.positiveMask = region.positiveMask === 1 ? 2 : 1;
    region.swapped = !region.swapped;
  }
  for (const prim of scene.prims) {
    if (prim.mediumSide !== undefined) prim.mediumSide = undefined;
  }
  return scene;
}

export function emitterPdfA(scene, prim) {
  return 1 / (scene.emitters.length * prim.area);
}

export function sampleEmitter(scene, rng) {
  const prim = scene.emitters[rng.int(scene.emitters.length)];
  const uv = prim.kind === 'quad' ? [rng.next(), rng.next()] : null;
  const areaSample = prim.kind === 'quad' ? prim.sampleArea(uv[0], uv[1]) : prim.sampleArea(rng.next(), rng.next());
  const pdfA = emitterPdfA(scene, prim);
  return {
    prim,
    material: scene.materials[prim.materialId],
    p: areaSample.p,
    n: areaSample.n,
    pdfA,
    chooseP: 1 / scene.emitters.length,
  };
}
