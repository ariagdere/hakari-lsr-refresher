// lsrAngle.js
// LSR / TT-Position "slope açısı" hesabı. lsr_order_report.py (Python, ariagdere/hakari
// projesinde daha önce doğrulanmış) ile BİREBİR aynı matematik -- window_stats / Series /
// stats_at fonksiyonlarının JS portu. Referans HER sorguda yalnızca o ana kadar kapanmış
// pencerelerden hesaplanır (look-ahead sızıntısı yok) -- bkz. statsAt().
//
// Bu dosya kasıtlı olarak bağımsız/kopyalanabilir tutuldu (dış paket bağımlılığı yok):
// hem hakari-lsr-refresher hem metaapi-webhook (mt5_order_monitor.js) aynı dosyayı kullanır.

const WINDOW = 30;
const MIN_REF_WINDOWS = 100;
const STEP_MS = { '5m': 300_000, '1h': 3_600_000 };

// y: pencere uzunluğunda sayı dizisi. Dönüş: {slope, r2}.
// slope: y/ortalama - 1 üzerinde x=linspace(0,1,n) doğrusunun eğimi -- pencere boyunca
// TOPLAM normalize değişim. r2: uyumun gürültü/güvenilirlik göstergesi.
function windowStats(y) {
  const n = y.length;
  const mean = y.reduce((a, b) => a + b, 0) / n;
  const yn = y.map((v) => v / mean - 1);
  const ynMean = yn.reduce((a, b) => a + b, 0) / n;
  const yc = yn.map((v) => v - ynMean);
  const xc = new Array(n);
  for (let i = 0; i < n; i++) xc[i] = n === 1 ? 0 : i / (n - 1);
  const xcMean = xc.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) xc[i] -= xcMean;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += xc[i] * xc[i];
    syy += yc[i] * yc[i];
    sxy += xc[i] * yc[i];
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, r2 };
}

// numpy.percentile(..., 90) ile aynı (varsayılan doğrusal interpolasyon).
function percentile90(sortedOrUnsorted) {
  const s = [...sortedOrUnsorted].sort((a, b) => a - b);
  const idx = 0.9 * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// np.searchsorted(arr, x, side='right') portu -- arr artan sıralı olmalı.
function searchRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

class LsrSeries {
  // rows: [{t: ms (artan, eşsiz), v: sayı}, ...] -- lsr_series tablosundan open_time ASC
  // okunup {t: open_time, v: long_short_ratio} şeklinde map'lenerek verilir.
  constructor(rows, period, opts = {}) {
    this.period = period;
    this.step = STEP_MS[period];
    this.n = opts.window || WINDOW;
    this.minRef = opts.minRef ?? MIN_REF_WINDOWS;
    this.lookbackMs = opts.lookbackMs ?? null;
    this.ts = rows.map((r) => r.t);
    this.v = rows.map((r) => r.v);
    const m = this.ts.length;
    this.slope = new Array(m).fill(null);
    this.r2 = new Array(m).fill(null);
    for (let i = this.n - 1; i < m; i++) {
      if (this.ts[i] - this.ts[i - this.n + 1] === (this.n - 1) * this.step) {
        const { slope, r2 } = windowStats(this.v.slice(i - this.n + 1, i + 1));
        this.slope[i] = slope;
        this.r2[i] = r2;
      }
    }
    this.viTs = [];
    this.viAbs = [];
    for (let i = 0; i < m; i++) {
      if (this.slope[i] !== null) {
        this.viTs.push(this.ts[i]);
        this.viAbs.push(Math.abs(this.slope[i]));
      }
    }
  }

  // tMs anındaki (lag dönem gecikmeli) açıyı, o ana kadarki veriyle hesaplar.
  // Dönüş: { result: {slope, r2, ref, nRef, refEnd, angle} | null, reason: string }
  statsAt(tMs, lag = 1) {
    const cutoff = tMs - lag * this.step;
    const idx = searchRight(this.ts, cutoff) - 1;
    if (idx < this.n - 1) return { result: null, reason: 'seri_oncesi' };
    if (cutoff - this.ts[idx] >= 2 * this.step) return { result: null, reason: 'seri_sonrasi' };
    if (this.slope[idx] === null) return { result: null, reason: 'bosluk' };
    const hi = searchRight(this.viTs, cutoff);
    const lo = this.lookbackMs != null ? searchRight(this.viTs, cutoff - this.lookbackMs) : 0;
    const refVals = this.viAbs.slice(lo, hi);
    if (refVals.length < this.minRef) return { result: null, reason: 'referans_yetersiz' };
    const ref = percentile90(refVals);
    if (!(ref > 0)) return { result: null, reason: 'referans_yetersiz' };
    const slope = this.slope[idx];
    return {
      result: {
        slope,
        r2: this.r2[idx],
        ref,
        nRef: refVals.length,
        refEnd: this.viTs[hi - 1],
        angle: (Math.atan(slope / ref) * 180) / Math.PI,
      },
      reason: 'ok',
    };
  }
}

module.exports = { windowStats, percentile90, searchRight, LsrSeries, STEP_MS, WINDOW, MIN_REF_WINDOWS };
