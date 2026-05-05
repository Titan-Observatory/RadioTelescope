import A from 'aladin-lite';
import { Layers, Navigation, Telescope } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { api, ApiError } from '../api';
import type { AltAzPoint, RaDecTarget, RoboClawTelemetry, SkyOverlay, TelescopeConfig } from '../types';

// â”€â”€â”€ Galactic â†” Equatorial conversion (IAU 1958 / J2000) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const D = Math.PI / 180;
const R = 180 / Math.PI;

const EQ_TO_GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [ 0.4941094279, -0.4448296300,  0.7469822445],
  [-0.8676661490, -0.1980763734,  0.4559837762],
] as const;

function sphericalToVector(lonDeg: number, latDeg: number): [number, number, number] {
  const lon = lonDeg * D;
  const lat = latDeg * D;
  const cosLat = Math.cos(lat);
  return [cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat)];
}

function vectorToSpherical([x, y, z]: [number, number, number]): { lon_deg: number; lat_deg: number } {
  return {
    lon_deg: ((Math.atan2(y, x) * R) + 360) % 360,
    lat_deg: Math.asin(Math.max(-1, Math.min(1, z))) * R,
  };
}

function rotate(
  m: typeof EQ_TO_GAL,
  [x, y, z]: [number, number, number],
): [number, number, number] {
  return [
    m[0][0] * x + m[0][1] * y + m[0][2] * z,
    m[1][0] * x + m[1][1] * y + m[1][2] * z,
    m[2][0] * x + m[2][1] * y + m[2][2] * z,
  ];
}

function rotateTranspose(
  m: typeof EQ_TO_GAL,
  [x, y, z]: [number, number, number],
): [number, number, number] {
  return [
    m[0][0] * x + m[1][0] * y + m[2][0] * z,
    m[0][1] * x + m[1][1] * y + m[2][1] * z,
    m[0][2] * x + m[1][2] * y + m[2][2] * z,
  ];
}

function galToEq(l_deg: number, b_deg: number): { ra_deg: number; dec_deg: number } {
  const { lon_deg, lat_deg } = vectorToSpherical(rotateTranspose(EQ_TO_GAL, sphericalToVector(l_deg, b_deg)));
  return { ra_deg: lon_deg, dec_deg: lat_deg };
}

function eqToGal(ra_deg: number, dec_deg: number): { l_deg: number; b_deg: number } {
  const { lon_deg, lat_deg } = vectorToSpherical(rotate(EQ_TO_GAL, sphericalToVector(ra_deg, dec_deg)));
  return { l_deg: lon_deg, b_deg: lat_deg };
}

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
    label: 'Hydrogen Line',
    title: 'HI4PI 21cm neutral hydrogen column density, colorized for readability',
  },
  {
    id: 'CDS/P/NVSS',
    label: 'Radio sources',
    title: 'NRAO VLA Sky Survey (NVSS) â€” 1.4 GHz radio continuum, northern sky',
  },
  {
    id: 'CDS/P/Mellinger/color',
    label: 'Milky Way',
    title: 'Mellinger visible-light color all-sky survey',
  },
] as const;

type SurveyId = (typeof SURVEYS)[number]['id'];


// â”€â”€â”€ Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface SkyMapProps {
  telemetry: RoboClawTelemetry | null;
  config: TelescopeConfig | null;
  onNotice: (msg: string | null) => void;
  overlays?: SkyOverlay[];
}

