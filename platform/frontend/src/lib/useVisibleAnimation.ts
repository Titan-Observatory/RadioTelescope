import { useEffect, useRef, useState } from 'react';

// Negative top rootMargin used by the queue-page animations so anything sliding
// under the sticky header counts as out of view (see useVisibleAnimation).
export const STICKY_HEADER_ANIMATION_MARGIN_PX = 96;

export function useVisibleAnimation<T extends Element>(rootMarginTopPx = 0) {
  const ref = useRef<T | null>(null);
  const [active, setActive] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let inView = true;
    let tabVisible = document.visibilityState === 'visible';
    const update = () => setActive(inView && tabVisible);

    const onVisibilityChange = () => {
      tabVisible = document.visibilityState === 'visible';
      update();
    };

    // Negative top rootMargin shrinks the observer's effective viewport from
    // the top, so anything sliding under the sticky header counts as out of
    // view. Pausing the animation while it's behind a translucent
    // backdrop-filter is the only thing that lets the compositor cache the
    // blurred header layer between frames.
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    }, { threshold: 0.01, rootMargin: `-${rootMarginTopPx}px 0px 0px 0px` });

    document.addEventListener('visibilitychange', onVisibilityChange);
    observer.observe(el);
    update();

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      observer.disconnect();
    };
  }, [rootMarginTopPx]);

  return [ref, active] as const;
}
