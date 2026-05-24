/**
 * HydrogenAtom.tsx
 *
 * Animated depiction of a neutral hydrogen atom for the spin-flip explanation
 * panel. The sequence loops automatically:
 *
 *   1. Proton + electron start separated with simple particle labels.
 *   2. Particle labels fade out as the parts combine at centre.
 *   3. Spin arrows and labels fade in around the overlapped atom.
 *   4. The electron arrow vibrates and snaps to the opposite orientation
 *      (hyperfine spin-flip event).
 *   5. Labels and arrows fade out.
 *   6. Particles separate again for the next loop.
 *
 * ── Timing knobs ──────────────────────────────────────────────────────────
 * All durations are in seconds. Edit the TIMELINE object to change pacing.
 *
 * ── Flip animation knobs ──────────────────────────────────────────────────
 * FLIP.steps  — each entry is [rotOffset, scale, duration] for one vibration
 *               step. Add/remove entries or change magnitudes to taste.
 * FLIP.flash* — the bright-flash keyframe that precedes the snap.
 * FLIP.settle — how long the scale eases back to 1 after the snap.
 *
 * ── Visual knobs ──────────────────────────────────────────────────────────
 * Proton:   SVG metaball swarm — tweak circle radii / SMIL durations in
 *           ProtonSwarm().
 * Electron: Canvas Gaussian dot cloud — tweak the CLOUD object.
 * Arrow colour / glow: .hydrogen-atom-arrow in main.css.
 */

import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';

// ── Sequence timing (seconds) ─────────────────────────────────────────────
const TIMELINE = {
  holdSeparated:  1.6,
  combine:        2.0,
  holdAtomLabel:  1.2,
  fadeInUI:       1.0,
  holdBeforeFlip: 1.4,
  flipDuration:   0.85,  // must be >= sum of FLIP step durations + settle
  holdAfterFlip:  3.0,
  fadeOutUI:      1.0,
  separate:       2.0,
  holdEnd:        1.2,
};

// ── Flip vibration (each row: [rotOffset°, scale, duration s]) ────────────
const FLIP = {
  steps: [
    [-1,  1.00, 0.06],
    [+2,  1.00, 0.06],
    [-3,  1.01, 0.06],
    [+5,  1.03, 0.06],
    [-7,  1.05, 0.06],
    [+9,  1.08, 0.06],
    [-11, 1.11, 0.06],
    [+13, 1.13, 0.06],
    [-14, 1.14, 0.06],
    [+15, 1.15, 0.06],
  ] as [number, number, number][],
  flashDuration: 0.04,
  flashFilter:   'brightness(3) drop-shadow(0 0 16px #fff)',
  preFlashFilter:'brightness(1.4) drop-shadow(0 0 6px rgba(255,230,168,0.6))',
  settle:        0.08,
};

// ── Electron cloud constants ───────────────────────────────────────────────
const CLOUD = {
  size:     200,
  sigma:    0.22,   // spread as fraction of size
  maxSigma:   2.8,  // hard cutoff in sigma, kept inside the visible glow
  taperSigma: 2.6,  // soft visual falloff inside the clipping boundary
  n:        950,
  onDurMin:  1, onDurMax:  4,
  offDurMin: 1, offDurMax: 5,
  bigDotChance: 0.08,
  bigDotR: 1.65, smallDotR: 1.0,
  fps: 30,
  glow: {
    inner:  [100, 160, 255] as [number,number,number],
    mid:    [64,  112, 220] as [number,number,number],
    outer:  [32,  58,  158] as [number,number,number],
    peak:   0.68,
    scale:  0.70,
    stops:  [0, 0.30, 0.60],
    alphas: [1, 0.72, 0.38],
  },
  dotColor:     [168, 204, 246] as [number,number,number],
  dotMaxAlpha:  0.30,
  dotTaperExp:  4.2,
  edgeTaperExp: 1.8,
  blur:         '2px',
};

