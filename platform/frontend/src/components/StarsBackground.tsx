import { useEffect, useRef } from 'react';

interface Star {
  x: number;
  y: number;
  radius: number;
  opacity: number;
  twinkleSpeed: number | null;
}

interface StarsBackgroundProps {
  starDensity?: number;
  allStarsTwinkle?: boolean;
  twinkleProbability?: number;
  minTwinkleSpeed?: number;
  maxTwinkleSpeed?: number;
  className?: string;
}

export function StarsBackground({
  starDensity = 0.00015,
  allStarsTwinkle = true,
  twinkleProbability = 0.7,
  minTwinkleSpeed = 0.5,
  maxTwinkleSpeed = 1,
  className,
}: StarsBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let stars: Star[] = [];
    let rafId = 0;
    let inView = false;
    let tabVisible = document.visibilityState === 'visible';

    function generateStars(width: number, height: number) {
      const numStars = Math.floor(width * height * starDensity);
      stars = Array.from({ length: numStars }, () => {
        const shouldTwinkle = allStarsTwinkle || Math.random() < twinkleProbability;
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          radius: Math.random() * 0.05 + 0.5,
          opacity: Math.random() * 0.5 + 0.5,
          twinkleSpeed: shouldTwinkle
            ? minTwinkleSpeed + Math.random() * (maxTwinkleSpeed - minTwinkleSpeed)
            : null,
        };
      });
    }

    const frameInterval = 1000 / 20;
    let lastFrame = 0;

    function render(now: number) {
      if (now - lastFrame < frameInterval) {
        rafId = requestAnimationFrame(render);
        return;
      }
      lastFrame = now;

      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      for (const star of stars) {
        ctx!.beginPath();
        ctx!.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(255, 255, 255, ${star.opacity})`;
        ctx!.fill();

        if (star.twinkleSpeed !== null) {
          star.opacity = 0.5 + Math.abs(Math.sin((Date.now() * 0.001) / star.twinkleSpeed) * 0.5);
        }
      }

      rafId = requestAnimationFrame(render);
    }

    function startLoop() {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(render);
    }

    function stopLoop() {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }

    function setActive(nowActive: boolean) {
      if (nowActive) startLoop();
      else stopLoop();
    }

    const update = () => setActive(inView && tabVisible);

    const onVisibilityChange = () => {
      tabVisible = document.visibilityState === 'visible';
      update();
    };

    const resizeObserver = new ResizeObserver(() => {
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      canvas!.width = w;
      canvas!.height = h;
      generateStars(w, h);
    });

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    }, { threshold: 0.01 });

    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w > 0 && h > 0) {
      canvas.width = w;
      canvas.height = h;
      generateStars(w, h);
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    resizeObserver.observe(parent);
    intersectionObserver.observe(canvas);

    return () => {
      stopLoop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [starDensity, allStarsTwinkle, twinkleProbability, minTwinkleSpeed, maxTwinkleSpeed]);

  return <canvas ref={canvasRef} className={className ?? 'stars-background'} />;
}
