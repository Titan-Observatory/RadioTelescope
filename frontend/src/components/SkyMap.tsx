import A from 'aladin-lite';
import { Info, Layers, Maximize2, Telescope } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { AltAzPoint, RaDecTarget, RoboClawTelemetry, SkyOverlay, TelescopeConfig } from '../types';

// ─── Camera PIP ───────────────────────────────────────────────────────────────

function CameraPip({ swapped, onToggleSwap }: { swapped: boolean; onToggleSwap: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [label, setLabel] = useState('Cam A');
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/camera/status')
      .then((r) => r.json())
      .then((d: { enabled: boolean; label: string }) => {
        setEnabled(d.enabled);
        setLabel(d.label);
      })
      .catch(() => {/* non-critical */});
  }, []);

  if (!enabled) return null;

  return (
    <div className={`cam-pip${error ? ' cam-pip-error' : ''}${swapped ? ' cam-pip-swapped' : ''}`}>
      <img
        className="cam-pip-feed"
        src="/api/camera/stream"
        alt="Camera feed"
        onError={() => {
          setError(true);
          setEnabled(false);
        }}
        onLoad={() => setError(false)}
      />
      {error ? (
        <div className="cam-pip-offline">No signal</div>
      ) : (
        <div className="cam-pip-live"><span className="cam-pip-dot" />LIVE</div>
      )}
      <button
        type="button"
        className="cam-pip-fullscreen"
        onClick={onToggleSwap}
        title={swapped ? 'Restore sky map' : 'Swap with sky map'}
        aria-label={swapped ? 'Restore sky map' : 'Swap with sky map'}
        aria-pressed={swapped}
      >
        <Maximize2 size={13} />
      </button>
      <div className="cam-pip-label">{label}</div>
    </div>
  );
}

// ─── Astronomy math ───────────────────────────────────────────────────────────
const D = Math.PI / 180;
const R = 180 / Math.PI;

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function unwrapDeg(deg: number, reference: number): number {
  let value = deg;
  while (value - reference > 180) value -= 360;
  while (value - reference < -180) value += 360;
  return value;
}

function gmstDeg(date: Date): number {
  const jd = date.getTime() / 86_400_000 + 2_440_587.5;
  const d = jd - 2_451_545.0;
  return normalizeDeg(280.46061837 + 360.98564736629 * d);
}

function localSiderealDeg(config: TelescopeConfig, date: Date): number {
  return normalizeDeg(gmstDeg(date) + config.observer_longitude_deg);
}

function raDecToAltAz(
  ra_deg: number,
  dec_deg: number,
  config: TelescopeConfig,
  date: Date,
): AltAzPoint {
  const lat = config.observer_latitude_deg * D;
  const dec = dec_deg * D;
  const hourAngle = normalizeDeg(localSiderealDeg(config, date) - ra_deg) * D;

  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(hourAngle);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const az = Math.atan2(
    -Math.sin(hourAngle),
    Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(hourAngle),
  );

  return {
    altitude_deg: alt * R,
    azimuth_deg: normalizeDeg(az * R),
  };
}

function altAzToRaDec(point: AltAzPoint, config: TelescopeConfig, date: Date): RaDecTarget {
  const lat = config.observer_latitude_deg * D;
  const alt = point.altitude_deg * D;
  const az = point.azimuth_deg * D;

  const sinDec = Math.sin(alt) * Math.sin(lat) + Math.cos(alt) * Math.cos(lat) * Math.cos(az);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const hourAngle = Math.atan2(
    -Math.sin(az) * Math.cos(alt),
    Math.sin(alt) * Math.cos(lat) - Math.cos(alt) * Math.sin(lat) * Math.cos(az),
  );

  return {
    ra_deg: normalizeDeg(localSiderealDeg(config, date) - hourAngle * R),
    dec_deg: dec * R,
  };
}

function positionAngleDeg(from: RaDecTarget, to: RaDecTarget): number {
  const ra1 = from.ra_deg * D;
  const dec1 = from.dec_deg * D;
  const ra2 = to.ra_deg * D;
  const dec2 = to.dec_deg * D;
  const deltaRa = ra2 - ra1;
  const y = Math.sin(deltaRa);
  const x = Math.cos(dec1) * Math.tan(dec2) - Math.sin(dec1) * Math.cos(deltaRa);
  return normalizeDeg(Math.atan2(y, x) * R);
}

function localUpOrientationDeg(center: RaDecTarget, config: TelescopeConfig, date: Date): number {
  const centerAltAz = raDecToAltAz(center.ra_deg, center.dec_deg, config, date);
  const upAlt = Math.min(89.5, centerAltAz.altitude_deg + 1);
  const localUp = altAzToRaDec(
    { altitude_deg: upAlt, azimuth_deg: centerAltAz.azimuth_deg },
    config,
    date,
  );
  return positionAngleDeg(center, localUp);
}

function initialHorizonRotationDeg(center: RaDecTarget, config: TelescopeConfig, date: Date): number {
  const rotation = normalizeDeg(360 - localUpOrientationDeg(center, config, date));
  return rotation === 0 ? 0.001 : rotation;
}

// ─── Solar / lunar position (low-precision, ~1° accuracy) ────────────────────

function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

function sunRaDec(date: Date): RaDecTarget {
  const d  = julianDay(date) - 2_451_545.0;
  const L  = normalizeDeg(280.460 + 0.9856474 * d);
  const g  = normalizeDeg(357.528 + 0.9856003 * d) * D;
  const λ  = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D;
  const ε  = (23.439 - 0.0000004 * d) * D;
  return {
    ra_deg:  normalizeDeg(Math.atan2(Math.cos(ε) * Math.sin(λ), Math.cos(λ)) * R),
    dec_deg: Math.asin(Math.sin(ε) * Math.sin(λ)) * R,
  };
}