export function SkyMap({ telemetry, config, onNotice, overlays = [] }: SkyMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const aladinRef = useRef<ReturnType<typeof A.aladin> | null>(null);
  const configRef = useRef<TelescopeConfig | null>(null);
  const beamOverlayRef = useRef<ReturnType<typeof A.graphicOverlay> | null>(null);
  const limitOverlayRef = useRef<ReturnType<typeof A.graphicOverlay> | null>(null);
  const pendingOverlayRef = useRef<ReturnType<typeof A.graphicOverlay> | null>(null);
  const targetCatalogRef = useRef<ReturnType<typeof A.catalog> | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<RaDecTarget | null>(null);
  const [slewing, setSlewing] = useState(false);
  const [survey, setSurvey] = useState<SurveyId>('CDS/P/HI4PI/NHI');

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Initialise Aladin Lite once
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let cancelled = false;
    let removeClickHandler: (() => void) | null = null;

    void A.init.then(() => {
      if (cancelled || !container) return;

      const aladin = A.aladin(container, {
        survey: 'CDS/P/HI4PI/NHI',
        fov: 120,
        cooFrame: 'galactic',   // galactic l/b â€” natural for HI work
        projection: 'AIT',
        lockNorthUp: true,
        inertia: false,
        showCooGrid: true,
        gridColor: 'rgb(114, 224, 173)',
        gridOpacity: 0.35,
        gridOptions: {
          enabled: true,
          showLabels: true,
          thickness: 1,
          labelSize: 12,
        },
        showReticle: false,
        showZoomControl: true,
        showFov: false,
        showFullscreenControl: false,
        showLayersControl: false,
        showGotoControl: false,
        showStatusBar: false,
        showFrame: false,
        showCooLocation: false,
        showProjectionControl: false,
      });

      // Beam + pending overlays
      const beamOverlay = A.graphicOverlay({ color: 'rgba(114,224,173,0.85)', lineWidth: 2 });
      const limitOverlay = A.graphicOverlay({ color: 'rgba(255,126,89,0.85)', lineWidth: 2 });
      const pendingOverlay = A.graphicOverlay({ color: '#f3cc6b', lineWidth: 1.5 });
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
      beamOverlayRef.current = beamOverlay;
      limitOverlayRef.current = limitOverlay;
      pendingOverlayRef.current = pendingOverlay;
      targetCatalogRef.current = targetCatalog;
      setReady(true);

      // Click: pix2world returns (l, b) in galactic mode â†’ convert to RA/Dec for backend
      const handleClick = (e: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const coords = aladin.pix2world(e.clientX - rect.left, e.clientY - rect.top);
        if (coords && coords.length === 2 && isFinite(coords[0]) && isFinite(coords[1])) {
          const { ra_deg, dec_deg } = galToEq(coords[0], coords[1]);
          const currentConfig = configRef.current;
          if (currentConfig && currentConfig.pointing_limit_altaz.length === 3) {
            const altAz = raDecToAltAz(ra_deg, dec_deg, currentConfig, new Date());
            if (!isInsideTriangle(altAz, currentConfig.pointing_limit_altaz)) {
              setPending(null);
              onNotice('Selected target is outside configured pointing limits.');
              return;
            }
          }

          const target: RaDecTarget = { ra_deg, dec_deg };
          onNotice(null);
          setPending(target);
        }
      };
      container.addEventListener('click', handleClick);
      removeClickHandler = () => container.removeEventListener('click', handleClick);
    });

    return () => {
      cancelled = true;
      removeClickHandler?.();
    };
  }, []);

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
    const { ra_deg, dec_deg } = telemetry ?? {};
    const fwhm = config?.beam_fwhm_deg ?? 6.5;

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

  const confirmGoto = async () => {
    if (!pending || !config) return;
    setSlewing(true);
    onNotice(null);
    try {
      await api.gotoRaDec(pending, config.goto_speed_qpps, config.goto_accel_qpps2);
      // Pan Aladin to the target (gotoRaDec always takes RA/Dec)
      aladinRef.current?.gotoRaDec(pending.ra_deg, pending.dec_deg);
    } catch (err) {
      onNotice(err instanceof ApiError ? err.message : 'Goto failed');
    } finally {
      setSlewing(false);
      setPending(null);
      pendingOverlayRef.current?.removeAll();
    }
  };

  const cancelPending = () => {
    setPending(null);
    pendingOverlayRef.current?.removeAll();
  };

  // Galactic coordinate formatting for the footer
  const fmtGal = (l: number, b: number) => {
    const bSign = b >= 0 ? '+' : 'âˆ’';
    return `l = ${l.toFixed(2)}Â° Â· b = ${bSign}${Math.abs(b).toFixed(2)}Â°`;
  };

  const currentGal = telemetry?.ra_deg != null && telemetry.dec_deg != null
    ? eqToGal(telemetry.ra_deg, telemetry.dec_deg)
    : null;

  const pendingGal = pending
    ? eqToGal(pending.ra_deg, pending.dec_deg)
    : null;

  return (
    <div className="skymap-wrapper">
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
      </div>

      <div className="skymap-aladin" ref={containerRef}>
        {!ready && (
          <div className="skymap-loading">
            <Telescope size={24} className="skymap-loading-icon" />
            <span>Loading sky atlasâ€¦</span>
          </div>
        )}
      </div>

      <div className="skymap-footer">
        {pending && pendingGal ? (
          <div className="skymap-confirm">
            <span className="skymap-coords">{fmtGal(pendingGal.l_deg, pendingGal.b_deg)}</span>
            <div className="skymap-actions">
              <button
                className="action-button skymap-slew-btn"
                onClick={() => void confirmGoto()}
                disabled={slewing}
              >
                <Navigation size={13} />
                {slewing ? 'Slewingâ€¦' : 'Slew Here'}
              </button>
              <button className="skymap-cancel-btn" onClick={cancelPending} disabled={slewing}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="skymap-hint">
            {currentGal != null ? (
              <span>
                {fmtGal(currentGal.l_deg, currentGal.b_deg)}
                {telemetry?.altitude_deg != null && ` Â· Alt ${telemetry.altitude_deg.toFixed(1)}Â°`}
              </span>
            ) : (
              <span>Click the sky to set a slew target</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