// ─────────────────────────────────────────────────────────────────────────────

export function HydrogenAtomDepiction({ paused }: { paused?: boolean }) {
  const protonRef        = useRef<HTMLDivElement>(null);
  const electronRef      = useRef<HTMLDivElement>(null);
  const protonArrowRef   = useRef<HTMLSpanElement>(null);
  const electronArrowRef = useRef<HTMLSpanElement>(null); // stable ref — never remounted
  const electronCloudRef = useRef<HTMLSpanElement>(null);
  const protonLabelRef   = useRef<HTMLSpanElement>(null);
  const electronLabelRef = useRef<HTMLSpanElement>(null);
  const protonPartLabelRef = useRef<HTMLSpanElement>(null);
  const electronPartLabelRef = useRef<HTMLSpanElement>(null);
  const atomLabelRef     = useRef<HTMLSpanElement>(null);
  const wavefieldRef     = useRef<RadialGridWavefieldHandle>(null);
  const tlRef            = useRef<gsap.core.Timeline | null>(null);
  const offsetRef        = useRef(0);
  const arrowRotRef      = useRef(0); // tracks accumulated rotation so flips chain correctly

  // Snap to the opening separated state before first paint.
  useLayoutEffect(() => {
    const proton   = protonRef.current;
    const electron = electronRef.current;
    if (!proton || !electron) return;
    gsap.set([proton, electron], { xPercent: -50, yPercent: -50 });
    gsap.set(electronCloudRef.current, { scale: 0.45, transformOrigin: '50% 50%' });
    const pr = proton.getBoundingClientRect();
    const er = electron.getBoundingClientRect();
    offsetRef.current = ((er.left + er.width / 2) - (pr.left + pr.width / 2)) / 2;
    gsap.set([proton, electron], { x: 0, y: -34 });
  }, []);

  useEffect(() => {
    const proton   = protonRef.current;
    const electron = electronRef.current;
    if (!proton || !electron) return;

    const offset = offsetRef.current;
    const ui = [
      protonArrowRef.current,
      electronArrowRef.current,
      protonLabelRef.current,
      electronLabelRef.current,
    ];
    const atomLabel = atomLabelRef.current;
    const electronCloud = electronCloudRef.current;
    const particleLabels = [
      protonPartLabelRef.current,
      electronPartLabelRef.current,
    ];

    // Flip animation built entirely in GSAP — no CSS keyframes, no React state,
    // no key= remounting. A stable ref means GSAP always has the right element.
    function triggerFlip() {
      const arrow = electronArrowRef.current;
      if (!arrow) return;

      const start = arrowRotRef.current;
      const end   = start + 180;
      arrowRotRef.current = end;

      const ft = gsap.timeline();

      // Vibrate with escalating amplitude.
      for (const [rotOff, scale, dur] of FLIP.steps) {
        ft.to(arrow, { rotation: start + rotOff, scale, duration: dur, ease: 'none' });
      }

      // Pre-flash glow, then bright flash.
      ft.to(arrow, {
        rotation: start - 11, scale: 1.12,
        filter: FLIP.preFlashFilter, duration: 0.03, ease: 'none',
      });
      ft.to(arrow, {
        rotation: start, scale: 1.4,
        filter: FLIP.flashFilter, duration: FLIP.flashDuration, ease: 'none',
      });

      // Instant snap to opposite orientation.
      ft.set(arrow, { rotation: end });
      ft.call(triggerRadialWave);

      // Settle back to neutral.
      ft.to(arrow, { scale: 1, filter: 'none', duration: FLIP.settle, ease: 'power2.out' });
    }

    function triggerRadialWave() {
      wavefieldRef.current?.emit();
    }

    const tl = gsap.timeline({ repeat: -1 });
    tlRef.current = tl;

    const T = TIMELINE;
    tl
      .call(() => {
        gsap.set(proton, { x: 0, y: -34 });
        gsap.set(electron, { x: 0, y: -34 });
        gsap.set(electronArrowRef.current, { rotation: 0 });
        gsap.set(electronCloud, { scale: 0.45 });
        gsap.set(atomLabel, { opacity: 0 });
        gsap.set(particleLabels, { opacity: 1 });
        arrowRotRef.current = 0;
      })
      .to({}, { duration: T.holdSeparated })
      .to(particleLabels, { opacity: 0, duration: 0.35, ease: 'power2.out' })
      .to(proton,   { x:  offset, y: 0, duration: T.combine, ease: 'power3.inOut' }, '<')
      .to(electron, { x: -offset, y: 0, duration: T.combine, ease: 'power3.inOut' }, '<')
      .to(electronCloud, { scale: 1, duration: T.combine, ease: 'power3.inOut' }, '<')
      .to(atomLabel, { opacity: 1, duration: 0.45, ease: 'power2.out' }, '>-0.2')
      .to({}, { duration: T.holdAtomLabel })
      .to(ui, { opacity: 1, duration: T.fadeInUI })
      .to({}, { duration: T.holdBeforeFlip })
      .call(triggerFlip)
      .to({}, { duration: T.flipDuration })
      .to({}, { duration: T.holdAfterFlip })
      .to(ui, { opacity: 0, duration: T.fadeOutUI })
      .to(atomLabel, { opacity: 0, duration: 0.35, ease: 'power2.out' }, '<')
      .to(proton,   { x: 0, y: -34, duration: T.separate, ease: 'power3.inOut' })
      .to(electron, { x: 0, y: -34, duration: T.separate, ease: 'power3.inOut' }, '<')
      .to(electronCloud, { scale: 0.45, duration: T.separate, ease: 'power3.inOut' }, '<')
      .to(particleLabels, { opacity: 1, duration: 0.45, ease: 'power2.out' })
      .to({}, { duration: T.holdEnd });

    if (paused) tl.pause();

    return () => {
      tl.kill();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tlRef.current) return;
    paused ? tlRef.current.pause() : tlRef.current.resume();
  }, [paused]);

  return (
    <div className="hydrogen-atom" aria-hidden data-paused={paused || undefined}>
      <RadialGridWavefield ref={wavefieldRef} sourceRef={electronRef} paused={paused} />
      <span ref={atomLabelRef} className="hydrogen-atom-title">Hydrogen Atom</span>
      <div ref={protonRef} className="hydrogen-atom-particle">
        <ProtonSwarm />
      </div>
      <div ref={electronRef} className="hydrogen-atom-particle">
        <ElectronCloud cloudRef={electronCloudRef} />
      </div>
      <span ref={protonPartLabelRef} className="hydrogen-particle-label hydrogen-particle-label-proton">
        <span className="hydrogen-particle-label-main">Proton</span>
      </span>
      <span ref={electronPartLabelRef} className="hydrogen-particle-label hydrogen-particle-label-electron">
        <span className="hydrogen-particle-label-main">Electron</span>
        <span className="hydrogen-particle-label-sub">(probability cloud)</span>
      </span>
      <div className="hydrogen-spin-readout hydrogen-spin-readout-proton">
        <span ref={protonArrowRef} className="hydrogen-atom-arrow">↑</span>
        <span ref={protonLabelRef} className="hydrogen-atom-label">proton spin</span>
      </div>
      <div className="hydrogen-spin-readout hydrogen-spin-readout-electron">
        <span ref={electronArrowRef} className="hydrogen-atom-arrow">↑</span>
        <span ref={electronLabelRef} className="hydrogen-atom-label">electron spin</span>
      </div>
    </div>
  );
}

