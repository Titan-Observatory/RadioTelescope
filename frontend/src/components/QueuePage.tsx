import { useEffect, useRef, useState } from 'react';

import type { QueueStatus } from '../queue';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
        },
      ) => string;
      reset: (widgetId?: string) => void;
    };
    onloadTurnstileCallback?: () => void;
  }
}

const TURNSTILE_SCRIPT_ID = 'cf-turnstile-script';
const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback&render=explicit';

interface Props {
  status: QueueStatus | null;
  joining: boolean;
  joinError: string | null;
  siteKey: string | null;
  turnstileEnabled: boolean;
  onJoin: (token: string | null) => Promise<void>;
}

export function QueuePage({ status, joining, joinError, siteKey, turnstileEnabled, onJoin }: Props) {
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const inQueue = (status?.position ?? -1) >= 0;

  useEffect(() => {
    if (inQueue || !turnstileEnabled || !siteKey) return;

    const renderWidget = () => {
      if (!widgetRef.current || !window.turnstile || widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(widgetRef.current, {
        sitekey: siteKey,
        callback: (token: string) => setCaptchaToken(token),
        'error-callback': () => setCaptchaToken(null),
        'expired-callback': () => setCaptchaToken(null),
      });
    };

    if (window.turnstile) {
      renderWidget();
      return;
    }

    window.onloadTurnstileCallback = renderWidget;

    let script = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement('script');
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }, [inQueue, turnstileEnabled, siteKey]);

  if (!inQueue) {
    const canJoin = !turnstileEnabled || !!captchaToken;
    return (
      <div className="queue-landing">
        <div className="queue-card">
          <h1>Radio Telescope</h1>
          <p>This telescope is shared. Join the queue to take control.</p>
          {turnstileEnabled && siteKey && <div className="cf-turnstile" ref={widgetRef} />}
          <button
            className="action-button"
            disabled={joining || !canJoin}
            onClick={() => void onJoin(captchaToken)}
          >
            {joining ? 'Joining…' : 'Join queue'}
          </button>
          {joinError && <p className="banner banner-error">{joinError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="queue-waiting">
      <div className="queue-card">
        <h1>You are in the queue</h1>
        <p className="queue-position">
          Position <strong>#{status!.position}</strong>
          {status!.queue_length > 0 && <span> · {status!.queue_length} waiting</span>}
        </p>
        <div className="queue-placeholder">
          {/* Placeholder content area — fill in later. */}
        </div>
      </div>
    </div>
  );
}
