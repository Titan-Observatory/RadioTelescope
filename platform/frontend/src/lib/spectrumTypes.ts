// Shared shapes for the live spectrum view, consumed by the SpectrumPanel
// component plus its extracted detection/chart/waterfall helpers.

export interface SpectrumFrame {
  timestamp: number;
  center_freq_mhz: number;
  sample_rate_mhz: number;
  integration_frames: number;
  frames_seen: number;
  frame_duration_s: number;
  integration_seconds: number;
  mode: string;
  freqs_mhz: number[];
  power_db: number[];
  // [lo_mhz, hi_mhz] frequency bands flagged as narrowband RFI by the hardware.
  // The trace is left intact; the frontend shades these so viewers can discount
  // them by eye rather than having them silently scrubbed.
  rfi_bands?: number[][];
  baseline_corrected?: boolean;
}

export interface SpectrumStatus {
  enabled: boolean;
  mode: string;
  center_freq_mhz?: number;
  sample_rate_mhz?: number;
  fft_size?: number;
  integration_frames?: number;
  publish_rate_hz?: number;
  latest_timestamp?: number | null;
  latest_frame_age_s?: number | null;
  latest_frames_seen?: number;
  subscriber_count?: number;
}
