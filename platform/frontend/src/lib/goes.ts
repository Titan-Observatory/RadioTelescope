// Small pure helpers for the GOES observation mode UI. Look angles come from
// the backend (/api/observation computes them for the configured observer);
// the frontend only needs the separation between where the dish points and
// where the satellite sits.

import type { GoesStage } from '../types';

export function angularSeparationDeg(
  alt1Deg: number, az1Deg: number, alt2Deg: number, az2Deg: number,
): number {
  const d = Math.PI / 180;
  const a1 = alt1Deg * d;
  const a2 = alt2Deg * d;
  const dz = (az2Deg - az1Deg) * d;
  const cosSep = Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(dz);
  return Math.acos(Math.max(-1, Math.min(1, cosSep))) / d;
}

// Acquisition ladder shown as a stepper in the connect panel. `rank` orders
// the stages so earlier steps light up once a later one is reached.
export const GOES_STAGES: Array<{ id: GoesStage; label: string; hint: string }> = [
  { id: 'searching', label: 'Searching', hint: 'Aim the dish at the satellite and peak the SNR' },
  { id: 'signal', label: 'Signal', hint: 'Demodulator has a usable carrier' },
  { id: 'frames', label: 'Frame lock', hint: 'Synchronized to the downlink frame structure' },
  { id: 'data', label: 'Data', hint: 'Decoding products from the stream' },
];

export function stageRank(stage: GoesStage | undefined): number {
  if (!stage) return -1;
  return GOES_STAGES.findIndex((s) => s.id === stage);
}

// Names for the GOES HRIT virtual channels we care about; everything else
// renders as a plain channel number.
export const VC_NAMES: Record<string, string> = {
  '0': 'Admin / text',
  '1': 'Mesoscale imagery',
  '2': 'Full disk imagery',
  '20': 'EMWIN',
  '32': 'DCS relay',
};

export function formatKbps(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(2)} Mbps`;
  return `${kbps.toFixed(1)} kbps`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MiB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function formatAge(epochSeconds: number): string {
  const delta = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (delta < 60) return `${Math.round(delta)}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  return `${Math.round(delta / 3600)}h ago`;
}
