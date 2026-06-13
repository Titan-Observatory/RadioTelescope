import { Activity, HelpCircle, MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';

import { track } from '../analytics';
import { BRAND } from '../branding';
import { formatSeconds } from '../lib/formatters';
import { startTour } from '../tour';
import type { QueueStatus } from '../queue';
import type { RoboClawTelemetry } from '../types';
import { FeedbackDialog } from './FeedbackDialog';
import { FeedbackToast } from './FeedbackToast';

const FEEDBACK_PROMPT_DELAY_MS = 2 * 60 * 1000;
const FEEDBACK_PROMPT_STORAGE_KEY = 'rt-feedback-prompt-resolved';
const IDLE_WARNING_SECONDS = 10;

function LeaseChip({ status }: { status: QueueStatus }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const remaining = Math.max(0, Math.round(status.lease_remaining_s ?? 0));
  const idle = status.idle_remaining_s == null ? null : Math.max(0, Math.round(status.idle_remaining_s));
  return (
    <button
      type="button"
      className={`topbar-lease${detailOpen ? ' topbar-lease-open' : ''}`}
      aria-label="Session time limit explanation"
      aria-expanded={detailOpen}
      aria-describedby="session-limit-popover"
      onClick={() => setDetailOpen((open) => !open)}
      onBlur={() => setDetailOpen(false)}
    >
      <Activity size={12} />
      <span className="topbar-lease-label">Session</span>
      <strong>{formatSeconds(remaining)}</strong>
      {idle != null && idle < 30 && (
        <span className="topbar-lease-idle">· idle {idle}s</span>
      )}
      <span id="session-limit-popover" className="topbar-lease-popover" role="tooltip">
        <strong>Why sessions are timed</strong>
        <span>
          This demo is limited to give everyone an opportunity to use it.
          When your timer ends, control passes to the next visitor.
        </span>
      </span>
    </button>
  );
}

function IdleWarningOverlay({
  idleSeconds,
  onRenewActivity,
}: {
  idleSeconds: number;
  onRenewActivity: () => void;
}) {
  return (
    <div className="idle-warning-backdrop" role="presentation">
      <section
        className="idle-warning-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="idle-warning-title"
        aria-describedby="idle-warning-description"
      >
        <div className="idle-warning-kicker">Session idle warning</div>
        <h2 id="idle-warning-title">Are you still there?</h2>
        <p id="idle-warning-description">
          Your control session will time out in <strong>{idleSeconds}s</strong>.
        </p>
        <button
          type="button"
          className="idle-warning-action"
          onClick={onRenewActivity}
          autoFocus
        >
          I'm still here
        </button>
      </section>
    </div>
  );
}

export function TopBar({
  telemetry,
  leaseStatus,
  onRenewActivity,
}: {
  telemetry: RoboClawTelemetry | null;
  leaseStatus: QueueStatus | null;
  onRenewActivity?: () => void;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackInitialRating, setFeedbackInitialRating] = useState(0);
  const [toastOpen, setToastOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(FEEDBACK_PROMPT_STORAGE_KEY) === '1') return;
    } catch {
      // localStorage may be unavailable; fall through and still schedule.
    }
    const timer = window.setTimeout(() => {
      track('feedback_toast_shown');
      setToastOpen(true);
    }, FEEDBACK_PROMPT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  function markPromptResolved() {
    try {
      window.localStorage.setItem(FEEDBACK_PROMPT_STORAGE_KEY, '1');
    } catch {
      // ignore quota / privacy-mode failures
    }
  }

  function openFeedback(initialRating: number) {
    setFeedbackInitialRating(initialRating);
    setFeedbackOpen(true);
  }

  const idleSeconds = leaseStatus?.idle_remaining_s == null
    ? null
    : Math.max(0, Math.round(leaseStatus.idle_remaining_s));
  const showIdleWarning = idleSeconds != null
    && idleSeconds <= IDLE_WARNING_SECONDS
    && leaseStatus?.is_active === true
    && onRenewActivity != null;

  return (
    <>
      <header className="topbar">
        <a className="topbar-brand" href={BRAND.homepage} target="_blank" rel="noreferrer">
          <img src={BRAND.logoUrl} alt={BRAND.name} className="brand-logo" />
        </a>
        <div className="topbar-status">
          {leaseStatus && <LeaseChip status={leaseStatus} />}
          <button
            type="button"
            className="topbar-feedback"
            onClick={() => { track('feedback_opened'); openFeedback(0); }}
            title="Share feedback about the telescope experience"
          >
            <MessageSquare size={14} /> Feedback
          </button>
          <button
            type="button"
            className="topbar-help"
            onClick={() => { track('tour_button_clicked'); startTour('button'); }}
            title="Take a guided tour of the controls"
          >
            <HelpCircle size={14} /> Tour
          </button>
          <span className="topbar-time" title="Time at the telescope (EST)">
            <span className="topbar-time-label">Telescope time</span>
            {telemetry
              ? `${new Date(telemetry.timestamp * 1000).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false })} EST`
              : '—'}
          </span>
        </div>
      </header>
      <FeedbackDialog
        open={feedbackOpen}
        onOpenChange={(next) => {
          setFeedbackOpen(next);
          if (!next) {
            setFeedbackInitialRating(0);
            markPromptResolved();
          }
        }}
        initialRating={feedbackInitialRating}
      />
      <FeedbackToast
        open={toastOpen && !feedbackOpen}
        onDismiss={() => {
          setToastOpen(false);
          markPromptResolved();
        }}
        onPick={(rating) => {
          setToastOpen(false);
          markPromptResolved();
          openFeedback(rating);
        }}
      />
      {showIdleWarning && (
        <IdleWarningOverlay
          idleSeconds={idleSeconds}
          onRenewActivity={() => {
            track('idle_warning_confirmed', { idle_remaining_s: idleSeconds });
            onRenewActivity();
          }}
        />
      )}
    </>
  );
}
