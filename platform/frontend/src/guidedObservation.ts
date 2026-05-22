import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';

type DriverObj = ReturnType<typeof driver>;

const GUIDED_OBS_SEEN_KEY = 'rt-guided-obs-seen';

export function markGuidedObservationSeen() {
  try { localStorage.setItem(GUIDED_OBS_SEEN_KEY, '1'); } catch { /* ignore */ }
}

export function hasSeenGuidedObservation(): boolean {
  try { return localStorage.getItem(GUIDED_OBS_SEEN_KEY) === '1'; } catch { return false; }
}

// Hand-picked targets. Both sit at high northern declination so they clear the
// horizon for most of the night from a mid-northern site, keeping the demo
// reliable without time-of-day gating.
//
// Reference: Coma, near the North Galactic Pole. Looking "up" out of the
// galactic disk, where almost no hydrogen lies along the line of sight — a
// good "no signal" patch to learn the receiver's own response.
const REFERENCE_RA_DEG = 192.86;
const REFERENCE_DEC_DEG = 27.13;

// Target: Cygnus area, near galactic longitude 80°, latitude 0°. Long column
// of hydrogen gas through the disk — one of the strongest 21 cm directions
// accessible from northern latitudes.
const TARGET_RA_DEG = 305.0;
const TARGET_DEC_DEG = 40.7;

type SlewFn = (raDeg: number, decDeg: number) => Promise<void>;

function appendSlewButton(
  driverObj: DriverObj,
  popover: { footer: HTMLElement },
  label: string,
  slew: SlewFn,
  raDeg: number,
  decDeg: number,
) {
  const footer = popover.footer as HTMLElement;
  if (!footer) return;
  // Driver renders its own progress + Next/Back into the footer. We insert the
  // slew button to the left of the navigation buttons so it reads as the
  // primary call to action for this step.
  const nav = footer.querySelector('.driver-popover-navigation-btns');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.className = 'rt-tour-btn rt-tour-btn-primary rt-tour-btn-slew';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Slewing…';
    try {
      await slew(raDeg, decDeg);
    } catch {
      // The notice banner in the app already surfaces slew errors. Advance
      // anyway — the user can re-slew manually if needed.
    } finally {
      driverObj.moveNext();
    }
  };
  if (nav) {
    footer.insertBefore(btn, nav);
  } else {
    footer.appendChild(btn);
  }
}

export function startGuidedObservation(slewToRaDec: SlewFn) {
  markGuidedObservationSeen();

  const obs: DriverObj = driver({
    showProgress: true,
    allowClose: true,
    overlayOpacity: 0.65,
    popoverClass: 'rt-tour-popover',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
    progressText: 'Step {{current}} of {{total}}',
    steps: [
      {
        popover: {
          title: 'Observe hydrogen',
          description:
            "We'll point the dish at two patches of sky and look for the faint radio glow given off by hydrogen gas at 1420 MHz — the most common element in the galaxy. The whole thing takes about three minutes.",
        },
      },
      {
        element: '.spectrum-section',
        popover: {
          title: 'Live radio signal',
          description:
            "This yellow line shows the radio energy the dish is hearing right now. The vertical orange marker is where pure hydrogen emits. We're looking for a small bump that lines up with — or shifts slightly off — that marker.",
          side: 'left',
          align: 'start',
        },
      },
      {
        element: '.spectrum-section',
        popover: {
          title: 'Aim at empty sky',
          description:
            "First we point somewhere with very little hydrogen, to learn what the receiver sounds like on its own. We picked the sky near the North Galactic Pole — looking \"up\" out of our galaxy, where almost no hydrogen gas lies in the way.",
          side: 'left',
          align: 'start',
          onPopoverRender: (popover) => {
            appendSlewButton(obs, popover, 'Slew to reference', slewToRaDec, REFERENCE_RA_DEG, REFERENCE_DEC_DEG);
          },
        },
      },
      {
        element: '.spectrum-toolbar',
        popover: {
          title: "Save what 'empty' looks like",
          description:
            "Click Capture below. This stores the current trace as a reference, so when we slew somewhere with real hydrogen the signal pops out clearly against this flat background. Then press Next.",
          side: 'top',
          align: 'start',
        },
      },
      {
        element: '.spectrum-section',
        popover: {
          title: 'Aim at the Milky Way',
          description:
            "Now we'll swing to a thick part of our galaxy's disk, in Cygnus. There's a huge column of hydrogen gas between us and the far side of the galaxy, all emitting at 1420 MHz. Watch the yellow trace once the dish settles — a bump should grow near the orange marker.",
          side: 'left',
          align: 'start',
          onPopoverRender: (popover) => {
            appendSlewButton(obs, popover, 'Slew to galactic plane', slewToRaDec, TARGET_RA_DEG, TARGET_DEC_DEG);
          },
        },
      },
      {
        element: '.spectrum-chart-wrap',
        popover: {
          title: 'You did it',
          description:
            'The bump you see is hydrogen gas tens of thousands of light-years away. If it sits slightly left or right of the orange marker, that gas is moving toward or away from us — the Doppler effect. Slew elsewhere any time to compare.',
          side: 'left',
          align: 'start',
        },
      },
    ],
  });

  obs.drive();
}