// 21 cm wave: section-scale radial pulse that bends the background grid.

type RadialGridWavefieldHandle = { emit: () => void };

const WAVEFIELD = {
  grid: 80,
  sample: 8,
  durationMs: 2600,
  bandPx: 54,
  pushPx: 22,
  color: 'rgba(170, 185, 255, 0.34)',
  coreColor: 'rgba(212, 250, 255, 0.62)',
  glowColor: 'rgba(34, 211, 238, 0.2)',
};
// Skip exp+cos for samples > 3σ outside the wavefront — covers ~80 % of grid points.
const WAVEFIELD_BAND_CUTOFF = 3 * WAVEFIELD.bandPx;
const WAVEFIELD_BAND_SQ     = 2 * WAVEFIELD.bandPx * WAVEFIELD.bandPx;

const RadialGridWavefield = React.forwardRef<
  RadialGridWavefieldHandle,
  { sourceRef: React.RefObject<HTMLElement | null>; paused?: boolean }
>(function RadialGridWavefield({ sourceRef, paused }, ref) {
  const canvasRef  = useRef<HTMLCanvasElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const ctxRef     = useRef<CanvasRenderingContext2D | null>(null);
  const rafRef = useRef(0);
  const startRef = useRef<number | null>(null);
  const pausedRef = useRef(Boolean(paused));

  useEffect(() => {
    pausedRef.current = Boolean(paused);
  }, [paused]);

  useEffect(() => {
    const section = document.getElementById('h1-spinflip-section');
    if (!section) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'hydrogen-radial-wavefield';
    canvasRef.current = canvas;
    sectionRef.current = section;

    // Pre-size the canvas at creation so the first draw() frame doesn't
    // trigger a GPU texture resize, which can cause the electron cloud to
    // glitch on mobile due to compositing layer promotion jank.
    const rect = section.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    section.prepend(canvas);
    ctxRef.current = canvas.getContext('2d');

    return () => {
      cancelAnimationFrame(rafRef.current);
      canvas.remove();
      canvasRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    emit() {
      startRef.current = performance.now();
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
    },
  }));

  function draw(now: number) {
    const canvas = canvasRef.current;
    const section = sectionRef.current;
    const ctx = ctxRef.current;
    const source = sourceRef.current;
    const startedAt = startRef.current;
    if (!canvas || !section || !ctx || !source || startedAt === null) return;

    if (pausedRef.current) {
      rafRef.current = requestAnimationFrame(draw);
      return;
    }

    const rect = section.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const t = Math.min(1, (now - startedAt) / WAVEFIELD.durationMs);
    const attack = Math.min(1, t / 0.055);
    const decay = Math.exp(-Math.max(0, t - 0.055) * 4.9);
    const strength = attack * decay;
    const alpha = strength * 0.86;
    const sx = sourceRect.left + sourceRect.width / 2 - rect.left;
    const sy = sourceRect.top + sourceRect.height / 2 - rect.top;
    const maxRadius = Math.hypot(Math.max(sx, width - sx), Math.max(sy, height - sy)) + 90;
    const radius = t * maxRadius;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = WAVEFIELD.color;
    ctx.lineWidth = 0.8;
    ctx.globalAlpha = alpha;

    for (let x = -WAVEFIELD.grid; x <= width + WAVEFIELD.grid; x += WAVEFIELD.grid) {
      traceDistortedLine(ctx, sx, sy, radius, strength, x, -WAVEFIELD.grid, x, height + WAVEFIELD.grid);
    }
    for (let y = -WAVEFIELD.grid; y <= height + WAVEFIELD.grid; y += WAVEFIELD.grid) {
      traceDistortedLine(ctx, sx, sy, radius, strength, -WAVEFIELD.grid, y, width + WAVEFIELD.grid, y);
    }

    ctx.globalAlpha = alpha;
    ctx.shadowBlur = 16;
    ctx.shadowColor = WAVEFIELD.glowColor;
    ctx.strokeStyle = WAVEFIELD.coreColor;
    ctx.lineWidth = 1.45;
    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    if (t < 1) {
      rafRef.current = requestAnimationFrame(draw);
    } else {
      ctx.clearRect(0, 0, width, height);
      startRef.current = null;
    }
  }

  function traceDistortedLine(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    radius: number,
    strength: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / WAVEFIELD.sample);
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const x = x0 + (x1 - x0) * f;
      const y = y0 + (y1 - y0) * f;
      const dx = x - sx;
      const dy = y - sy;
      const dist = Math.max(0.001, Math.hypot(dx, dy));
      const off = dist - radius;
      if (Math.abs(off) > WAVEFIELD_BAND_CUTOFF) {
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        continue;
      }
      const band = Math.exp(-(off * off) / WAVEFIELD_BAND_SQ);
      const ripple = Math.cos((off / WAVEFIELD.bandPx) * Math.PI);
      const push = band * ripple * WAVEFIELD.pushPx * strength;
      const px = x + (dx / dist) * push;
      const py = y + (dy / dist) * push;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  return null;
});

