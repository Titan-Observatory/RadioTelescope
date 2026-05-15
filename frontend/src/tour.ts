import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { track } from './analytics';

const TOUR_SEEN_KEY = 'rt-tour-seen';

function markTourSeen() {
  try { localStorage.setItem(TOUR_SEEN_KEY, '1'); } catch { /* ignore */ }
}

function hasSeenTour(): boolean {
  try { return localStorage.getItem(TOUR_SEEN_KEY) === '1'; } catch { return false; }
}

export function maybePromptFirstVisit() {
  if (hasSeenTour()) return;
  track('tour_prompt_shown');

  const prompt = driver({
    overlayOpacity: 0.65,
    popoverClass: 'rt-tour-popover rt-tour-prompt',
    showButtons: [],
    steps: [
      {
        popover: {
          title: 'Welcome',
          description:
            "It looks like this is your first time here. Would you like a guided tour showing you how to use the telescope?",
          onPopoverRender: (popover) => {
            const footer = popover.footer as HTMLElement;
            footer.innerHTML = '';
            footer.style.justifyContent = 'flex-end';
            footer.style.flexWrap = 'wrap';

            const dontShow = document.createElement('button');
            dontShow.textContent = "Don't show again";
            dontShow.className = 'rt-tour-btn rt-tour-btn-ghost';
            dontShow.onclick = () => {
              track('tour_prompt_dismissed', { choice: 'dont_show' });
              markTourSeen();
              prompt.destroy();
            };

            const later = document.createElement('button');
            later.textContent = 'Maybe later';
            later.className = 'rt-tour-btn rt-tour-btn-ghost';
            later.onclick = () => {
              track('tour_prompt_dismissed', { choice: 'later' });
              prompt.destroy();
            };

            const yes = document.createElement('button');
            yes.textContent = 'Start tour';
            yes.className = 'rt-tour-btn rt-tour-btn-primary';
            yes.onclick = () => {
              track('tour_prompt_dismissed', { choice: 'start' });
              markTourSeen();
              prompt.destroy();
              startTour('first_visit');
            };

            footer.appendChild(dontShow);
            footer.appendChild(later);
            footer.appendChild(yes);
          },
        },
      },
    ],
  });

  prompt.drive();
}

export function startTour(source: 'first_visit' | 'button' = 'button') {
  markTourSeen();
  track('tour_started', { source });
  let lastStepIndex = 0;
  let completed = false;
  const tour = driver({
    showProgress: true,
    allowClose: true,
    overlayOpacity: 0.65,
    popoverClass: 'rt-tour-popover',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    onHighlightStarted: (_el, _step, opts) => {
      lastStepIndex = opts.state.activeIndex ?? lastStepIndex;
    },
    onDestroyStarted: (_el, _step, opts) => {
      const total = opts.config.steps?.length ?? 0;
      const idx = opts.state.activeIndex ?? lastStepIndex;
      // driver.js calls onDestroyStarted both for "Done" and for early close;
      // we infer completion by whether we reached the last step.
      if (!completed && idx >= total - 1) {
        completed = true;
        track('tour_completed', { steps: total });
      } else if (!completed) {
        track('tour_abandoned', { last_step_index: idx, total_steps: total });
      }
      opts.driver.destroy();
    },
    steps: [
      {
        popover: {
          title: 'Welcome',
          description:
            'This is a short tour of the telescope control panel. Use Next/Back to step through, or press Esc to exit at any time.',
        },
      },
      {
        element: '.topbar',
        popover: {
          title: 'Status bar',
          description:
            'Connection state, telescope time, and — when you are in control — your session timer live up here.',
          side: 'bottom',
          align: 'start',
        },
      },
      {
        element: '.spectrum-section',
        popover: {
          title: 'Spectrum',
          description:
            'Live FFT from the SDR. The rolling average is configured on the server; watch for the hydrogen line near 1420 MHz.',
          side: 'right',
        },
      },
      {
        element: '.motion-card',
        popover: {
          title: 'Manual jog',
          description:
            'Press and hold a direction to nudge the dish. The center button is an emergency stop for all motion. The fader sets jog speed.',
          side: 'right',
        },
      },
      {
        element: '.target-form',
        popover: {
          title: 'Go to a target',
          description:
            'Type an azimuth and altitude in degrees, then hit Slew to drive the dish there automatically.',
          side: 'right',
        },
      },
      {
        element: '.skymap-panel',
        popover: {
          title: 'Sky map',
          description:
            'Live view of the sky from the telescope\'s location. Click a target on the map to load its alt/az into the Slew form.',
          side: 'left',
        },
      },
      {
        element: '.telemetry-panel',
        popover: {
          title: 'Telemetry',
          description:
            'Encoder positions, motor currents, voltages, and safety state. Watch here if a move feels wrong — overcurrent trips show up immediately.',
          side: 'left',
        },
      },
      {
        popover: {
          title: 'You are set',
          description:
            'That covers the main sections. You can re-run this tour anytime from the Help button in the top bar.',
        },
      },
    ],
  });

  tour.drive();
}
