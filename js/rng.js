/* 确定性伪随机数（mulberry32 + Box-Muller），保证示例数据每次加载完全一致。
   UMD 形态：浏览器挂到 PRA.Rng，Node 下可 require。 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.PRA = root.PRA || {};
  root.PRA.Rng = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seed) {
    const rand = mulberry32(seed);
    let spare = null;
    return {
      next: rand,
      uniform(lo, hi) {
        return lo + (hi - lo) * rand();
      },
      int(lo, hi) {
        return Math.floor(this.uniform(lo, hi + 1));
      },
      pick(arr) {
        return arr[Math.floor(rand() * arr.length)];
      },
      normal(mu, sigma) {
        if (spare !== null) {
          const v = mu + sigma * spare;
          spare = null;
          return v;
        }
        let u = 0, v = 0;
        while (u === 0) u = rand();
        while (v === 0) v = rand();
        const mag = Math.sqrt(-2.0 * Math.log(u));
        const z0 = mag * Math.cos(2 * Math.PI * v);
        const z1 = mag * Math.sin(2 * Math.PI * v);
        spare = z1;
        return mu + sigma * z0;
      },
      shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
      }
    };
  }

  return { makeRng, mulberry32 };
});
