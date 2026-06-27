import { DopplerAnimation } from './DopplerAnimation';

// The Doppler-effect explainer copy + animation, shared between the queue
// landing page section and the in-app "learn more" modal launched from the
// spectrum panel. `reveal` opts into the queue page's scroll-driven reveal
// animation; the modal renders the content immediately visible.
export function DopplerExplainer({ paused = false, reveal = false }: { paused?: boolean; reveal?: boolean } = {}) {
  return (
    <>
      <div className="h1-doppler-text" {...(reveal ? { 'data-reveal': '' } : {})}>
        <span className="h1-eyebrow">How do we use it?</span>
        <h2 className="h1-section-heading">The Doppler Effect</h2>
        <p className="h1-section-body">You may be familiar with the Doppler effect as it relates to sound, but did you know the same thing happens to light? In the same way that an approaching ambulance siren sounds higher in pitch as it gets closer and lower as it moves away, electromagnetic waves shift in frequency based on the relative motion between the source and the observer. It's far too subtle to notice in everyday life, but it's one of the most foundational tools in all of astronomy.</p>
        <p className="h1-section-body">The obvious challenge with this method is that in order to tell how much a frequency has shifted, you first need to know what it was originally. How do you do that for a photon that came from the other side of the Milky Way? This is where the power of spectral lines becomes clear.</p>
        <p className="h1-section-body">Since we can measure the exact frequency of light emitted by hydrogen in a controlled lab, and because every neutral hydrogen atom in the universe is identical, we can use that reference frequency to measure the relative velocity of hydrogen across the Milky Way.</p>
      </div>
      <div className="h1-doppler-visual" {...(reveal ? { 'data-reveal': 'lag' } : {})}>
        <DopplerAnimation paused={paused} />
        <p className="h1-visual-caption">
          The relative velocity of hydrogen gas along our line of sight shifts the observed frequency: approaching gas is blueshifted, receding gas is redshifted.
        </p>
      </div>
    </>
  );
}
