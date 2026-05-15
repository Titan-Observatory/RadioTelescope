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
  const [modalOpen, setModalOpen] = useState(false);
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const autoJoinedTokenRef = useRef<string | null>(null);
  const inQueue = (status?.position ?? -1) >= 0;

  // Open the modal automatically once we know turnstile is required.
  useEffect(() => {
    if (turnstileEnabled && !inQueue) setModalOpen(true);
  }, [turnstileEnabled, inQueue]);

  // Auto-join as soon as the captcha is solved — no button click needed.
  // Guarded by the token value so a re-render doesn't re-submit.
  useEffect(() => {
    if (!turnstileEnabled) return;
    if (inQueue || joining) return;
    if (!captchaToken) return;
    if (autoJoinedTokenRef.current === captchaToken) return;
    autoJoinedTokenRef.current = captchaToken;
    void onJoin(captchaToken);
  }, [captchaToken, turnstileEnabled, inQueue, joining, onJoin]);

  // If the join attempt failed, reset the captcha so the user can retry.
  useEffect(() => {
    if (!joinError || !turnstileEnabled) return;
    autoJoinedTokenRef.current = null;
    setCaptchaToken(null);
    if (window.turnstile && widgetIdRef.current) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [joinError, turnstileEnabled]);

  // Load Turnstile and render widget inside the modal when it opens.
  useEffect(() => {
    if (!modalOpen || inQueue || !turnstileEnabled || !siteKey) return;

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
  }, [modalOpen, inQueue, turnstileEnabled, siteKey]);

  // Close modal automatically once we enter the queue.
  useEffect(() => {
    if (inQueue) setModalOpen(false);
  }, [inQueue]);

  const closeModal = () => {
    setModalOpen(false);
    autoJoinedTokenRef.current = null;
    setCaptchaToken(null);
    widgetIdRef.current = null;
  };

  if (!inQueue) {
    return (
      <div className="queue-landing">
        <div className="queue-card">
          <h1>Radio Telescope</h1>
          <p>This telescope is shared with other users. Join the queue to take control.</p>
          {!turnstileEnabled && (
            <button
              className="action-button"
              disabled={joining}
              onClick={() => void onJoin(null)}
            >
              {joining ? 'Joining…' : 'Join queue'}
            </button>
          )}
          {joinError && !modalOpen && <p className="banner banner-error">{joinError}</p>}
        </div>

        {modalOpen && (
          <div className="captcha-modal-overlay">
            <div className="captcha-modal">
              <div className="captcha-modal-header">
                <h2>Verify to join</h2>
                <button className="captcha-modal-close" onClick={closeModal} aria-label="Close">
                  ×
                </button>
              </div>
              <p className="captcha-modal-body">Complete the check below to join the queue.</p>
              <div className="cf-turnstile" ref={widgetRef} />
              <p className="queue-status-line">
                {joining
                  ? 'Joining…'
                  : captchaToken
                    ? 'Verified — joining queue…'
                    : 'Waiting for verification…'}
              </p>
              {joinError && <p className="banner banner-error">{joinError}</p>}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="queue-waiting">
      <header className="queue-header">
        <div className="queue-header-inner">
          <div className="queue-header-title">
            <h1>You are in the queue</h1>
            <p className="queue-header-sub">Hold tight — you'll get control when it's your turn.</p>
          </div>
          <div className="queue-header-status">
            <span className="queue-header-label">Position</span>
            <strong className="queue-header-position">#{status!.position}</strong>
            {status!.queue_length > 0 && (
              <span className="queue-header-waiting">{status!.queue_length} waiting</span>
            )}
          </div>
        </div>
      </header>
      <div className="queue-waiting-body">
        <p>You'll be given control automatically when it's your turn.</p>
      </div>
    </div>
  );
}