function moonRaDec(date: Date): RaDecTarget {
  const d   = julianDay(date) - 2_451_545.0;
  const L   = normalizeDeg(218.316 + 13.176396 * d);
  const M   = normalizeDeg(134.963 + 13.064993 * d) * D;
  const F   = normalizeDeg(93.272  + 13.229350 * d) * D;
  const lon = (L + 6.289 * Math.sin(M)) * D;
  const lat = 5.128 * Math.sin(F) * D;
  const ε   = (23.439 - 0.0000004 * d) * D;
  return {
    ra_deg: normalizeDeg(
      Math.atan2(Math.cos(ε) * Math.sin(lon) - Math.tan(lat) * Math.sin(ε), Math.cos(lon)) * R,
    ),
    dec_deg: Math.asin(
      Math.sin(lat) * Math.cos(ε) + Math.cos(lat) * Math.sin(ε) * Math.sin(lon),
    ) * R,
  };
}

/** Illuminated fraction (0 = new, 1 = full) and whether the moon is waxing. */
function moonIllumination(
  sun: RaDecTarget,
  moon: RaDecTarget,
): { fraction: number; waxing: boolean } {
  const sRa = sun.ra_deg * D, sDec = sun.dec_deg * D;
  const mRa = moon.ra_deg * D, mDec = moon.dec_deg * D;
  const elongation = Math.acos(
    Math.max(-1, Math.min(1,
      Math.sin(sDec) * Math.sin(mDec) + Math.cos(sDec) * Math.cos(mDec) * Math.cos(sRa - mRa),
    )),
  );
  return {
    fraction: (1 + Math.cos(elongation)) / 2,
    // Moon is waxing when it is 0–180° east of the sun
    waxing: normalizeDeg(moon.ra_deg - sun.ra_deg) < 180,
  };
}

// ─── Canvas body-icon helpers ─────────────────────────────────────────────────

/**
 * Draws the sun as an accurately-sized disc.
 * r is the pixel radius derived from the current Aladin projection so the
 * disc matches the sun's true ~0.53° angular diameter at whatever zoom level
 * the viewer is at.
 */
function drawSunIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  // Limb darkening: centre is near-white, edge deepens to amber
  const disc = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  disc.addColorStop(0,   '#fffde8');  // bright white-yellow core
  disc.addColorStop(0.55, '#ffe030'); // yellow mid-disc
  disc.addColorStop(1,   '#ffb000');  // amber limb
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fillStyle = disc;
  ctx.fill();
}

/**
 * Draws the moon disc with the correct phase shape.
 *
 * Uses the two-arc path technique: the lit region is bounded by an outer
 * semicircle on the lit side and the terminator ellipse arc on the other
 * side, then filled in a single path — no masking or composite ops needed.
 *
 * fraction : 0 = new moon, 1 = full moon
 * waxing   : true → lit on the right, false → lit on the left
 */
function drawMoonIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  fraction: number,
  waxing: boolean,
): void {
  const r = 9;

  // Subtle corona
  const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2.4);
  glow.addColorStop(0,   'rgba(200, 218, 255, 0.22)');
  glow.addColorStop(1,   'rgba(180, 200, 255, 0)');
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.4, 0, 2 * Math.PI);
  ctx.fillStyle = glow;
  ctx.fill();

  // c runs −1 (new) → 0 (quarter) → +1 (full)
  const c  = 2 * fraction - 1;
  // Half-width of the terminator ellipse; small epsilon avoids a degenerate arc
  const rx = Math.max(0.5, Math.abs(c) * r);

  // Dark disc — shadow side fill so the moon is opaque against the survey
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fillStyle = '#0c1a2e';
  ctx.fill();

  // ── Phase shape ───────────────────────────────────────────────────────────
  // Path: outer semicircle (lit side) + terminator ellipse arc (closing return).
  // For gibbous (c > 0): ellipse bulges toward the dark side → counterclockwise.
  // For crescent (c < 0): ellipse bulges toward the lit side → clockwise.
  // Both arcs run top→bottom then bottom→top so the path closes perfectly.

  ctx.beginPath();
  if (waxing) {
    // Lit on the right
    ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false);            // right semicircle ↓
    ctx.ellipse(cx, cy, rx, r, 0, Math.PI / 2, -Math.PI / 2, c > 0); // terminator ↑
  } else {
    // Lit on the left
    ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, true);             // left semicircle ↓
    ctx.ellipse(cx, cy, rx, r, 0, Math.PI / 2, -Math.PI / 2, c < 0); // terminator ↑
  }
  ctx.closePath();
  ctx.fillStyle = '#dde8ff';
  ctx.fill();

  // Disc outline — faint ring so a thin crescent or new moon is still locatable
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(180, 200, 255, 0.35)';
  ctx.lineWidth   = 1;
  ctx.stroke();
}

function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function isInsideTriangle(point: AltAzPoint, triangle: AltAzPoint[]): boolean {
  if (triangle.length !== 3) return true;

  const reference = triangle[0].azimuth_deg;
  const px = unwrapDeg(point.azimuth_deg, reference);
  const py = point.altitude_deg;
  const vertices = triangle.map((vertex) => ({
    x: unwrapDeg(vertex.azimuth_deg, reference),
    y: vertex.altitude_deg,
  }));
  const [a, b, c] = vertices;

  const sign = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
  ) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);

  const d1 = sign(px, py, a.x, a.y, b.x, b.y);
  const d2 = sign(px, py, b.x, b.y, c.x, c.y);
  const d3 = sign(px, py, c.x, c.y, a.x, a.y);
  const hasNegative = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
  const hasPositive = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
  return !(hasNegative && hasPositive);
}

