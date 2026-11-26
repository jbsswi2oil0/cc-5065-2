export class Rng {
  constructor(seed = 1) {
    this.state = seed >>> 0;
    this.startSeed = this.state;
    this.calls = 0;
  }

  next() {
    let t = (this.state += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    this.calls++;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo, hi) {
    return lo + (hi - lo) * this.next();
  }

  int(n) {
    return Math.floor(this.next() * n);
  }
}

export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x9e3779b9;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
