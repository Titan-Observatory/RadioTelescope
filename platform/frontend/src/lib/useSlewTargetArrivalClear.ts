import { useCallback, useEffect, useRef } from 'react';

import { normalizeDeg, unwrapDeg } from './astro';
import type { RoboClawTelemetry } from '../types';

const ARRIVAL_TOLERANCE_DEG = 0.15;
const TARGET_CHANGE_EPSILON_DEG = 0.001;
// A real geared mount routinely halts a few tenths short of the commanded
// position without ever overshooting, so the tight arrival tolerance alone
// never fires. Once the mount has actually moved and then come to rest within
// this looser band of the target, treat the slew as complete.
const SETTLE_TOLERANCE_DEG = 0.6;
// Mirrors the display deadband in formatters.ts: encoder/PWM jitter keeps a few
// QPPS on the wire while the controller is stopped.
const MOTOR_SPEED_DEADBAND_QPPS = 25;

interface SlewTarget {
  alt: number;
  az: number;
  altArrived: boolean;
  azArrived: boolean;
  hasMoved: boolean;
  lastAltDelta: number | null;
  lastAzDelta: number | null;
}

export function useSlewTargetArrivalClear({
  hasMapTarget,
  targetAlt,
  targetAz,
  telemetry,
  clearTarget,
  stopMotion,
}: {
  hasMapTarget: boolean;
  targetAlt: number;
  targetAz: number;
  telemetry: RoboClawTelemetry | null;
  clearTarget: () => void;
  stopMotion: () => void;
}): (alt: number, az: number) => void {
  const submittedRef = useRef<SlewTarget | null>(null);

  useEffect(() => {
    const submitted = submittedRef.current;
    if (!hasMapTarget || submitted == null) {
      submittedRef.current = null;
      return;
    }
    if (
      Math.abs(targetAlt - submitted.alt) > TARGET_CHANGE_EPSILON_DEG ||
      Math.abs(shortestAzDelta(targetAz, submitted.az)) > TARGET_CHANGE_EPSILON_DEG
    ) {
      submittedRef.current = null;
    }
  }, [hasMapTarget, targetAlt, targetAz]);

  useEffect(() => {
    const submitted = submittedRef.current;
    if (!hasMapTarget || submitted == null || telemetry?.altitude_deg == null || telemetry.azimuth_deg == null) {
      return;
    }

    const altDelta = telemetry.altitude_deg - submitted.alt;
    const azDelta = shortestAzDelta(telemetry.azimuth_deg, submitted.az);
    const altArrived = submitted.altArrived || axisReached(altDelta, submitted.lastAltDelta);
    const azArrived = submitted.azArrived || axisReached(azDelta, submitted.lastAzDelta);

    // m1 = azimuth, m2 = elevation. Track whether the mount has actually begun
    // moving so a transient idle reading on the first tick (before the
    // controller ramps up) can't be mistaken for "already settled".
    const moving =
      isMoving(telemetry.motors?.m1?.speed_qpps) || isMoving(telemetry.motors?.m2?.speed_qpps);
    const hasMoved = submitted.hasMoved || moving;
    const settledNearTarget =
      hasMoved && !moving &&
      Math.abs(altDelta) <= SETTLE_TOLERANCE_DEG &&
      Math.abs(azDelta) <= SETTLE_TOLERANCE_DEG;

    if ((altArrived && azArrived) || settledNearTarget) {
      submittedRef.current = null;
      stopMotion();
      clearTarget();
      return;
    }

    submittedRef.current = {
      ...submitted,
      altArrived,
      azArrived,
      hasMoved,
      lastAltDelta: altDelta,
      lastAzDelta: azDelta,
    };
    // Keyed on `timestamp` (not just alt/az): once the mount halts its position
    // stops changing, but we still need ticks to observe the motors go idle.
  }, [clearTarget, stopMotion, hasMapTarget, telemetry?.timestamp]);

  return useCallback((alt: number, az: number) => {
    submittedRef.current = {
      alt,
      az: normalizeDeg(az),
      altArrived: false,
      azArrived: false,
      hasMoved: false,
      lastAltDelta: null,
      lastAzDelta: null,
    };
  }, []);
}

function axisReached(delta: number, lastDelta: number | null): boolean {
  if (Math.abs(delta) <= ARRIVAL_TOLERANCE_DEG) return true;
  return lastDelta != null && ((lastDelta < 0 && delta > 0) || (lastDelta > 0 && delta < 0));
}

function isMoving(speedQpps: number | null | undefined): boolean {
  return Math.abs(speedQpps ?? 0) > MOTOR_SPEED_DEADBAND_QPPS;
}

function shortestAzDelta(fromAz: number, toAz: number): number {
  return unwrapDeg(fromAz, toAz) - toAz;
}
