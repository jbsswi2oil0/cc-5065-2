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

export const SCENES = {
  corner: cornerScene,
  slit: slitScene,
  occlusion: occlusionScene,
};

export function createScene(id) {
  const factory = SCENES[id] || cornerScene;
  const scene = factory();
  scene.emitters = scene.prims.filter((p) => scene.lightPrimIds.includes(p.id));
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
