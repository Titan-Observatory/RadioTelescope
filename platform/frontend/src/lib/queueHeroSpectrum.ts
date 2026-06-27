import queueSpectrumRaw from '../data/queueSpectrum.txt?raw';

// Precomputed path data and helpers for the queue-page hero spectrum: an
// animated playback of a real H I survey profile. Pure logic only (no React),
// so the path/noise builders can be unit-tested in isolation.

export const HW = 600;
export const HERO_CHART_TOP = -42;
export const HERO_BASE_Y = 156;          // y-coordinate of the 0-power baseline
export const HERO_CHART_BOTTOM = 190;
export const HERO_CHART_HEIGHT = HERO_BASE_Y - HERO_CHART_TOP;
export const HERO_PEAK_HEADROOM = 70;
export const HERO_PEAK_PX = HERO_CHART_HEIGHT - HERO_PEAK_HEADROOM;
export const HERO_AXIS_LABEL_Y = HERO_BASE_Y + 22;
export const HERO_REST_LABEL_Y = HERO_BASE_Y + 19;
export const HERO_REST_LABEL_BOX_Y = HERO_BASE_Y + 4;
export const HERO_PERSEUS_BAND_TOP = HERO_CHART_TOP + HERO_CHART_HEIGHT * 0.34;
export const HERO_PERSEUS_LABEL_Y = HERO_CHART_TOP + HERO_CHART_HEIGHT * 0.31;
// Mobile: crop dead wings so the peaks fill the screen. x=[70,430] covers all
// labelled content (Perseus box at x≈87, bracket at x≈392) and clips the
// low-signal tails. The 1.67× effective zoom makes labels readable at ~12px.
export const HERO_MOBILE_VIEWBOX = `70 ${HERO_CHART_TOP} 360 ${HERO_CHART_BOTTOM - HERO_CHART_TOP}`;
export const HERO_DESKTOP_VIEWBOX = `0 ${HERO_CHART_TOP} ${HW} ${HERO_CHART_BOTTOM - HERO_CHART_TOP}`;

// LAB hydrogen-line profile supplied for the queue-page example spectrum.
// Columns in the source file are v_lsr [km/s], T_B [K], frequency [MHz],
// and wavelength [cm].
export type SurveySample = {
  tbK: number;
  freqMhz: number;
};

export function parseQueueSpectrum(raw: string): SurveySample[] {
  const samples: SurveySample[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;

    const tbK = Number(parts[1]);
    const freqMhz = Number(parts[2]);
    if (Number.isFinite(tbK) && Number.isFinite(freqMhz)) {
      samples.push({ tbK, freqMhz });
    }
  }

  if (samples.length === 0) {
    throw new Error('Queue spectrum data did not contain any LAB samples.');
  }

  return samples;
}

const RAW_SAMPLES = parseQueueSpectrum(queueSpectrumRaw);

// Downsample the LAB survey. The hero panel is ~600 CSS-px wide so we don't
// need every one of the raw 245 LAB samples; 100 bins matches the visible
// detail without spending budget on points that fall between pixels.
const HERO_TARGET_BINS = 100;
const SURVEY_SAMPLES: SurveySample[] = (() => {
  if (RAW_SAMPLES.length <= HERO_TARGET_BINS) return RAW_SAMPLES;
  const stride = RAW_SAMPLES.length / HERO_TARGET_BINS;
  const out: SurveySample[] = [];
  for (let i = 0; i < HERO_TARGET_BINS; i++) {
    out.push(RAW_SAMPLES[Math.min(RAW_SAMPLES.length - 1, Math.round(i * stride))]);
  }
  return out;
})();
const SURVEY_TB_K: number[] = SURVEY_SAMPLES.map(sample => sample.tbK);
const SURVEY_FREQ_MHZ: number[] = SURVEY_SAMPLES.map(sample => sample.freqMhz);

// Normalize to [0, 1] for the SVG mapping; the receiver-noise animation layers
// on top of this baseline shape per frame.
const SURVEY_PEAK_K = SURVEY_TB_K.reduce((m, v) => (v > m ? v : m), 0);
export const SURVEY_POWER: number[] = SURVEY_TB_K.map((v) => Math.max(0, v) / SURVEY_PEAK_K);

// Frequency-axis mapping. Display range hugs the supplied data span with
// enough padding to land round-numbered tick labels on the axis.
export const H1_REST_MHZ = 1420.4058;
const DISPLAY_TICK_STEP_MHZ = 0.2;
const DISPLAY_MIN_SIGNAL_K = 0.02;
const DISPLAY_PAD_MHZ = 0.04;
const DISPLAY_SIGNAL_FREQ_MHZ = SURVEY_SAMPLES
  .filter(sample => sample.tbK >= DISPLAY_MIN_SIGNAL_K)
  .map(sample => sample.freqMhz);
const DISPLAY_MIN_MHZ =
  Math.min(...DISPLAY_SIGNAL_FREQ_MHZ) - DISPLAY_PAD_MHZ;