function ProtonSwarm() {
  return (
    <span className="fuzzy fuzzy-proton fuzzy-goo">
      <svg viewBox="0 0 100 100" width="100%" height="100%">
        <defs>
          <radialGradient id="fuzzy-proton-grad">
            <stop offset="0%"   stopColor="#ffd3d3" />
            <stop offset="55%"  stopColor="#e84a4a" />
            <stop offset="100%" stopColor="#8f1515" />
          </radialGradient>
          <filter id="goo-proton" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" />
            <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" />
          </filter>
        </defs>
        <g filter="url(#goo-proton)" fill="url(#fuzzy-proton-grad)">
          <circle r="11" cx="50" cy="50">
            <animate attributeName="cx" dur="0.65s" begin="0s"     values="50;60;44;52;50" repeatCount="indefinite" />
            <animate attributeName="cy" dur="0.92s" begin="-0.3s"  values="50;44;56;47;50" repeatCount="indefinite" />
          </circle>
          <circle r="10" cx="50" cy="50">
            <animate attributeName="cx" dur="0.78s" begin="-0.4s"  values="50;42;56;48;50" repeatCount="indefinite" />
            <animate attributeName="cy" dur="0.54s" begin="0s"     values="50;57;44;55;50" repeatCount="indefinite" />
          </circle>
          <circle r="9.5" cx="50" cy="50">
            <animate attributeName="cx" dur="0.42s" begin="-0.15s" values="50;53;45;58;50" repeatCount="indefinite" />
            <animate attributeName="cy" dur="0.68s" begin="-0.5s"  values="50;47;59;43;50" repeatCount="indefinite" />
          </circle>
          <circle r="9" cx="50" cy="50">
            <animate attributeName="cx" dur="1.00s" begin="-0.6s"  values="50;46;54;42;50" repeatCount="indefinite" />
            <animate attributeName="cy" dur="0.50s" begin="-0.2s"  values="50;54;43;58;50" repeatCount="indefinite" />
          </circle>
        </g>
      </svg>
    </span>
  );
}