// â”€â”€â”€ Survey definitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SURVEYS = [
  {
    id: 'CDS/P/HI4PI/NHI',
    label: '21cm Hydrogen Line',
    title: 'HI4PI 21cm neutral hydrogen column density',
  },
  {
    id: 'CDS/P/Mellinger/color',
    label: 'Visible Light',
    title: 'Mellinger visible-light color all-sky survey',
  },
] as const;

type SurveyId = (typeof SURVEYS)[number]['id'];

const DEFAULT_HORIZON_VIEW: AltAzPoint = {
  altitude_deg: 15,
  azimuth_deg: 45,
};


// â”€â”€â”€ Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface SkyMapProps {
  telemetry: RoboClawTelemetry | null;
  config: TelescopeConfig | null;
  onNotice: (msg: string | null) => void;
  onTarget: (az: number, alt: number) => void;
  overlays?: SkyOverlay[];
}

export function SkyMap({ telemetry, config, onNotice, onTarget, overlays = [] }: SkyMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const aladinRef = useRef<ReturnType<typeof A.aladin> | null>(null);
  const configRef       = useRef<TelescopeConfig | null>(null);
  const telemetryRef    = useRef<RoboClawTelemetry | null>(null);
  const pendingRef      = useRef<RaDecTarget | null>(null);
  // Updated every draw frame so the hover handler can check without a loop
  const sunZoneRef      = useRef<{ cx: number; cy: number; r: number } | null>(null);
  const beamZoneRef     = useRef<{ cx: number; cy: number; r: number; fwhm: number } | null>(null);
  const pendingZoneRef  = useRef<{ cx: number; cy: number; r: number; fwhm: number } | null>(null);
  const beamOverlayRef = useRef<ReturnType<typeof A.graphicOverlay> | null>(null);
  const limitOverlayRef = useRef<ReturnType<typeof A.graphicOverlay> | null>(null);
  const pendingOverlayRef = useRef<ReturnType<typeof A.graphicOverlay> | null>(null);
  const horizonOverlayRef = useRef<ReturnType<typeof A.graphicOverlay> | null>(null);
  const horizonCanvasRef  = useRef<HTMLCanvasElement | null>(null);
  const targetCatalogRef = useRef<ReturnType<typeof A.catalog> | null>(null);
  const initializedRef = useRef(false);
  const onTargetRef = useRef<((az: number, alt: number) => void) | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<RaDecTarget | null>(null);
  const [survey, setSurvey] = useState<SurveyId>('CDS/P/HI4PI/NHI');
  const [tooltipsEnabled, setTooltipsEnabled] = useState(true);
  const [cameraSwapped, setCameraSwapped] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<
    | { kind: 'sun' | 'beam' | 'pending'; x: number; y: number; fwhm?: number }
    | null
  >(null);

  useEffect(() => { configRef.current    = config;    }, [config]);
  useEffect(() => { telemetryRef.current = telemetry; }, [telemetry]);
  useEffect(() => { pendingRef.current   = pending;   }, [pending]);
  useEffect(() => { onTargetRef.current  = onTarget;  }, [onTarget]);

  // Initialise Aladin Lite once
  useEffect(() => {
    if (!containerRef.current || !config || initializedRef.current) return;
    initializedRef.current = true;
    const container = containerRef.current;
    let cancelled = false;
    let removeClickHandler: (() => void) | null = null;

    void A.init.then(() => {
      if (cancelled || !container) return;
      const initialDate = new Date();
      const initialTarget = altAzToRaDec(DEFAULT_HORIZON_VIEW, config, initialDate);
      const initialRotation = initialHorizonRotationDeg(initialTarget, config, initialDate);

      const aladin = A.aladin(container, {
        survey: 'CDS/P/HI4PI/NHI',
        fov: 80,
        target: `${initialTarget.ra_deg} ${initialTarget.dec_deg}`,
        cooFrame: 'equatorial',  // equatorial coords, view centred on NE horizon
        projection: 'STG',       // stereographic — natural perspective
        showCooGrid: false,      // we draw our own alt/az grid below for a horizon-aligned look
        showReticle: false,
        showZoomControl: false,
        showFov: false,
        showFullscreenControl: false,
        showLayersControl: false,
        showGotoControl: false,
        showStatusBar: false,
        showFrame: false,
        showCooLocation: false,
        showProjectionControl: false,
      });
      aladin.setRotation(initialRotation);

      // Overlays — horizon drawn first so it sits under everything else
      const horizonOverlay = A.graphicOverlay({ color: 'rgba(255,126,89,0.7)', lineWidth: 2 });
      const beamOverlay    = A.graphicOverlay({ color: 'rgba(114,224,173,0.85)', lineWidth: 2 });
      const limitOverlay   = A.graphicOverlay({ color: 'rgba(255,126,89,0.85)', lineWidth: 2 });
      const pendingOverlay = A.graphicOverlay({ color: '#f3cc6b', lineWidth: 1.5 });
      aladin.addOverlay(horizonOverlay);
      aladin.addOverlay(limitOverlay);
      aladin.addOverlay(beamOverlay);
      aladin.addOverlay(pendingOverlay);


      const targetCatalog = A.catalog({
        name: 'Targets',
        color: '#f3cc6b',
        sourceSize: 10,
        shape: 'circle',
        displayLabel: true,
        labelColor: '#f3cc6b',
        labelFont: '11px Inter, sans-serif',
      });
      aladin.addCatalog(targetCatalog);

      aladinRef.current = aladin;
      beamOverlayRef.current    = beamOverlay;
      limitOverlayRef.current   = limitOverlay;
      pendingOverlayRef.current = pendingOverlay;
      horizonOverlayRef.current = horizonOverlay;
      targetCatalogRef.current  = targetCatalog;
      setReady(true);

      // Click: pix2world returns [ra, dec] in equatorial mode, so use it directly.
      const handleClick = (e: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const coords = aladin.pix2world(e.clientX - rect.left, e.clientY - rect.top);
        if (!coords || coords.length !== 2 || !isFinite(coords[0]) || !isFinite(coords[1])) return;

        const ra_deg = coords[0];
        const dec_deg = coords[1];
        const currentConfig = configRef.current;
        if (!currentConfig) return;

        const altAz = raDecToAltAz(ra_deg, dec_deg, currentConfig, new Date());

        // In simulated mode skip all limit checks — no hardware to protect
        const isSimulated = telemetryRef.current?.connection.mode === 'simulated';
        if (!isSimulated) {
          if (altAz.altitude_deg < 0) {
            onNotice('Selected point is below the horizon.');
            return;
          }
          if (currentConfig.pointing_limit_altaz.length === 3 &&
              !isInsideTriangle(altAz, currentConfig.pointing_limit_altaz)) {
            setPending(null);
            onNotice('Selected target is outside configured pointing limits.');
            return;
          }
        }

        onNotice(null);
        setPending({ ra_deg, dec_deg });
        onTargetRef.current?.(altAz.azimuth_deg, altAz.altitude_deg);
      };
      container.addEventListener('click', handleClick);
      removeClickHandler = () => container.removeEventListener('click', handleClick);
    });

    return () => {
      cancelled = true;
      removeClickHandler?.();
    };
  }, [config, onNotice]);

  // Change survey
  useEffect(() => {
    if (!ready || !aladinRef.current) return;
    if (survey === 'CDS/P/HI4PI/NHI') {
      aladinRef.current.setImageLayer(
        A.imageHiPS('CDS/P/HI4PI/NHI', {
          name: 'HI4PI colorized hydrogen line',
          colormap: 'inferno',
          stretch: 'asinh',
        }),
      );
      return;
    }

    aladinRef.current.setImageSurvey(survey);
  }, [survey, ready]);

  // Cardinal labels and horizon line are drawn by the canvas overlay below.
  // Clear the Aladin graphic overlay so it doesn't add noise.
  useEffect(() => {
    if (!ready || !horizonOverlayRef.current) return;
    horizonOverlayRef.current.removeAll();
  }, [ready]);

  // Canvas horizon overlay — ground fill + horizon line, tracks pan/zoom via rAF.
  // To swap in a real panorama, replace the fillStyle block with ctx.drawImage(panoramaImg, …)
  // mapped to the same clipping polygon.
  useEffect(() => {
    if (!ready || !config) return;
    const canvas = horizonCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // Cache horizon + alt/az grid RA/Dec samples (recomputed every ~30 s as Earth rotates)
    let horizonRaDec: RaDecTarget[] = [];
    // Almucantars: rings of constant altitude, sampled around the full azimuth range
    let almucantars: { altitude_deg: number; samples: RaDecTarget[] }[] = [];
    // Meridians: lines of constant azimuth, sampled from horizon to zenith
    let meridians: { azimuth_deg: number; samples: RaDecTarget[] }[] = [];
    let lastSampleTime = -Infinity;

    const ALT_RINGS = [15, 30, 45, 60, 75];
    const AZ_LINES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

    const refreshHorizonSamples = () => {
      const date = new Date();
      horizonRaDec = [];
      for (let az = 0; az < 360; az += 2) {
        horizonRaDec.push(altAzToRaDec({ altitude_deg: 0, azimuth_deg: az }, config, date));
      }
      almucantars = ALT_RINGS.map((alt) => {
        const samples: RaDecTarget[] = [];
        for (let az = 0; az < 360; az += 4) {
          samples.push(altAzToRaDec({ altitude_deg: alt, azimuth_deg: az }, config, date));
        }
        return { altitude_deg: alt, samples };
      });
      meridians = AZ_LINES.map((az) => {
        const samples: RaDecTarget[] = [];
        for (let alt = 0; alt <= 88; alt += 2) {
          samples.push(altAzToRaDec({ altitude_deg: alt, azimuth_deg: az }, config, date));
        }
        return { azimuth_deg: az, samples };
      });
      lastSampleTime = Date.now();
    };

    const drawProjectedPolyline = (
      ctx: CanvasRenderingContext2D,
      aladin: ReturnType<typeof A.aladin>,
      samples: RaDecTarget[],
      wrap: boolean,
      w: number,
      h: number,
    ) => {
      // Project to pixels, splitting into segments wherever:
      //  (a) a sample is off-screen / unprojectable, or
      //  (b) two consecutive samples are absurdly far apart in pixels (the
      //      projection wrapped behind us — connecting them would streak).
      const margin = 40;
      const maxSegmentPx = Math.max(w, h);
      let prev: [number, number] | null = null;
      let firstOnscreen: [number, number] | null = null;
      ctx.beginPath();
      for (const { ra_deg, dec_deg } of samples) {
        const p = aladin.world2pix(ra_deg, dec_deg);
        const offscreen = !p || !isFinite(p[0]) || !isFinite(p[1]) ||
          p[0] < -margin || p[0] > w + margin || p[1] < -margin || p[1] > h + margin;
        if (offscreen) { prev = null; continue; }
        const point = p as [number, number];
        if (prev == null || Math.hypot(point[0] - prev[0], point[1] - prev[1]) > maxSegmentPx) {
          ctx.moveTo(point[0], point[1]);
          if (firstOnscreen == null) firstOnscreen = point;
        } else {
          ctx.lineTo(point[0], point[1]);
        }
        prev = point;
      }
      // For closed shapes, only connect the last point back to the first if the
      // whole loop stayed on-screen (single sub-path) and the closing chord is short.
      if (wrap && prev && firstOnscreen &&
          Math.hypot(prev[0] - firstOnscreen[0], prev[1] - firstOnscreen[1]) < maxSegmentPx) {
        ctx.lineTo(firstOnscreen[0], firstOnscreen[1]);
      }
      ctx.stroke();
    };

    let frameId: number;
    let dashOffset = 0;

    const draw = () => {
      const date = new Date();
      if (Date.now() - lastSampleTime > 30_000) refreshHorizonSamples();

      const aladin = aladinRef.current;
      if (!aladin) { frameId = requestAnimationFrame(draw); return; }

      // Resize canvas to match container
      const rect = container.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width  = w;
        canvas.height = h;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) { frameId = requestAnimationFrame(draw); return; }
      ctx.clearRect(0, 0, w, h);

      // Project horizon samples from RA/Dec → canvas pixels
      const px: [number, number][] = [];
      for (const { ra_deg, dec_deg } of horizonRaDec) {
        const p = aladin.world2pix(ra_deg, dec_deg);
        if (p && isFinite(p[0]) && isFinite(p[1])) px.push([p[0], p[1]]);
      }

      if (px.length < 4) { frameId = requestAnimationFrame(draw); return; }

      // ── Ground fill ────────────────────────────────────────────────────────
      // Probe a point well below the horizon to decide which side of the
      // polygon is "ground". When the view rotates / pans so the projection
      // centre is below the horizon, the polygon's *interior* in screen space
      // becomes the ground; otherwise the *exterior* is ground.
      let groundIsInside = false;
      for (const probeAz of [180, 0, 90, 270]) {
        const probe = altAzToRaDec({ altitude_deg: -45, azimuth_deg: probeAz }, config, date);
        const pp = aladin.world2pix(probe.ra_deg, probe.dec_deg);
        if (pp && isFinite(pp[0]) && isFinite(pp[1])) {
          groundIsInside = pointInPolygon(pp[0], pp[1], px);
          break;
        }
      }

      ctx.beginPath();
      if (!groundIsInside) {
        // Fill area outside polygon (default: looking at the sky from above).
        ctx.rect(0, 0, w, h);
      }
      ctx.moveTo(px[0][0], px[0][1]);
      for (const [x, y] of px.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();

      // ── Panorama placeholder ───────────────────────────────────────────────
      // Replace this block with ctx.drawImage(yourPanoramaImg, …) once you
      // have a real image. The clipping polygon above will stay the same.
      ctx.fillStyle = 'rgba(18, 38, 14, 0.82)';
      ctx.fill('evenodd');

      // ── Alt/az grid (almucantars + meridians) ─────────────────────────────
      ctx.save();
      ctx.strokeStyle = 'rgba(114, 224, 173, 0.28)';
      ctx.lineWidth = 1;
      for (const ring of almucantars) {
        drawProjectedPolyline(ctx, aladin, ring.samples, true, w, h);
      }
      for (const meridian of meridians) {
        drawProjectedPolyline(ctx, aladin, meridian.samples, false, w, h);
      }

      // Almucantar altitude labels — placed at the south meridian (az = 180°)
      ctx.fillStyle    = 'rgba(114, 224, 173, 0.55)';
      ctx.font         = '10px Inter, system-ui, sans-serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'middle';
      for (const ring of almucantars) {
        const labelPos = altAzToRaDec({ altitude_deg: ring.altitude_deg, azimuth_deg: 180 }, config, date);
        const lp = aladin.world2pix(labelPos.ra_deg, labelPos.dec_deg);
        if (lp && isFinite(lp[0]) && isFinite(lp[1]) &&
            lp[0] >= 0 && lp[0] <= w && lp[1] >= 0 && lp[1] <= h) {
          ctx.fillText(`${ring.altitude_deg}°`, lp[0] + 4, lp[1]);
        }
      }
      ctx.restore();

      // ── Horizon line ───────────────────────────────────────────────────────
      ctx.beginPath();
      ctx.moveTo(px[0][0], px[0][1]);
      for (const [x, y] of px.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255, 126, 89, 0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // ── Cardinal direction labels ──────────────────────────────────────────
      // Drawn just below the horizon line so they sit in the ground fill.
      const cardinals = [
        { label: 'N',  az: 0,   bold: true  },
        { label: 'NE', az: 45,  bold: false },
        { label: 'E',  az: 90,  bold: true  },
        { label: 'SE', az: 135, bold: false },
        { label: 'S',  az: 180, bold: true  },
        { label: 'SW', az: 225, bold: false },
        { label: 'W',  az: 270, bold: true  },
        { label: 'NW', az: 315, bold: false },
      ];

      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';

      for (const { label, az, bold } of cardinals) {
        const { ra_deg: lRa, dec_deg: lDec } = altAzToRaDec(
          { altitude_deg: -4, azimuth_deg: az }, config, date,
        );
        const lp = aladin.world2pix(lRa, lDec);
        if (!lp || !isFinite(lp[0]) || !isFinite(lp[1])) continue;
        if (lp[0] < -30 || lp[0] > w + 30 || lp[1] < -30 || lp[1] > h + 30) continue;

        const fontSize = bold ? 14 : 11;
        ctx.font      = `${bold ? 'bold ' : ''}${fontSize}px Inter, system-ui, sans-serif`;
        // Subtle dark halo so labels read over both sky and ground
        ctx.lineWidth   = 3;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.strokeText(label, lp[0], lp[1]);
        ctx.fillStyle   = 'rgba(255, 126, 89, 0.92)';
        ctx.fillText(label, lp[0], lp[1]);
      }

      // ── Slew-path line ───────────────────────────────────────────────────
      const pendingTarget = pendingRef.current;
      const tel = telemetryRef.current;
      if (pendingTarget && tel) {
        // Resolve telescope RA/Dec via the same conversion the click handler uses,
        // so the line lands on the same pixel as the beam circle.
        let telRa: number | null = null;
        let telDec: number | null = null;
        if (tel.altitude_deg != null && tel.azimuth_deg != null) {
          const pt = altAzToRaDec({ altitude_deg: tel.altitude_deg, azimuth_deg: tel.azimuth_deg }, config, date);
          telRa  = pt.ra_deg;
          telDec = pt.dec_deg;
        } else {
          telRa  = tel.ra_deg  ?? null;
          telDec = tel.dec_deg ?? null;
        }

        if (telRa != null && telDec != null) {
          const pTel     = aladin.world2pix(telRa, telDec);
          const pPending = aladin.world2pix(pendingTarget.ra_deg, pendingTarget.dec_deg);

          if (pTel     && isFinite(pTel[0])     && isFinite(pTel[1]) &&
              pPending && isFinite(pPending[0])  && isFinite(pPending[1])) {
            dashOffset = (dashOffset + 0.4) % 22;

            ctx.save();
            ctx.setLineDash([7, 5]);
            ctx.lineDashOffset = -dashOffset;
            ctx.strokeStyle    = 'rgba(243, 204, 107, 0.75)';
            ctx.lineWidth      = 1.5;
            ctx.lineCap        = 'round';
            ctx.beginPath();
            ctx.moveTo(pTel[0],     pTel[1]);
            ctx.lineTo(pPending[0], pPending[1]);
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      // ── Sun & Moon ────────────────────────────────────────────────────────
      const sunPos  = sunRaDec(date);
      const moonPos = moonRaDec(date);
      const { fraction, waxing } = moonIllumination(sunPos, moonPos);

      // Sun pixel radius: project a point one solar radius (0.2655°) away in
      // declination and measure the pixel distance — accurate at any zoom level.
      const SUN_ANG_RADIUS_DEG  = 0.2655;
      const SUN_EXCLUSION_DEG   = 15;
      const pSunEdge      = aladin.world2pix(sunPos.ra_deg, sunPos.dec_deg + SUN_ANG_RADIUS_DEG);
      const pSunExclusion = aladin.world2pix(sunPos.ra_deg, sunPos.dec_deg + SUN_EXCLUSION_DEG);

      // Reset each frame so the hover handler sees null when sun is below horizon
      sunZoneRef.current = null;

      const bodies = [
        { pos: sunPos,  alt: raDecToAltAz(sunPos.ra_deg,  sunPos.dec_deg,  config, date).altitude_deg, isSun: true  },
        { pos: moonPos, alt: raDecToAltAz(moonPos.ra_deg, moonPos.dec_deg, config, date).altitude_deg, isSun: false },
      ];
      for (const body of bodies) {
        if (body.alt <= 0) continue;
        const p = aladin.world2pix(body.pos.ra_deg, body.pos.dec_deg);
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
        if (p[0] < -60 || p[0] > w + 60 || p[1] < -60 || p[1] > h + 60) continue;

        let iconR = 9; // fallback / moon fixed size
        if (body.isSun && pSunEdge && isFinite(pSunEdge[0]) && isFinite(pSunEdge[1])) {
          iconR = Math.max(3, Math.hypot(pSunEdge[0] - p[0], pSunEdge[1] - p[1]));

          // ── Solar exclusion zone ────────────────────────────────────────────
          if (pSunExclusion && isFinite(pSunExclusion[0]) && isFinite(pSunExclusion[1])) {
            const exclR = Math.hypot(pSunExclusion[0] - p[0], pSunExclusion[1] - p[1]);
            sunZoneRef.current = { cx: p[0], cy: p[1], r: exclR };

            const exclGrad = ctx.createRadialGradient(p[0], p[1], iconR, p[0], p[1], exclR);
            exclGrad.addColorStop(0,    'rgba(255, 130, 0, 0.38)');
            exclGrad.addColorStop(0.45, 'rgba(255, 100, 0, 0.18)');
            exclGrad.addColorStop(1,    'rgba(255,  70, 0, 0)');
            ctx.beginPath();
            ctx.arc(p[0], p[1], exclR, 0, 2 * Math.PI);
            ctx.fillStyle = exclGrad;
            ctx.fill();
          }

          drawSunIcon(ctx, p[0], p[1], iconR);
        } else if (!body.isSun) {
          drawMoonIcon(ctx, p[0], p[1], fraction, waxing);
        }

        // Label — sits just below the disc edge
        const label  = body.isSun ? 'Sun' : 'Moon';
        const colour = body.isSun ? '#ffd020' : '#c8d8ff';
        const labelY = p[1] + iconR + 4;
        ctx.font         = '11px Inter, system-ui, sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth    = 3;
        ctx.strokeStyle  = 'rgba(0, 0, 0, 0.6)';
        ctx.strokeText(label, p[0], labelY);
        ctx.fillStyle    = colour;
        ctx.fillText(label, p[0], labelY);
      }

      // ── FWHM ring hover zones ─────────────────────────────────────────────
      // Project ring centres + a point one FWHM/2 away in declination so the
      // pixel radius matches what Aladin draws for the overlay circles.
      const fwhmDeg = configRef.current?.beam_fwhm_deg ?? 6.5;
      beamZoneRef.current = null;
      const tel2 = telemetryRef.current;
      if (tel2?.altitude_deg != null && tel2?.azimuth_deg != null && configRef.current) {
        const beamRaDec = altAzToRaDec(
          { altitude_deg: tel2.altitude_deg, azimuth_deg: tel2.azimuth_deg },
          configRef.current, date,
        );
        const pCen = aladin.world2pix(beamRaDec.ra_deg, beamRaDec.dec_deg);
        const pEdge = aladin.world2pix(beamRaDec.ra_deg, beamRaDec.dec_deg + fwhmDeg / 2);
        if (pCen && pEdge && isFinite(pCen[0]) && isFinite(pEdge[0])) {
          beamZoneRef.current = {
            cx: pCen[0], cy: pCen[1],
            r: Math.max(6, Math.hypot(pEdge[0] - pCen[0], pEdge[1] - pCen[1])),
            fwhm: fwhmDeg,
          };
        }
      }

      pendingZoneRef.current = null;
      const pend = pendingRef.current;
      if (pend) {
        const pCen = aladin.world2pix(pend.ra_deg, pend.dec_deg);
        const pEdge = aladin.world2pix(pend.ra_deg, pend.dec_deg + fwhmDeg / 2);
        if (pCen && pEdge && isFinite(pCen[0]) && isFinite(pEdge[0])) {
          pendingZoneRef.current = {
            cx: pCen[0], cy: pCen[1],
            r: Math.max(6, Math.hypot(pEdge[0] - pCen[0], pEdge[1] - pCen[1])),
            fwhm: fwhmDeg,
          };
        }
      }

      frameId = requestAnimationFrame(draw);
    };

    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [ready, config]);

  // Project the fixed Alt/Az pointing-limit triangle onto the current sky.
  useEffect(() => {
    if (!ready || !limitOverlayRef.current) return;

    limitOverlayRef.current.removeAll();
    if (config && config.pointing_limit_altaz.length === 3) {
      const date = telemetry?.timestamp != null
        ? new Date(telemetry.timestamp * 1000)
        : new Date();
      const vertices = config.pointing_limit_altaz.map((point) => altAzToRaDec(point, config, date));
      const polyline = vertices.map((point): [number, number] => [point.ra_deg, point.dec_deg]);
      limitOverlayRef.current.add(
        A.polyline([...polyline, polyline[0]], {
          color: 'rgba(255,126,89,0.9)',
          lineWidth: 2,
        }),
      );
      vertices.forEach((point) => {
        limitOverlayRef.current?.add(
          A.circle(point.ra_deg, point.dec_deg, 0.08, {
            color: '#ff7e59',
            lineWidth: 2,
          }),
        );
      });
    }
  }, [config, ready, telemetry?.timestamp]);

  // Update beam circle on every telemetry tick
  useEffect(() => {
    if (!ready || !beamOverlayRef.current) return;
    const fwhm = config?.beam_fwhm_deg ?? 6.5;

    // Always derive RA/Dec from Alt/Az on the client so the round-trip stays
    // consistent with the click handler (both go through raDecToAltAz/altAzToRaDec).
    // Backend katpoint RA/Dec uses full corrections and disagrees by ~1° near the
    // horizon, which would make the beam land in the wrong place after "Set as Current".
    let ra_deg: number | null = null;
    let dec_deg: number | null = null;
    if (config && telemetry?.altitude_deg != null && telemetry?.azimuth_deg != null) {
      const pt = altAzToRaDec(
        { altitude_deg: telemetry.altitude_deg, azimuth_deg: telemetry.azimuth_deg },
        config, new Date(),
      );
      ra_deg  = pt.ra_deg;
      dec_deg = pt.dec_deg;
    } else {
      ra_deg  = telemetry?.ra_deg  ?? null;
      dec_deg = telemetry?.dec_deg ?? null;
    }

    beamOverlayRef.current.removeAll();
    if (ra_deg != null && dec_deg != null) {
      // Outer glow ring (2Ã— FWHM radius, translucent)
      beamOverlayRef.current.add(
        A.circle(ra_deg, dec_deg, fwhm, { color: 'rgba(114,224,173,0.10)', lineWidth: 1 }),
      );
      // FWHM boundary ring
      beamOverlayRef.current.add(
        A.circle(ra_deg, dec_deg, fwhm / 2, { color: 'rgba(114,224,173,0.85)', lineWidth: 2 }),
      );
      // Centre dot
      beamOverlayRef.current.add(
        A.circle(ra_deg, dec_deg, 0.04, { color: '#72e0ad', lineWidth: 3 }),
      );
    }
  }, [telemetry, config, ready]);

  // Update the selected target marker and its FWHM footprint.
  useEffect(() => {
    if (!ready || !pendingOverlayRef.current) return;

    pendingOverlayRef.current.removeAll();
    if (pending) {
      const fwhm = config?.beam_fwhm_deg ?? 6.5;
      pendingOverlayRef.current.add(
        A.circle(pending.ra_deg, pending.dec_deg, fwhm / 2, {
          color: 'rgba(243,204,107,0.9)',
          lineWidth: 2,
        }),
      );
      pendingOverlayRef.current.add(
        A.circle(pending.ra_deg, pending.dec_deg, 0.04, {
          color: '#f3cc6b',
          lineWidth: 3,
        }),
      );
    }
  }, [pending, config, ready]);

  // Named target markers supplied by the backend or parent component.
  useEffect(() => {
    if (!ready || !targetCatalogRef.current) return;

    targetCatalogRef.current.removeAll();
    targetCatalogRef.current.addSources(
      overlays.map((overlay) =>
        A.source(overlay.ra_deg, overlay.dec_deg, {
          name: overlay.label,
          id: overlay.id,
          color: overlay.color,
        }),
      ),
    );
  }, [overlays, ready]);

  const fmtAltAz = (alt: number, az: number) =>
    `Az ${az.toFixed(1)}°  ·  Alt ${alt.toFixed(1)}°`;

  const pendingAltAz = pending && config
    ? raDecToAltAz(pending.ra_deg, pending.dec_deg, config, new Date())
    : null;

  const handleSolarHover = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!tooltipsEnabled) { setHoverTooltip(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Prefer the smallest ring under the cursor so the pending target wins
    // when it overlaps the (larger) solar exclusion zone.
    const candidates: { kind: 'sun' | 'beam' | 'pending'; r: number; fwhm?: number }[] = [];
    const beam = beamZoneRef.current;
    if (beam && Math.hypot(mx - beam.cx, my - beam.cy) < beam.r) {
      candidates.push({ kind: 'beam', r: beam.r, fwhm: beam.fwhm });
    }
    const pend = pendingZoneRef.current;
    if (pend && Math.hypot(mx - pend.cx, my - pend.cy) < pend.r) {
      candidates.push({ kind: 'pending', r: pend.r, fwhm: pend.fwhm });
    }
    const sun = sunZoneRef.current;
    if (sun && Math.hypot(mx - sun.cx, my - sun.cy) < sun.r) {
      candidates.push({ kind: 'sun', r: sun.r });
    }
    if (candidates.length === 0) { setHoverTooltip(null); return; }
    candidates.sort((a, b) => a.r - b.r);
    const pick = candidates[0];
    setHoverTooltip({ kind: pick.kind, x: mx, y: my, fwhm: pick.fwhm });
  };

  return (
    <div className={`skymap-wrapper${cameraSwapped ? ' skymap-wrapper-swapped' : ''}`}>
      <div
        className="skymap-aladin"
        ref={containerRef}
        onMouseMove={handleSolarHover}
        onMouseLeave={() => setHoverTooltip(null)}
      >
        <canvas className="skymap-horizon-canvas" ref={horizonCanvasRef} />

        <div className="skymap-toolbar" aria-label="Sky map controls">
          <div className="skymap-layer-control">
            <span className="skymap-control-label">
              <Layers size={13} />
              View
            </span>
            <div className="skymap-surveys" role="group" aria-label="Sky survey">
              {SURVEYS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`skymap-survey-btn${survey === s.id ? ' active' : ''}`}
                  onClick={() => setSurvey(s.id)}
                  title={s.title}
                  disabled={!ready}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className={`skymap-tooltip-toggle${tooltipsEnabled ? ' active' : ''}`}
            onClick={() => {
              setTooltipsEnabled((v) => !v);
              setHoverTooltip(null);
            }}
            title={tooltipsEnabled ? 'Hide hover tooltips' : 'Show hover tooltips'}
            aria-pressed={tooltipsEnabled}
          >
            <Info size={13} />
            Tooltips
          </button>
        </div>

        {(pendingAltAz || (telemetry?.altitude_deg != null && telemetry.azimuth_deg != null)) && (
          <div className="skymap-altaz-chip">
            {pendingAltAz ? (
              <span className="skymap-altaz-target">{fmtAltAz(pendingAltAz.altitude_deg, pendingAltAz.azimuth_deg)}</span>
            ) : (
              <span>{fmtAltAz(telemetry!.altitude_deg!, telemetry!.azimuth_deg!)}</span>
            )}
          </div>
        )}

        {!ready && (
          <div className="skymap-loading">
            <Telescope size={24} className="skymap-loading-icon" />
            <span>Loading sky atlas</span>
          </div>
        )}
        {tooltipsEnabled && hoverTooltip && (
          <div
            className="skymap-solar-tooltip"
            style={{ left: hoverTooltip.x + 14, top: hoverTooltip.y + 14 }}
          >
            {hoverTooltip.kind === 'sun' && (
              <>
                <strong>Range of Solar Influence</strong>
                <p>Pointing within 15° of the Sun will likely overwhelm the hydrogen signal</p>
              </>
            )}
            {hoverTooltip.kind === 'beam' && (
              <>
                <strong>Telescope Beam (FWHM)</strong>
                <p>
                  Half-power footprint at the current pointing
                  {hoverTooltip.fwhm != null ? ` — ${hoverTooltip.fwhm.toFixed(2)}° full width` : ''}.
                  Sources inside this ring contribute most of the received power.
                </p>
              </>
            )}
            {hoverTooltip.kind === 'pending' && (
              <>
                <strong>Target Beam (FWHM)</strong>
                <p>
                  Projected half-power footprint at the selected target
                  {hoverTooltip.fwhm != null ? ` — ${hoverTooltip.fwhm.toFixed(2)}° full width` : ''}.
                </p>
              </>
            )}
          </div>
        )}
      </div>

      <CameraPip swapped={cameraSwapped} onToggleSwap={() => setCameraSwapped((v) => !v)} />
    </div>
  );
}