const DISPLAY_MAX_MHZ =
  Math.max(...DISPLAY_SIGNAL_FREQ_MHZ) + DISPLAY_PAD_MHZ;
const DISPLAY_SPAN_MHZ = DISPLAY_MAX_MHZ - DISPLAY_MIN_MHZ;
// Higher frequency on the left (blueshifted), lower on the right (redshifted)
// — the standard convention used by SDR spectrum tools.
export const fToX = (f: number) => ((DISPLAY_MAX_MHZ - f) / DISPLAY_SPAN_MHZ) * HW;
const indexToX = (i: number) => fToX(SURVEY_FREQ_MHZ[i]);
const SURVEY_X_START = indexToX(0);
const SURVEY_X_END   = indexToX(SURVEY_TB_K.length - 1);
export const SURVEY_DOPPLER_PEAK_X = (() => {
  let idx = 0;
  for (let i = 0; i < SURVEY_POWER.length; i++) {
    const isBlueShifted = SURVEY_FREQ_MHZ[i] > H1_REST_MHZ + 0.05;
    if (isBlueShifted && SURVEY_POWER[i] > SURVEY_POWER[idx]) idx = i;
  }
  return indexToX(idx);
})();
export const [SURVEY_MAIN_PEAK_X, SURVEY_MAIN_PEAK_Y] = (() => {
  let idx = 0;
  for (let i = 0; i < SURVEY_POWER.length; i++) {
    if (SURVEY_POWER[i] > SURVEY_POWER[idx]) idx = i;
  }
  return [indexToX(idx), HERO_BASE_Y - SURVEY_POWER[idx] * HERO_PEAK_PX];
})();
export const SURVEY_MAIN_PEAK_RATIO = SURVEY_MAIN_PEAK_X / HW;

// Frequency tick labels placed at round intervals across the display.
const FIRST_FREQ_TICK_MHZ = Math.ceil(DISPLAY_MIN_MHZ / DISPLAY_TICK_STEP_MHZ) * DISPLAY_TICK_STEP_MHZ;
const LAST_FREQ_TICK_MHZ = Math.floor(DISPLAY_MAX_MHZ / DISPLAY_TICK_STEP_MHZ) * DISPLAY_TICK_STEP_MHZ;
export const FREQ_TICKS_MHZ = Array.from(
  { length: Math.round((LAST_FREQ_TICK_MHZ - FIRST_FREQ_TICK_MHZ) / DISPLAY_TICK_STEP_MHZ) + 1 },
  (_, i) => FIRST_FREQ_TICK_MHZ + i * DISPLAY_TICK_STEP_MHZ,
);

// X-coordinates are a pure function of bin index and never change at runtime,
// so we precompute them (and the corresponding pre-formatted "x," prefix
// string used by the path builder) once instead of recomputing every frame.
const SURVEY_X_PX: Float32Array = (() => {
  const out = new Float32Array(SURVEY_FREQ_MHZ.length);
  for (let i = 0; i < SURVEY_FREQ_MHZ.length; i++) out[i] = indexToX(i);
  return out;
})();
const SURVEY_X_PREFIX: string[] = Array.from(SURVEY_X_PX, x => `${x.toFixed(1)},`);
const SURVEY_X_START_STR = SURVEY_X_START.toFixed(1);
const SURVEY_X_END_STR = SURVEY_X_END.toFixed(1);

// Build the SVG path data for one playback frame. `smoothed` is the current
// (noisy, integrating) power-per-bin estimate; we walk it across HW pixels and
// emit a polyline path plus a matching filled-area path.
export function buildHeroPaths(smoothed: Float32Array): { line: string; fill: string } {
  const n = smoothed.length;
  let pts = '';
  for (let i = 0; i < n; i++) {
    const y = HERO_BASE_Y - smoothed[i] * HERO_PEAK_PX;
    pts += (i === 0 ? '' : ' L ') + SURVEY_X_PREFIX[i] + y.toFixed(1);
  }
  const line = `M ${pts}`;
  // The fill anchors to the baseline at the data's own x bounds, not the SVG
  // edges, so the gradient doesn't smear out into the blank wings.
  const fill = `M ${SURVEY_X_START_STR},${HERO_BASE_Y} L ${pts} L ${SURVEY_X_END_STR},${HERO_BASE_Y} Z`;
  return { line, fill };
}

// Box-Muller-ish cheap noise. We don't need true Gaussian — just symmetric,
// zero-mean fluctuations that look like SDR receiver noise on a quiet band.
export function noiseSample(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) * (2 / 3);
}

export function deterministicNoise(seed: number, timeSeconds: number): number {
  const a = Math.sin(seed * 12.9898 + 78.233);
  const b = Math.sin(seed * 39.3467 + 11.135);
  const c = Math.sin(seed * 73.1562 + 42.798);
  return (
    Math.sin(timeSeconds * 11.0 + a * Math.PI) * 0.50 +
    Math.sin(timeSeconds * 18.0 + b * Math.PI) * 0.30 +
    Math.sin(timeSeconds * 29.0 + c * Math.PI) * 0.20
  );
}
