import { H1_REST_MHZ, displayWindow } from './spectrum';
import type { SpectrumFrame } from './spectrumTypes';

// ±0.5 MHz around the rest line corresponds to ≈ ±105 km/s of Doppler shift,
// which covers the bulk of Galactic neutral-hydrogen velocities visible from
// the northern hemisphere. Wider than this and the marker band stops being
// useful as a "look here" hint.
const H1_SEARCH_HALF_WIDTH_MHZ = 0.5;
const SPEED_OF_LIGHT_KMS = 299792.458;

// Minimum prominence (dB above the spectrum median) before we report a peak
// as a hydrogen detection. Below this the "peak" is just the tallest noise
// bin, and quoting a velocity for it would be misleading.
const DETECTION_MIN_DB = 1.5;

const RFI_LABEL_MIN_GAP_PCT = 4;
const RFI_LABEL_MAX_COUNT = 8;

export interface SpectrumDetection {
  freqMhz: number;
  peakDb: number;
  prominenceDb: number;
  velocityKms: number;
  detected: boolean;
}

export interface RfiMarker {
  key: string;
  leftPct: number;
  left: string;
  bottom: string;
  showLabel: boolean;
}

export function computeIntegrationStats(frame: SpectrumFrame | null) {
  if (!frame) return null;
  const bins = frame.freqs_mhz.length;
  // Bin spacing from the axis itself, not sample_rate / bins — the backend
  // crops each frame to the displayed H I window, so the array no longer
  // spans the full sample rate.
  const binHz = bins > 1 ? (frame.freqs_mhz[1] - frame.freqs_mhz[0]) * 1e6 : 0;
  const frameHz = frame.frame_duration_s > 0 ? 1 / frame.frame_duration_s : 0;
  const effectiveFrames = Math.min(frame.frames_seen, frame.integration_frames);
  return {
    windowSeconds: frame.integration_seconds,
    effectiveFrames,
    targetFrames: frame.integration_frames,
    binHz,
    frameHz,
  };
}

export function computeHydrogenGuide(frame: SpectrumFrame | null) {
  if (!frame) return null;
  const win = displayWindow(frame);
  if (!win) return null;
  const { xMin, xMax } = win;
  const span = xMax - xMin;
  if (span <= 0 || H1_REST_MHZ < xMin || H1_REST_MHZ > xMax) return null;
  const toPct = (mhz: number) => `${Math.max(0, Math.min(100, ((mhz - xMin) / span) * 100))}%`;
  return {
    lineLeft: toPct(H1_REST_MHZ),
  };
}

// Live interpretation of the spectrum: the strongest bin inside the H I
// search band, its height above the spectrum median, and the Doppler velocity
// that frequency offset corresponds to. This is the readout that turns "a bump
// on a chart" into "gas receding at 40 km/s".
export function computeDetection(
  frame: SpectrumFrame | null,
  displayed: number[] | null,
): SpectrumDetection | null {
  if (!frame || !displayed || frame.freqs_mhz.length < 16) return null;
  const freqs = frame.freqs_mhz;
  let peakIdx = -1;
  let peakDb = -Infinity;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    if (f < H1_REST_MHZ - H1_SEARCH_HALF_WIDTH_MHZ || f > H1_REST_MHZ + H1_SEARCH_HALF_WIDTH_MHZ) continue;
    if (displayed[i] > peakDb) {
      peakDb = displayed[i];
      peakIdx = i;
    }
  }
  if (peakIdx < 0) return null;
  const sorted = Float64Array.from(displayed).sort();
  const medianDb = sorted[sorted.length >> 1];
  const prominenceDb = peakDb - medianDb;
  const freqMhz = freqs[peakIdx];
  // Positive radial velocity = receding (peak redshifted below rest).
  const velocityKms = SPEED_OF_LIGHT_KMS * (H1_REST_MHZ - freqMhz) / H1_REST_MHZ;
  return { freqMhz, peakDb, prominenceDb, velocityKms, detected: prominenceDb >= DETECTION_MIN_DB };
}

export function computeRfiGuide(
  frame: SpectrumFrame | null,
  displayed: number[] | null,
  yRange: [number, number],
): RfiMarker[] {
  if (!frame?.rfi_bands?.length || !displayed?.length) return [];
  const win = displayWindow(frame);
  if (!win) return [];
  const { xMin, xMax } = win;
  const span = xMax - xMin;
  if (span <= 0) return [];
  const [yMin, yMax] = yRange;
  if (yMax <= yMin) return [];
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const markers = frame.rfi_bands
    .map(([lo, hi]) => {
      const visibleLo = Math.max(lo, xMin);
      const visibleHi = Math.min(hi, xMax);
      if (visibleHi < visibleLo) return null;
      const center = (visibleLo + visibleHi) / 2;
      let closestIdx = 0;
      let closestDistance = Infinity;
      for (let i = 0; i < frame.freqs_mhz.length; i++) {
        const distance = Math.abs(frame.freqs_mhz[i] - center);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIdx = i;
        }
      }
      const traceTop = clamp(((yMax - displayed[closestIdx]) / (yMax - yMin)) * 100);
      const leftPct = clamp(((center - xMin) / span) * 100);
      return {
        key: `${lo.toFixed(6)}-${hi.toFixed(6)}`,
        leftPct,
        left: `${leftPct}%`,
        bottom: `${clamp(100 - traceTop)}%`,
      };
    })
    .filter((marker): marker is { key: string; leftPct: number; left: string; bottom: string } => marker !== null)
    .sort((a, b) => a.leftPct - b.leftPct);

  let lastLabelPct = -Infinity;
  let labelCount = 0;
  return markers.map((marker) => {
    const showLabel =
      labelCount < RFI_LABEL_MAX_COUNT &&
      marker.leftPct - lastLabelPct >= RFI_LABEL_MIN_GAP_PCT;
    if (showLabel) {
      lastLabelPct = marker.leftPct;
      labelCount += 1;
    }
    return { ...marker, showLabel };
  });
}

// Pin a small marker on the trace at the detected peak. Positions are
// percentages within the plot inset box (the same box the hydrogen guide
// occupies), so the marker tracks the peak as the axis refits.
export function computePeakMarker(
  frame: SpectrumFrame | null,
  detection: SpectrumDetection | null,
  hydrogenGuide: { lineLeft: string } | null,
  yRange: [number, number],
): { left: string; top: string } | null {
  if (!frame || !detection?.detected || !hydrogenGuide) return null;
  const peakWindow = displayWindow(frame);
  if (!peakWindow) return null;
  const { xMin, xMax } = peakWindow;
  const span = xMax - xMin;
  const [yMin, yMax] = yRange;
  if (span <= 0 || yMax <= yMin) return null;
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  return {
    left: `${clamp(((detection.freqMhz - xMin) / span) * 100)}%`,
    top: `${clamp(((yMax - detection.peakDb) / (yMax - yMin)) * 100)}%`,
  };
}
