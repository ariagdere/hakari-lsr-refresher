// hakari-lsr-refresher
// lsr_series tablosunu her 5 dakikada bir günceller -- hakari-candle-refresher ile AYNI
// pattern: başlangıçta DB'deki son kayıttan şimdiye kadar olan boşlukları doldurur
// (self-healing -- servis bir süre kapalıysa da açılış GAP'ini kendi kapatır), sonra her
// 5dk sınırında (saat başı hizalı) yeni veriyi çeker. 4 seri tutulur: global Long/Short
// ratio + Top Traders L/S Position ratio, ikisi de 1h ve 5m.
const { Pool } = require('pg');
const { LsrSeries } = require('./lsrAngle');

const databaseUrl = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: databaseUrl });

const SYMBOL = process.env.LSR_SYMBOL || 'BTCUSDT';
const ENDPOINT = {
  global: 'https://fapi.binance.com/futures/data/globalLongShortAccountRatio',
  top_position: 'https://fapi.binance.com/futures/data/topLongShortPositionRatio',
};
const STEP_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 };
const CLOSE_BUFFER_MS = 15 * 1000; // Binance'in periyodu kapatması için tampon süre
const TICK_MS = STEP_MS['5m']; // en küçük periyoda hizalı dön; 1h de her turda upsert edilir (idempotent)
const COMBOS = [
  ['global', '1h'], ['global', '5m'],
  ['top_position', '1h'], ['top_position', '5m'],
];

async function fetchRatios(metric, period, startMs, endMs) {
  const step = STEP_MS[period];
  const out = [];
  let t = startMs;
  while (t <= endMs) {
    const chunkEnd = Math.min(t + 500 * step - 1, endMs);
    const url = `${ENDPOINT[metric]}?symbol=${SYMBOL}&period=${period}&limit=500&startTime=${t}&endTime=${chunkEnd}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Binance API hatasi (${metric}/${period}): ${res.status} ${await res.text()}`);
    }
    const raw = await res.json();
    for (const d of raw) {
      out.push({
        time: Number(d.timestamp),
        longAccount: parseFloat(d.longAccount),
        shortAccount: parseFloat(d.shortAccount),
        longShortRatio: parseFloat(d.longShortRatio),
      });
    }
    t += 500 * step;
  }
  return out;
}

async function upsertSeries(metric, period, rows) {
  if (rows.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO lsr_series (metric, period, open_time, long_account, short_account, long_short_ratio, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (metric, period, open_time) DO UPDATE SET
           long_account=EXCLUDED.long_account, short_account=EXCLUDED.short_account,
           long_short_ratio=EXCLUDED.long_short_ratio, updated_at=now()`,
        [metric, period, r.time, r.longAccount, r.shortAccount, r.longShortRatio]
      );
    }
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getLastStoredOpenTime(metric, period) {
  const { rows } = await pool.query(
    'SELECT MAX(open_time) AS max_ot FROM lsr_series WHERE metric = $1 AND period = $2',
    [metric, period]
  );
  return rows[0].max_ot ? Number(rows[0].max_ot) : null;
}

// Şu an OLUŞMAKTA olan periyodun AÇILIŞ zamanını döndürür -- periyot sınırına aşağı yuvarlar.
function currentPeriodOpenTime(now, step) {
  return Math.floor(now / step) * step;
}

// Başlangıçta (ve her çalışımda emniyet için) DB'deki son kayıttan şimdiye kadar olan
// BOŞLUĞU doldurur -- servis bir süre kapalı kalmışsa bile veri bütünlüğü korunur.
// hakari-candle-refresher'daki DÜZELTMEYLE AYNI: endTime, mevcut periyodun açılışından
// 1ms ÖNCESİNE sabitlenir -- Binance'ten SADECE kesinlikle kapanmış periyotlar istenir.
async function fillGap(metric, period) {
  const step = STEP_MS[period];
  const lastOpenTime = await getLastStoredOpenTime(metric, period);
  const now = Date.now();
  const endMs = currentPeriodOpenTime(now, step) - 1;
  // lsr_series'te bu (metric, period) için hiç kayıt yoksa (normalde olmamalı -- asıl
  // geçmiş db/lsr_backfill.py ile doldurulur; bu yalnızca o script'ten önce servis
  // yanlışlıkla başlatılırsa devreye giren bir emniyet) yalnızca son 6 saati çek.
  const FIRST_RUN_LOOKBACK_MS = 6 * 60 * 60 * 1000;
  const startMs = lastOpenTime ? lastOpenTime + step : endMs - FIRST_RUN_LOOKBACK_MS;
  if (startMs > endMs) return;

  const rows = await fetchRatios(metric, period, startMs, endMs);
  const written = await upsertSeries(metric, period, rows);
  if (written > 0) {
    console.log(`[fillGap] ${metric}/${period}: ${written} kayıt yazıldı/güncellendi (${new Date(startMs).toISOString()} -> ${new Date(endMs).toISOString()}).`);
  }
}

function msUntilNextBoundary() {
  const now = Date.now();
  const nextBoundary = Math.ceil(now / TICK_MS) * TICK_MS;
  return (nextBoundary - now) + CLOSE_BUFFER_MS;
}

async function refreshTick() {
  for (const [metric, period] of COMBOS) {
    try {
      await fillGap(metric, period);
    } catch (err) {
      console.error(`[refreshTick] ${metric}/${period} hata:`, err.message);
    }
  }
}

// Basit doğrulama: her turda son verilerle LsrSeries kurup en güncel açıyı loglar --
// üretim yazımını etkilemez, yalnızca servisin canlı/mantıklı çalıştığını gözlemlemek için.
async function logCurrentAngles() {
  for (const [metric, period] of COMBOS) {
    try {
      const { rows } = await pool.query(
        `SELECT open_time, long_short_ratio FROM lsr_series
         WHERE metric = $1 AND period = $2 ORDER BY open_time ASC`,
        [metric, period]
      );
      if (rows.length < 130) continue; // referans (min 100 pencere) + 30 pencere için kabaca yeterli veri
      const series = new LsrSeries(rows.map(r => ({ t: Number(r.open_time), v: Number(r.long_short_ratio) })), period);
      const { result, reason } = series.statsAt(Date.now(), 0);
      if (result) {
        console.log(`[angle] ${metric}/${period}: ${result.angle.toFixed(1)}° (R²=${result.r2.toFixed(2)}, ref=%${(result.ref * 100).toFixed(2)}, n_ref=${result.nRef})`);
      } else {
        console.log(`[angle] ${metric}/${period}: hesaplanamadı (${reason})`);
      }
    } catch (err) {
      console.error(`[logCurrentAngles] ${metric}/${period} hata:`, err.message);
    }
  }
}

async function main() {
  console.log('hakari-lsr-refresher baslatiliyor...');
  await refreshTick(); // açılışta boşluk doldur
  await logCurrentAngles();

  const delay = msUntilNextBoundary();
  console.log(`Ilk zamanlanmis calisma ${Math.round(delay / 1000)} saniye sonra.`);
  setTimeout(function scheduleLoop() {
    refreshTick().then(logCurrentAngles);
    setInterval(() => { refreshTick().then(logCurrentAngles); }, TICK_MS);
  }, delay);
}

main().catch(err => {
  console.error('Fatal hata:', err);
  process.exit(1);
});
