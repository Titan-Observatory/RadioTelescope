import { memo, useEffect, useRef, useState } from 'react';

import { useVisibleAnimation, STICKY_HEADER_ANIMATION_MARGIN_PX } from '../../lib/useVisibleAnimation';
import {
  HW, HERO_CHART_TOP, HERO_BASE_Y, HERO_CHART_HEIGHT,
  HERO_AXIS_LABEL_Y, HERO_REST_LABEL_Y, HERO_REST_LABEL_BOX_Y,
  HERO_PERSEUS_BAND_TOP, HERO_PERSEUS_LABEL_Y, HERO_MOBILE_VIEWBOX, HERO_DESKTOP_VIEWBOX,
  SURVEY_POWER, H1_REST_MHZ, fToX, SURVEY_DOPPLER_PEAK_X,
  SURVEY_MAIN_PEAK_X, SURVEY_MAIN_PEAK_Y, SURVEY_MAIN_PEAK_RATIO, FREQ_TICKS_MHZ,
  buildHeroPaths, noiseSample,
} from '../../lib/queueHeroSpectrum';

export const HeroSpectrum = memo(function HeroSpectrum({ paused = false }: { paused?: boolean }) {
  // Live trace = survey shape + per-frame noise, lightly low-passed across
  // frames so the line breathes instead of strobing. Smoothing constant α
  // governs how quickly noise integrates away — 0.18 looks visibly "live"
  // while still letting the underlying peaks read clearly.
  //
  // The animation updates path `d` attributes imperatively via refs so React
  // never reconciles during the rAF loop. The component is also wrapped in
  // `memo()` so parent re-renders (queue status polling fires every couple
  // seconds) don't force a fresh React render and a competing path update
  // alongside the rAF loop.
  const smoothedRef = useRef<Float32Array>(new Float32Array(SURVEY_POWER.length));
  const rafRef = useRef<number | null>(null);
  const linePathRef = useRef<SVGPathElement | null>(null);
  const fillPathRef = useRef<SVGPathElement | null>(null);
  const peakFillPathRef = useRef<SVGPathElement | null>(null);
  const glowPathRef = useRef<SVGPathElement | null>(null);
  const [svgRef, animationActive] = useVisibleAnimation<SVGSVGElement>(STICKY_HEADER_ANIMATION_MARGIN_PX);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const update = () => setIsMobile(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  const initialPaths = buildHeroPaths(smoothedRef.current);

  useEffect(() => {
    if (!animationActive || paused) return;

    // rAF (not setInterval) so the path-attribute writes are synced to the
    // browser's paint cycle — setInterval fires asynchronously and can land
    // in the middle of a compositor pass, producing extra paint work.
    let lastTs = 0;
    const minIntervalMs = 1000 / 20;
    const alpha = 0.20;
    const noiseAmp = 0.07;
    const n = SURVEY_POWER.length;

    const tick = (ts: number) => {
      rafRef.current = requestAnimationFrame(tick);
      if (ts - lastTs < minIntervalMs) return;
      lastTs = ts;
      const buf = smoothedRef.current;
      for (let i = 0; i < n; i++) {
        const target = SURVEY_POWER[i] + noiseSample() * noiseAmp;
        buf[i] = buf[i] + (target - buf[i]) * alpha;
      }
      const { line, fill } = buildHeroPaths(buf);
      if (linePathRef.current) linePathRef.current.setAttribute('d', line);
      if (fillPathRef.current) fillPathRef.current.setAttribute('d', fill);
      if (peakFillPathRef.current) peakFillPathRef.current.setAttribute('d', fill);
      if (glowPathRef.current) glowPathRef.current.setAttribute('d', line);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [animationActive, paused]);

  return (
    <figure className="h1-hero-figure">
      <svg
        ref={svgRef}
        viewBox={isMobile ? HERO_MOBILE_VIEWBOX : HERO_DESKTOP_VIEWBOX}
        className="h1-svg"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
      <defs>
        <linearGradient id="h1HeroBaseFillGrad" x1="0" y1={HERO_CHART_TOP} x2="0" y2={HERO_BASE_Y} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffbc42" stopOpacity="0.18" />
          <stop offset="52%" stopColor="#ffbc42" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#ffbc42" stopOpacity="0" />
        </linearGradient>
        <radialGradient
          id="h1HeroPeakFillGrad"
          cx={SURVEY_MAIN_PEAK_X}
          cy={SURVEY_MAIN_PEAK_Y + 28}
          r="150"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#ffbc42" stopOpacity="0.36" />
          <stop offset="45%" stopColor="#ffbc42" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#ffbc42" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="h1HeroLineGlowGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset={`${Math.max(0, SURVEY_MAIN_PEAK_RATIO - 0.18) * 100}%`} stopColor="#ffbc42" stopOpacity="0.05" />
          <stop offset={`${Math.max(0, SURVEY_MAIN_PEAK_RATIO - 0.07) * 100}%`} stopColor="#ffbc42" stopOpacity="0.5" />
          <stop offset={`${SURVEY_MAIN_PEAK_RATIO * 100}%`} stopColor="#ffd37a" stopOpacity="0.95" />
          <stop offset={`${Math.min(1, SURVEY_MAIN_PEAK_RATIO + 0.08) * 100}%`} stopColor="#ffbc42" stopOpacity="0.34" />
          <stop offset={`${Math.min(1, SURVEY_MAIN_PEAK_RATIO + 0.2) * 100}%`} stopColor="#ffbc42" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="h1PerseusArmGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5ba4f5" stopOpacity="0.18" />
          <stop offset="60%" stopColor="#5ba4f5" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#5ba4f5" stopOpacity="0" />
        </linearGradient>
      </defs>
      {Array.from({ length: 7 }, (_, i) => HERO_CHART_TOP + (HERO_CHART_HEIGHT / 6) * i).map(y => (
        <line key={y} x1="0" y1={y} x2={HW} y2={y} stroke="#1a1d2e" strokeWidth="1" />
      ))}
      {FREQ_TICKS_MHZ.map(f => (
        <line key={f} x1={fToX(f)} y1={HERO_CHART_TOP} x2={fToX(f)} y2={HERO_BASE_Y} stroke="#1a1d2e" strokeWidth="1" />
      ))}
      <rect
        x={SURVEY_DOPPLER_PEAK_X - 46}
        y={HERO_PERSEUS_BAND_TOP}
        width="92"
        height={HERO_BASE_Y - HERO_PERSEUS_BAND_TOP}
        fill="url(#h1PerseusArmGrad)"
      />
      <path ref={fillPathRef} d={initialPaths.fill} fill="url(#h1HeroBaseFillGrad)" />
      <path ref={peakFillPathRef} d={initialPaths.fill} fill="url(#h1HeroPeakFillGrad)" />
      <line x1="0" y1={HERO_BASE_Y} x2={HW} y2={HERO_BASE_Y} stroke="#232640" strokeWidth="1" />
      <path ref={glowPathRef} d={initialPaths.line} fill="none" stroke="url(#h1HeroLineGlowGrad)" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" opacity="0.42" />
      <path ref={linePathRef} d={initialPaths.line} fill="none" stroke="#ffbc42" strokeWidth="3.25" strokeLinecap="round" strokeLinejoin="round" />
      <line x1={fToX(H1_REST_MHZ)} y1={SURVEY_MAIN_PEAK_Y} x2={fToX(H1_REST_MHZ)} y2={HERO_BASE_Y} stroke="#ffbc42" strokeWidth="1.35" strokeDasharray="5,4" opacity="0.72" />
      {/* Secondary blueshifted emission peak in the supplied LAB profile:
          neutral hydrogen in the Perseus Arm. */}
      <g>
        <title>Neutral hydrogen in the Perseus Arm, a spiral arm of the Milky Way, blueshifted by galactic rotation at l = 110°.</title>
        <rect
          x={SURVEY_DOPPLER_PEAK_X - 84}
          y={HERO_PERSEUS_LABEL_Y - 2}
          width="168"
          height="40"
          rx="5"
          fill="#08172e"
          stroke="#5ba4f5"
          strokeWidth="1"
          opacity="0.82"
        />
        <text
          x={SURVEY_DOPPLER_PEAK_X} y={HERO_PERSEUS_LABEL_Y + 16}
          textAnchor="middle"
          fill="#c5ddfb" fontSize="12" fontWeight="700"
          fontFamily="ui-monospace,monospace"
        >
          Perseus Arm
        </text>
        <text
          x={SURVEY_DOPPLER_PEAK_X} y={HERO_PERSEUS_LABEL_Y + 32}
          textAnchor="middle"
          fill="#7ab8f7" fontSize="9.5"
          fontFamily="ui-monospace,monospace"
        >
          Spiral arm of the Milky Way
        </text>
      </g>
      {/* Sideways bracket spanning the gap between the main (local-arm) peak
          and the H I rest marker, linking out to the Doppler explainer. */}
      {(() => {
        const restX = fToX(H1_REST_MHZ);
        const leftX = Math.min(SURVEY_MAIN_PEAK_X, restX);
        const rightX = Math.max(SURVEY_MAIN_PEAK_X, restX);
        const midX = (leftX + rightX) / 2;
        const prongY = SURVEY_MAIN_PEAK_Y - 9;
        const barY = prongY - 12;
        const tickY = barY - 15;
        const labelY = tickY - 3;
        const linkBoxY = labelY - 15;
        return (
          <a href="#h1-doppler-section" style={{ cursor: 'pointer' }}>
            <title>The received peak is offset from the 1420.4 MHz rest line due to the Doppler shift. Click to learn more.</title>
            <path
              d={`M ${leftX} ${prongY} L ${leftX} ${barY} L ${rightX} ${barY} L ${rightX} ${prongY} M ${midX} ${barY} L ${midX} ${tickY}`}
              fill="none"
              stroke="#7ab8f7"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.72"
            />
            <rect
              x={midX - 85}
              y={linkBoxY}
              width="170"
              height="20"
              rx="4"
              fill="#0b1328"
              stroke="#7ab8f7"
              strokeWidth="1"
              opacity="0.88"
            />
            <text
              x={midX - 6} y={labelY}
              textAnchor="middle"
              fill="#d4e5ff" fontSize="13" fontWeight="bold" opacity="0.92"
              fontFamily="ui-monospace,monospace"
              style={{ textDecoration: 'underline' }}
            >
              Why the difference?
            </text>
            <path
              d={`M ${midX + 67} ${labelY - 7} L ${midX + 75} ${labelY - 7} L ${midX + 75} ${labelY - 2} M ${midX + 75} ${labelY - 7} L ${midX + 65} ${labelY}`}
              fill="none"
              stroke="#d4e5ff"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.9"
            />
          </a>
        );
      })()}
      {FREQ_TICKS_MHZ.map(f => {
        const isRest = Math.abs(f - 1420.4) < 0.001;
        if (isRest) {
          return (
            <g key={f}>
              <rect
                x={fToX(f) - 38}
                y={HERO_REST_LABEL_BOX_Y}
                width="76"
                height="21"
                rx="4"
                fill="#251b0d"
                stroke="#ffbc42"
                strokeWidth="1"
                opacity="0.94"
              />
              <text
                x={fToX(f)}
                y={HERO_REST_LABEL_Y}
                textAnchor="middle"
                fill="#ffd37a"
                fontSize="12"
                fontWeight="800"
                fontFamily="ui-monospace,monospace"
              >
                {`${f.toFixed(1)} MHz`}
              </text>
            </g>
          );
        }
        return (
          <text
            key={f}
            x={fToX(f)} y={HERO_AXIS_LABEL_Y}
            textAnchor="middle"
            fill="#6f719a"
            fontSize="10"
            fontWeight="normal"
            fontFamily="ui-monospace,monospace"
          >
            {f.toFixed(1)}
          </text>
        );
      })}
      </svg>
    </figure>
  );
});
