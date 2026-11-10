/**
 * The replay cursor's trail, drawn here instead of by rrweb (2026-11-09).
 *
 * rrweb strokes ONE line through every cursor position that fired in the last
 * 500 ms of wall time. Normally positions fire a few per frame, so that is a
 * short tail. They fire all at once whenever the player catches up: a live
 * chunk that lands late, or the tab coming back after being hidden (rrweb's
 * timer adds the whole hidden time on its next frame and runs every action
 * that came due). One frame then strokes a line through hundreds of positions
 * from minutes of recording, and the frame fills with a scribble (a live
 * session viewed on 9 November 2026). rrweb also stops clearing the canvas
 * once its last point expires, so a stroke can stay on screen.
 *
 * Here positions that fire in one burst are never joined, the trail holds a
 * bounded number of points, a burst of calls draws once on the next frame,
 * and the canvas is cleared whenever there is nothing left to draw.
 */

export interface TailPoint {
  x: number
  y: number
  /** Wall-clock time the position fired (performance.now()). */
  at: number
}

/** How long a point stays on the trail, in ms of wall time (rrweb's default). */
export const TAIL_MS = 500
/** Points fired closer together than this (ms of wall time) fired in one frame. */
export const SAME_FRAME_MS = 4
/** More points than this in one frame is the player catching up, not motion. */
export const BURST_POINTS = 4
/** The most points the trail keeps. */
export const TAIL_MAX_POINTS = 60

/**
 * Pure: the runs of points to stroke at `now`, each at least two points long.
 * Points older than TAIL_MS are dropped. A frame that fired more than
 * BURST_POINTS positions is never stroked; the next run starts from its last
 * point, which is where the cursor really is.
 */
export function tailRuns(points: TailPoint[], now: number): TailPoint[][] {
  const frames: TailPoint[][] = []
  for (const p of points) {
    if (now - p.at >= TAIL_MS) continue
    const frame = frames[frames.length - 1]
    if (frame && p.at - frame[frame.length - 1].at < SAME_FRAME_MS) frame.push(p)
    else frames.push([p])
  }
  const runs: TailPoint[][] = []
  let run: TailPoint[] = []
  for (const frame of frames) {
    if (frame.length > BURST_POINTS) {
      if (run.length > 1) runs.push(run)
      run = [frame[frame.length - 1]]
      continue
    }
    run.push(...frame)
  }
  if (run.length > 1) runs.push(run)
  return runs
}

interface TailHost {
  /** rrweb's trail canvas; null when the Replayer was built with mouseTail: false. */
  mouseTail: HTMLCanvasElement | null
  /** rrweb calls this for every cursor position it plays (never for a seek). */
  drawMouseTail: (position: { x: number; y: number }) => void
}

export interface MouseTailOptions {
  strokeStyle: string
  lineWidth?: number
  now?: () => number
  requestFrame?: (cb: () => void) => number
  cancelFrame?: (id: number) => void
}

/**
 * Replace rrweb's trail drawing on one Replayer. Build the Replayer with
 * `mouseTail` on (so it creates the canvas and keeps it sized), then call
 * this. Returns a stop function that cancels pending draws.
 */
export function installMouseTail(replayer: unknown, opts: MouseTailOptions): () => void {
  const host = replayer as TailHost
  const now = opts.now ?? (() => performance.now())
  const requestFrame = opts.requestFrame ?? ((cb: () => void) => requestAnimationFrame(cb))
  const cancelFrame = opts.cancelFrame ?? ((id: number) => cancelAnimationFrame(id))
  let points: TailPoint[] = []
  let frame = 0
  let expiry: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const draw = () => {
    const t = now()
    points = points.filter((p) => t - p.at < TAIL_MS)
    const canvas = host.mouseTail
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const runs = tailRuns(points, t)
    if (!runs.length) return
    ctx.lineWidth = opts.lineWidth ?? 3
    ctx.lineCap = 'round'
    ctx.strokeStyle = opts.strokeStyle
    ctx.beginPath()
    for (const run of runs) {
      ctx.moveTo(run[0].x, run[0].y)
      for (let i = 1; i < run.length; i++) ctx.lineTo(run[i].x, run[i].y)
    }
    ctx.stroke()
  }

  const request = () => {
    if (stopped || frame) return
    frame = requestFrame(() => {
      frame = 0
      if (stopped) return
      draw()
      if (expiry) clearTimeout(expiry)
      // Redraw once the newest point has expired, so the trail fades out.
      expiry = points.length ? setTimeout(request, TAIL_MS) : null
    })
  }

  host.drawMouseTail = (position) => {
    if (stopped) return
    points.push({ x: position.x, y: position.y, at: now() })
    if (points.length > TAIL_MAX_POINTS) points.splice(0, points.length - TAIL_MAX_POINTS)
    request()
  }

  return () => {
    stopped = true
    if (frame) cancelFrame(frame)
    if (expiry) clearTimeout(expiry)
    frame = 0
    expiry = null
  }
}
