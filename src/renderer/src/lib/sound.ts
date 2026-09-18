/**
 * The two notification chimes, synthesised with WebAudio — no asset files to
 * bundle and nothing to load before the first bell can ring.
 *
 * One AudioContext is shared by the whole app and created lazily: browsers
 * refuse to start one before a user gesture, so building it at import time
 * would leave a permanently suspended context behind. Nothing here throws —
 * a bell that cannot play is not worth breaking a status tick over.
 */

/** Peak gain of a single tone: audible over a terminal, never startling. */
const PEAK_GAIN = 0.15

let shared: AudioContext | null = null

/** The shared context, created on first use and resumed if the OS parked it. */
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    if (!shared) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      shared = new Ctor()
    }
    if (shared.state === 'suspended') void shared.resume()
    return shared
  } catch {
    // no audio device, or the context could not be constructed
    return null
  }
}

/** One tone: a fast attack and an exponential tail, so it reads as a chime. */
function tone(ctx: AudioContext, freq: number, at: number, durationMs: number, peak: number): void {
  const startAt = ctx.currentTime + at
  const duration = durationMs / 1000
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, startAt)
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.03)
}

/**
 * Ring the bell for `kind`: two short rising tones for a question (it asks
 * something), one soft tone for a completed turn (it merely reports).
 */
export function playChime(kind: 'attention' | 'done'): void {
  const ctx = audio()
  if (!ctx) return
  try {
    if (kind === 'attention') {
      tone(ctx, 660, 0, 120, PEAK_GAIN)
      tone(ctx, 880, 0.13, 150, PEAK_GAIN)
    } else {
      tone(ctx, 784, 0, 180, PEAK_GAIN * 0.8)
    }
  } catch {
    // autoplay policy, or the context died with the audio device
  }
}

export default playChime
