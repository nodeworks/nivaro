import { writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { expect } from 'vitest'
import { runFfmpeg } from '../../services/ffmpeg.js'
import { buildClipPlan, type ClipPlanInput } from '../../services/help-video-clip-plan.js'
import { buildRenderPlan, type RenderInput } from '../../services/help-video-render-plan.js'

// The ffmpeg tests run a plan the way the services do: the filter graph is
// written to a file next to the output and named with -filter_complex_script
// (as one argument a big graph fails to spawn with E2BIG).

function graphFileFor(outputPath: string): string {
  return join(dirname(outputPath), `${basename(outputPath)}.filters.txt`)
}

export async function runRenderPlan(input: RenderInput): Promise<string[]> {
  const graphFile = graphFileFor(input.outputPath)
  const plan = buildRenderPlan({ ...input, graphFile })
  expect(plan.args).toContain('-filter_complex_script')
  expect(plan.args).not.toContain('-filter_complex')
  await writeFile(graphFile, plan.graph)
  await runFfmpeg(plan.args)
  return plan.args
}

export async function runClipPlan(
  input: ClipPlanInput,
  pass?: 'palette' | 'encode'
): Promise<string[]> {
  const graphFile = graphFileFor(input.outputPath)
  const plan = buildClipPlan({ ...input, graphFile }, pass)
  expect(plan.args).toContain('-filter_complex_script')
  expect(plan.args).not.toContain('-filter_complex')
  await writeFile(graphFile, plan.graph)
  await runFfmpeg(plan.args)
  return plan.args
}

/** Width and height of an image ffmpeg wrote (a poster, a sprite sheet). Our
 *  probes refuse anything but pinned audio/video demuxers, so tests read
 *  their own images with ffprobe directly. */
export async function probeImage(path: string): Promise<{ width: number; height: number }> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    path
  ])
  const s = (JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> })
    .streams?.[0]
  return { width: Number(s?.width ?? 0), height: Number(s?.height ?? 0) }
}
