import * as Dialog from '@radix-ui/react-dialog';
import { Send, Star, X } from 'lucide-react';
import React, { useState } from 'react';
import { submitFeedback } from '../api';
import { track } from '../analytics';

type Phase = 'idle' | 'submitting' | 'success' | 'error';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FeedbackDialog({ open, onOpenChange }: Props) {
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');

  function resetForm() {
    setRating(0);
    setHovered(0);
    setMessage('');
    setPhase('idle');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (rating === 0) return;
    setPhase('submitting');
    try {
      await submitFeedback(rating, message);
      track('feedback_submitted', { rating, message_length: message.length });
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
                How is the telescope control experience?
              </p>

              <div
                className="feedback-stars"
                role="group"
                aria-label="Rating"
                onMouseLeave={() => setHovered(0)}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`feedback-star${displayRating >= n ? ' filled' : ''}`}
                    aria-label={`${n} star${n !== 1 ? 's' : ''}`}
                    aria-pressed={rating === n}
                    onClick={() => setRating(n)}
                    onMouseEnter={() => setHovered(n)}
                  >
                    <Star size={24} />
                  </button>
                ))}
              </div>

              <label className="feedback-label" htmlFor="feedback-msg">
                Comments <span className="feedback-optional">(optional)</span>
              </label>
              <textarea
                id="feedback-msg"
                className="feedback-textarea"
                rows={4}
                maxLength={2000}
                placeholder="What worked well? What could be better?"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={phase === 'submitting'}
              />

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
