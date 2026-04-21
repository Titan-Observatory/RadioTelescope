// Types mirror radiotelescope Pydantic models (models/state.py, models/commands.py)

export type Axis = 'azimuth' | 'elevation';
export type Direction = 'forward' | 'reverse';
export type MotorDirection = Direction | 'stopped';
export type Gain = number | 'auto';

export interface MotorState {
  axis: string;
  duty: number;
  direction: MotorDirection;
  is_moving: boolean;
}

export interface SensorReading {
  bus_voltage_v: number;
  shunt_voltage_mv: number;
  current_a: number;
  power_w: number;
  timestamp: number;
  available: boolean;
}

export interface SafetyStatus {
  overcurrent_tripped: boolean;
  last_trip_timestamp: number | null;
}

export interface TelescopeState {
  motors: Record<string, MotorState>;
  sensor: SensorReading;
  safety: SafetyStatus;
  uptime_s: number;
}

export interface SpectrumFrame {
  timestamp: number;
  center_freq_hz: number;
  bandwidth_hz: number;
  magnitudes_b64: string;
  rolling_b64: string;
  integration_s: number;
  frame_count: number;
}

export interface SDRStatus {
  running: boolean;
  center_freq_hz: number;
  sample_rate_hz: number;
  gain: Gain;
  fft_size: number;
  integration_count: number;
  rolling_window_s: number;
}

export interface SessionStatus {
  active: boolean;
  client_id: string | null;
  claimed_at: number | null;
  expires_at: number | null;
}

export interface MotorAxisConfig {
  max_duty: number;
  ramp_time_s: number;
}

export interface SafetyConfig {
  overcurrent_threshold_a: number;
  overcurrent_holdoff_s: number;
  azimuth_min_deg: number;
  azimuth_max_deg: number;
  elevation_min_deg: number;
  elevation_max_deg: number;
}

export interface SDRConfig {
  center_freq_hz: number;
  sample_rate_hz: number;
  gain: Gain;
  fft_size: number;
  integration_count: number;
}

export interface AppConfigDump {
  safety: SafetyConfig;
  sdr: SDRConfig;
  motors: { azimuth: MotorAxisConfig; elevation: MotorAxisConfig };
}

export interface MoveCommand {
  axis: Axis;
  speed: number;
  direction: Direction;
}

export interface StopCommand {
  axis?: Axis;
}
