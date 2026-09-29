/**
 * Server-side tariff quote (integer kopecks). SPEC §5.
 * cost_kopecks = ceil(N * R / (S * 60))
 * Default R = 6 (0,06 ₽/min), S = 16000 (decoded PCM).
 */
export const DEFAULT_SAMPLE_RATE = 16_000;
export const DEFAULT_TARIFF_KOPECKS_PER_MINUTE = 6;
export const FORMULA_ID = 'ceil_n_r_over_s_60';
export const TARIFF_VERSION = 1;
export const QUOTE_TTL_MS = 30 * 60 * 1000;

/**
 * @param {object} opts
 * @param {number} [opts.durationSamples] N
 * @param {number} [opts.durationSeconds] used when samples omitted (N = round(seconds * S))
 * @param {number} [opts.sampleRate]
 * @param {number} [opts.tariffKopecksPerMinute]
 */
export function quoteCost({
  durationSamples,
  durationSeconds,
  sampleRate = DEFAULT_SAMPLE_RATE,
  tariffKopecksPerMinute = DEFAULT_TARIFF_KOPECKS_PER_MINUTE,
} = {}) {
  const S = Number(sampleRate);
  const R = Number(tariffKopecksPerMinute);
  if (!Number.isInteger(S) || S <= 0) throw new TypeError('sampleRate must be a positive integer');
  if (!Number.isInteger(R) || R < 0) throw new TypeError('tariffKopecksPerMinute must be a non-negative integer');

  let N;
  if (durationSamples != null) {
    N = Number(durationSamples);
    if (!Number.isInteger(N) || N < 0) throw new TypeError('durationSamples must be a non-negative integer');
  } else if (durationSeconds != null) {
    const sec = Number(durationSeconds);
    if (!Number.isFinite(sec) || sec < 0) throw new TypeError('durationSeconds must be a non-negative number');
    N = Math.round(sec * S);
  } else {
    throw new TypeError('durationSamples or durationSeconds required');
  }

  // Integer ceil division: ceil(N*R / (S*60))
  const denom = S * 60;
  const numer = N * R;
  const costKopecks = numer === 0 ? 0 : Math.floor((numer + denom - 1) / denom);

  return {
    durationSamples: N,
    sampleRate: S,
    tariffKopecksPerMinute: R,
    tariffVersion: TARIFF_VERSION,
    costKopecks,
    formulaId: FORMULA_ID,
  };
}

export function costSnapshotFromSeconds(durationSeconds, extras = {}) {
  const quote = quoteCost({ durationSeconds, ...extras });
  return {
    duration_samples: quote.durationSamples,
    sample_rate: quote.sampleRate,
    tariff_kopecks_per_minute: quote.tariffKopecksPerMinute,
    tariff_version: quote.tariffVersion,
    cost_kopecks: quote.costKopecks,
    formula_id: quote.formulaId,
  };
}

export function formatRub(kopecks) {
  const n = Number(kopecks);
  if (!Number.isInteger(n)) throw new TypeError('kopecks must be an integer');
  return (n / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
}
