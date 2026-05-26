import { Star, X } from 'lucide-react';
import { useState } from 'react';

import { submitFeedback } from '../api';
import { track } from '../analytics';

interface Props {
  open: boolean;
  onDismiss: () => void;
  onPick: (rating: number) => void;
}

export function FeedbackToast({ open, onDismiss, onPick }: Props) {
  const [hovered, setHovered] = useState(0);

  if (!open) return null;

  return (
    <div className="feedback-toast" role="dialog" aria-label="Quick feedback">
      <button
        type="button"
        className="feedback-toast-close"
        aria-label="Dismiss"
        onClick={() => {
          track('feedback_toast_dismissed');
          onDismiss();
        }}
      >
        <X size={14} />
      </button>
      <p className="feedback-toast-title">Enjoying the telescope?</p>
      <p className="feedback-toast-sub">Tap a star to share quick feedback.</p>
      <div
        className="feedback-stars feedback-toast-stars"
        role="group"
        aria-label="Rating"
        onMouseLeave={() => setHovered(0)}
      >
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = hovered >= n;
          return (
            <button
              key={n}
              type="button"
              className={`feedback-star${filled ? ' filled' : ''}`}
              aria-label={`${n} star${n !== 1 ? 's' : ''}`}
              onMouseEnter={() => setHovered(n)}
              onClick={() => {
                track('feedback_toast_rated', { rating: n });
                void submitFeedback(n, '').then(
                  () => track('feedback_rating_recorded', { rating: n, source: 'toast' }),
                  () => track('feedback_rating_record_failed', { rating: n, source: 'toast' }),
                );
                onPick(n);
              }}
            >
              <Star size={24} fill={filled ? 'currentColor' : 'none'} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
