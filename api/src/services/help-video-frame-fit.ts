// A recording's frame size can change part-way: element fullscreen in the
// recorded tab (a huddle's "View the shared screen full size") resizes the tab
// capture, and MediaRecorder keeps writing the one stream at the new size. By
// default ffmpeg rebuilds a filter graph when its input's size changes; every
// trim, setpts and tile then starts over, and a render ended at the change
// (a published video of 22 s out of 36). So a recording is read with the
// graph kept (SOURCE_INPUT_ARGS) and its first filter (fitFrame) turns every
// frame into one fixed size: scaled to fit and centred on black when the
// aspect differs, nothing added when it does not. Both re-evaluate per frame
// (`eval=frame`), which costs nothing measurable: same output, same time on
// a 30-second 1080p test (2026-10-26).

/** Input options for a recording read through a filter graph: keep the graph
 *  when the frame size changes mid-stream (fitFrame absorbs the change). Goes
 *  before that input's `-i`. */
export const SOURCE_INPUT_ARGS = ['-reinit_filter', '0']

/** Within this ratio the aspect counts as the same: the frame is scaled to
 *  exactly the size (as before), never given a one-pixel black edge from
 *  rounding. */
const SAME_ASPECT = 1.01

/** The filter that makes every frame `width`x`height` whatever size it
 *  arrives at: fit inside it keeping the aspect, then centre on black. Must
 *  be the first filter on the recording's video. `flags`: the scaler's. */
export function fitFrame(width: number, height: number, flags?: string): string {
  const r = (width / height).toFixed(6)
  const wide = `gt(a,${r}*${SAME_ASPECT})`
  const tall = `lt(a,${r}/${SAME_ASPECT})`
  return (
    `scale=w='if(${wide},${width},if(${tall},trunc(${height}*a/2)*2,${width}))':` +
    `h='if(${wide},trunc(${width}/a/2)*2,${height})':eval=frame${flags ? `:flags=${flags}` : ''},` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:eval=frame`
  )
}
