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