// ── Electron: Gaussian dot cloud ──────────────────────────────────────────

function ElectronCloud({ cloudRef }: { cloudRef?: React.Ref<HTMLSpanElement> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { size: SIZE, sigma: SIGMA_FRAC, maxSigma, taperSigma, n: N,
            onDurMin, onDurMax, offDurMin, offDurMax,
            bigDotChance, bigDotR, smallDotR,
            fps, glow, dotColor, dotMaxAlpha, dotTaperExp, edgeTaperExp } = CLOUD;

    canvas.width  = SIZE;
    canvas.height = SIZE;
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const sigma = SIZE * SIGMA_FRAC;
    const maxR = sigma * maxSigma;
    const taperR = sigma * taperSigma;

    const [dr, dg, db] = dotColor;
    const [gi, gg, gb] = glow.inner;
    const [mi, mg, mb] = glow.mid;
    const [oi, og, ob] = glow.outer;

    // ctx is stable for the lifetime of a canvas — cache it once.
    const ctx = canvas.getContext('2d')!;

    function gaussSample(): [number, number] {
      let x: number, y: number;
      do {
        const u1 = Math.max(1e-9, Math.random());
        const mag = Math.sqrt(-2 * Math.log(u1)) * sigma;
        const ang = 2 * Math.PI * Math.random();
        x = cx + mag * Math.cos(ang);
        y = cy + mag * Math.sin(ang);
      } while (Math.hypot(x - cx, y - cy) > maxR);
      return [x, y];
    }

    // Pre-compute the fill string for a dot at (x, y) — called on placement,
    // not per frame, so the hypot/exp/pow/toFixed cost is amortised across frames.
    function dotFillStyle(x: number, y: number): string {
      const dist = Math.hypot(x - cx, y - cy);
      const radialFade = Math.exp(-Math.pow(dist / taperR, dotTaperExp));
      const edgeFade = Math.pow(Math.max(0, 1 - dist / maxR), edgeTaperExp);
      return `rgba(${dr},${dg},${db},${(dotMaxAlpha * radialFade * edgeFade).toFixed(3)})`;
    }

    type Dot = { x: number; y: number; r: number; on: boolean; ttl: number; onDur: number; offDur: number; fillStyle: string };

    const dots: Dot[] = Array.from({ length: N }, () => {
      const [x, y] = gaussSample();
      const onDur  = onDurMin  + Math.floor(Math.random() * (onDurMax  - onDurMin  + 1));
      const offDur = offDurMin + Math.floor(Math.random() * (offDurMax - offDurMin + 1));
      const startOn = Math.random() < 0.45;
      return { x, y, r: Math.random() < bigDotChance ? bigDotR : smallDotR,
               on: startOn, ttl: 1 + Math.floor(Math.random() * (startOn ? onDur : offDur)),
               onDur, offDur, fillStyle: dotFillStyle(x, y) };
    });

    const FRAME_MS = 1000 / fps;
    let raf = 0, lastTime = 0;

    function draw(now: number) {
      raf = requestAnimationFrame(draw);
      if (now - lastTime < FRAME_MS) return;
      lastTime = now;

      ctx.clearRect(0, 0, SIZE, SIZE);

      let visCount = 0, sumX = 0, sumY = 0;
      for (const d of dots) {
        if (--d.ttl <= 0) {
          d.on = !d.on;
          d.ttl = d.on ? d.onDur : d.offDur;
          if (d.on) {
            [d.x, d.y] = gaussSample();
            d.fillStyle = dotFillStyle(d.x, d.y);
          }
        }
        if (d.on) { visCount++; sumX += d.x; sumY += d.y; }
      }

      const gcx  = visCount > 0 ? sumX / visCount : cx;
      const gcy  = visCount > 0 ? sumY / visCount : cy;
      const norm  = visCount / (N * 0.45);
      const peak  = Math.min(glow.peak, norm * glow.scale);
      const grad  = ctx.createRadialGradient(gcx, gcy, 0, cx, cy, SIZE * 0.50);
      grad.addColorStop(glow.stops[0], `rgba(${gi},${gg},${gb},${peak})`);
      grad.addColorStop(glow.stops[1], `rgba(${mi},${mg},${mb},${(peak * glow.alphas[1]).toFixed(3)})`);
      grad.addColorStop(glow.stops[2], `rgba(${oi},${og},${ob},${(peak * glow.alphas[2]).toFixed(3)})`);
      grad.addColorStop(1,             'rgba(10,25,90,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, SIZE, SIZE);

      for (const d of dots) {
        if (!d.on) continue;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = d.fillStyle;
        ctx.fill();
      }
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <span ref={cloudRef} className="fuzzy fuzzy-electron">
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%', filter: `blur(${CLOUD.blur})` }}
      />
    </span>
  );
}
