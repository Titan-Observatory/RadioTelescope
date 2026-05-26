import * as Dialog from '@radix-ui/react-dialog';
import { Send, Star, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { submitFeedback } from '../api';
import { track } from '../analytics';

type Phase = 'idle' | 'submitting' | 'success' | 'error';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialRating?: number;
}

const RATING_LABELS: Record<number, string> = {
  1: 'Frustrating',
  2: 'Rough',
  3: 'It was OK',
  4: 'Good',
  5: 'Loved it',
};

export function FeedbackDialog({ open, onOpenChange, initialRating = 0 }: Props) {
  const [rating, setRating] = useState(initialRating);
  const [hovered, setHovered] = useState(0);
  const [highlight, setHighlight] = useState('');
  const [improvement, setImprovement] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');

  useEffect(() => {
    if (open) setRating(initialRating);
  }, [open, initialRating]);

  function recordRating(n: number) {
    setRating(n);
    // Fire-and-forget: capture the rating immediately so we still have a
    // signal even if the user never submits the written fields. The server
    // tags every request with the session cookie, so multiple posts from
    // the same visitor correlate by session_id.
    void submitFeedback(n, '').then(
      () => track('feedback_rating_recorded', { rating: n }),
      () => track('feedback_rating_record_failed', { rating: n }),
    );
  }

  function resetForm() {
    setRating(0);
    setHovered(0);
    setHighlight('');
    setImprovement('');
    setPhase('idle');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) return;
    setPhase('submitting');
    const parts: string[] = [];
    if (highlight.trim()) parts.push(`What worked: ${highlight.trim()}`);
    if (improvement.trim()) parts.push(`What to improve: ${improvement.trim()}`);
    const message = parts.join('\n\n');
    try {
      await submitFeedback(rating, message);
      track('feedback_submitted', {
        rating,
        highlight_length: highlight.length,
        improvement_length: improvement.length,
      });
      setPhase('success');
    } catch {
      track('feedback_submit_failed', { rating });
      setPhase('error');
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetForm();
    onOpenChange(next);
  }

  const displayRating = hovered || rating;
  const showFollowUp = rating > 0;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="feedback-overlay" />
        <Dialog.Content className="feedback-dialog" aria-describedby="feedback-desc">
          <div className="feedback-header">
            <Dialog.Title className="feedback-title">Share feedback</Dialog.Title>
            <Dialog.Close className="feedback-close" aria-label="Close">
              <X size={16} />
            </Dialog.Close>
          </div>

          {phase === 'success' ? (
            <div className="feedback-success">
              <p>Thanks for your feedback!</p>
              <button type="button" onClick={() => handleOpenChange(false)}>Close</button>
            </div>
          ) : (
            <form onSubmit={(e) => void handleSubmit(e)} className="feedback-form">
              <p id="feedback-desc" className="feedback-prompt">
                Overall, how was using the telescope?
              </p>

              <div
                className="feedback-stars"
                role="group"
                aria-label="Rating"
                onMouseLeave={() => setHovered(0)}
              >
                {[1, 2, 3, 4, 5].map((n) => {
                  const filled = displayRating >= n;
                  return (
                    <button
                      key={n}
                      type="button"
                      className={`feedback-star${filled ? ' filled' : ''}`}
                      aria-label={`${n} star${n !== 1 ? 's' : ''}`}
                      aria-pressed={rating === n}
                      onClick={() => recordRating(n)}
                      onMouseEnter={() => setHovered(n)}
                    >
                      <Star size={28} fill={filled ? 'currentColor' : 'none'} />
                    </button>
                  );
                })}
              </div>
              <p className="feedback-rating-label">
                {displayRating ? RATING_LABELS[displayRating] : 'Tap a star to start'}
              </p>

              {showFollowUp && (
                <div className="feedback-followup">
                  <label className="feedback-label" htmlFor="feedback-highlight">
                    What worked well? <span className="feedback-optional">(optional)</span>
                  </label>
                  <textarea
                    id="feedback-highlight"
                    className="feedback-textarea"
                    rows={2}
                    maxLength={900}
                    placeholder="A feature that felt smooth, a moment you enjoyed…"
                    value={highlight}
                    onChange={(e) => setHighlight(e.target.value)}
                    disabled={phase === 'submitting'}
                  />

                  <label className="feedback-label" htmlFor="feedback-improvement">
                    What would you change? <span className="feedback-optional">(optional)</span>
                  </label>
                  <textarea
                    id="feedback-improvement"
                    className="feedback-textarea"
                    rows={2}
                    maxLength={900}
                    placeholder="Anything confusing, missing, or broken?"
                    value={improvement}
                    onChange={(e) => setImprovement(e.target.value)}
                    disabled={phase === 'submitting'}
                  />
                </div>
              )}

              {phase === 'error' && (
                <p className="feedback-error">Something went wrong. Please try again.</p>
              )}

              <div className="feedback-actions">
                <Dialog.Close asChild>
                  <button type="button" className="feedback-btn-secondary">Cancel</button>
                </Dialog.Close>
                <button
                  type="submit"
                  className="feedback-btn-primary"
                  disabled={rating === 0 || phase === 'submitting'}
                >
                  <Send size={14} />
                  {phase === 'submitting' ? 'Sending…' : 'Submit'}
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
