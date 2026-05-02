export type ConnectionMode = 'serial' | 'simulated' | 'error';
export type ArgType = 'u8' | 'u16' | 's16' | 'u32' | 's32' | 'bool';

export interface ConnectionStatus {
  mode: ConnectionMode;
  port: string;
  baudrate: number;
  address: number;
  connected: boolean;
  message: string | null;
}

export interface MotorSnapshot {
  command: number;
  pwm: number | null;
  current_a: number | null;
  encoder: number | null;
  encoder_status: number | null;
  speed_qpps: number | null;
  raw_speed_qpps: number | null;
  average_speed_qpps: number | null;
  speed_error_qpps: number | null;
  position_error: number | null;
}

export interface RoboClawTelemetry {
  connection: ConnectionStatus;
  timestamp: number;
  firmware: string | null;
  main_battery_v: number | null;
  logic_battery_v: number | null;
  temperature_c: number | null;
  temperature_2_c: number | null;
  status: number | null;
  status_flags: string[];
  buffer_depths: Record<string, number | null>;
  encoder_modes: Record<string, number | null>;
  motors: Record<string, MotorSnapshot>;
  last_error: string | null;
}

export interface CommandArg {
  name: string;
  type: ArgType;
  label: string;
  min: number | null;
  max: number | null;
  default: number | boolean | null;
}

export interface CommandInfo {
  id: string;
  name: string;
  group: string;
  description: string;
  command: number;
  kind: 'read' | 'write' | 'motion' | 'config';
  dangerous: boolean;
  args: CommandArg[];
}

export interface CommandResult {
  command_id: string;
  ok: boolean;
  response: Record<string, unknown>;
  error: string | null;
}
