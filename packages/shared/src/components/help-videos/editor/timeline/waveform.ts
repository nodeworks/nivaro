/** The recorder stores one microphone level every 100 ms. */
const SAMPLE_MS = 100

/** SVG path for the sound lane: one vertical bar per pixel column (the
 *  loudest sample in it), standing on a baseline 2 px above the bottom. */
export function waveformPath(levels: number[], pxPerSec: number, height: number): string {
  const cols = new Map<number, number>()
  for (let i = 0; i < levels.length; i++) {
    const x = Math.floor(((i * SAMPLE_MS) / 1000) * pxPerSec)
    const v = Math.max(0, Math.min(1, levels[i] || 0))
    if (v > (cols.get(x) ?? -1)) cols.set(x, v)
  }
  let d = ''
  for (const [x, v] of cols) {
    const h = Math.max(1, v * (height - 4))
    d += `M${x + 0.5} ${height - 2}v${-h.toFixed(1)}`
  }
  return d
}
