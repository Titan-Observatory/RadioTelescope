export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function formatFreq(hz: number, precision = 3): string {
  return `${(hz / 1e6).toFixed(precision)} MHz`;
}

export function formatRate(hz: number, precision = 3): string {
  return `${(hz / 1e6).toFixed(precision)} MS/s`;
}

export function formatGain(gain: number | string): string {
  return gain === 'auto' ? 'auto' : `${gain} dB`;
}

export function decodeSpectrum(b64: string): Float32Array {
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return new Float32Array(buf.buffer);
}
