import { driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';

import tourCopy from './data/tourCopy.json';

type DriverObj = ReturnType<typeof driver>;

const GUIDED_OBS_SEEN_KEY = 'rt-guided-obs-seen';

// The BaselineWizard fires this when it closes, with `detail.captured` telling
// us whether a baseline was actually saved. The guided observation hands the
// capture flow off to the wizard and resumes on this event — see
// `armMilkyWayResume` here and the dispatcher in BaselineWizard.tsx.
const BASELINE_WIZARD_CLOSED_EVENT = 'rt-baseline-wizard-closed';

const copy = tourCopy.guidedObservation;

export function markGuidedObservationSeen() {
  try { localStorage.setItem(GUIDED_OBS_SEEN_KEY, '1'); } catch { /* ignore */ }
}

export function hasSeenGuidedObservation(): boolean {
  try { return localStorage.getItem(GUIDED_OBS_SEEN_KEY) === '1'; } catch { return false; }
}

// Shared driver config for every leg of the guided observation. Progress text
// is intentionally off: the flow spans the baseline wizard, so a "Step X of Y"
// counter that restarts mid-way would read as disjointed rather than one
// continuous walkthrough.
function baseConfig() {
  return {
    showProgress: false,
    allowClose: true,
    overlayOpacity: 0.65,
    popoverClass: 'rt-tour-popover',
    nextBtnText: copy.buttons.next,
    prevBtnText: copy.buttons.back,
    doneBtnText: copy.buttons.done,
  };
}

// ─── Step builders ──────────────────────────────────────────────────────────
// Each leg of the guide is assembled from these so the baseline-capture path
// and the already-captured path share the same wording and anchors.

function introStep(): DriveStep {
  return {
    popover: {
      title: copy.steps.intro.title,
      description: copy.steps.intro.description,
    },
  };
}

// Shown only before a baseline exists: the raw, receiver-dominated trace.
function liveSignalStep(): DriveStep {
  return {
    element: '.spectrum-chart-box',
    popover: {
      title: copy.steps.liveSignal.title,
      description: copy.steps.liveSignal.description,
      side: 'left',
      align: 'start',
    },
  };
}

// Shown once the baseline is applied: the trace is flat/green and the readouts
// strip has appeared.
function correctedStep(): DriveStep {
  return {
    element: '.spectrum-chart-box',
    popover: {
      title: copy.steps.corrected.title,
      description: copy.steps.corrected.description,
      side: 'left',
      align: 'start',
    },
  };
}

// Highlights the sky map and explains how to point at the galaxy. The user
// drives the dish themselves with the map's own click-then-Slew controls, then
// advances at their own pace with the popover's Continue button.
function milkyWayStep(): DriveStep {
  return {
    element: '.skymap-panel',
    popover: {
      title: copy.steps.milkyWay.title,
      description: copy.steps.milkyWay.description,
      side: 'left',
      align: 'start',
    },
  };
}

function doneStep(): DriveStep {
  // Land the final popover on the velocity readout when it's there, so the
  // closing note about Doppler velocity points at the number it describes.
  const element = document.querySelector('.spectrum-readouts')
    ? '.spectrum-readouts'
    : '.spectrum-chart-wrap';
  return {
    element,
    popover: {
      title: copy.steps.done.title,
      description: copy.steps.done.description,
      side: 'left',
      align: 'start',
    },
  };
}

// ─── Legs ───────────────────────────────────────────────────────────────────

// After we hand the capture off to the wizard, wait for it to report back. Only
// a successful capture (detail.captured) resumes the guide on the Milky Way leg;
// if the user dismissed the wizard without saving a baseline, the guide simply
// ends and they can relaunch it from the Guided observation button. The
// listener removes itself on the first close either way, so it can't fire on a
// later, unrelated capture.
function armMilkyWayResume() {
  const onClosed = (event: Event) => {
    window.removeEventListener(BASELINE_WIZARD_CLOSED_EVENT, onClosed);
    const captured = (event as CustomEvent<{ captured?: boolean }>).detail?.captured;
    if (captured) runMilkyWayLeg();
  };
  window.addEventListener(BASELINE_WIZARD_CLOSED_EVENT, onClosed);
}

// Phase A: intro, the raw live signal, then the baseline prompt. The baseline
// step has no Next button — the only way forward is the page's own "Capture
// baseline →" control, which opens the wizard. Clicking it tears this tour down
// (so the wizard isn't hidden behind driver's overlay) and arms the resume.
function runBaselineLeadIn() {
  let handedOff = false;
  const obs: DriverObj = driver({
    ...baseConfig(),
    steps: [
      introStep(),
      liveSignalStep(),
      {
        element: '.baseline-prompt',
        popover: {
          title: copy.steps.baseline.title,
          description: copy.steps.baseline.description,
          side: 'top',
          align: 'start',
          // No 'next': the user must drive forward via the capture button. Keep
          // 'previous' (re-read the live-signal step) and 'close' (bail out).
          showButtons: ['previous', 'close'],
          onPopoverRender: () => {
            const captureBtn = document.querySelector<HTMLButtonElement>('.baseline-prompt-go');
            if (!captureBtn) return;
            captureBtn.addEventListener('click', () => {
              if (handedOff) return;
              handedOff = true;
              armMilkyWayResume();
              obs.destroy();
            }, { once: true });
          },
        },
      },
    ],
  });
  obs.drive();
}

// Phase B: the trace is now baseline-corrected. Confirm what changed, point the
// user at the sky map to aim at the galactic plane, then close on the hydrogen
// detection and an invitation to compare other points along the Milky Way.
function runMilkyWayLeg() {
  const obs: DriverObj = driver({
    ...baseConfig(),
    steps: [
      correctedStep(),
      milkyWayStep(),
      doneStep(),
    ],
  });
  obs.drive();
}

// A baseline is already applied, so there's nothing to capture — run the whole
// guide in one continuous pass, straight from the corrected spectrum to the
// Milky Way observation.
function runFullGuide() {
  const obs: DriverObj = driver({
    ...baseConfig(),
    steps: [
      introStep(),
      correctedStep(),
      milkyWayStep(),
      doneStep(),
    ],
  });
  obs.drive();
}

export function startGuidedObservation() {
  markGuidedObservationSeen();
  // The red capture prompt is only on screen while no baseline is applied. If
  // it's there, lead the user into capturing one and resume afterwards;
  // otherwise the spectrum is already corrected, so skip straight to observing.
  if (document.querySelector('.baseline-prompt')) {
    runBaselineLeadIn();
  } else {
    runFullGuide();
  }
}
