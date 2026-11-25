// The creation's last step (Hub enhancement 24): install the template the operator picked on
// Create app into this environment, over its hub link, once the first administrator exists. No
// template picked → done at once ("No template"). Idempotent: an install already done is done; a
// retry re-sends the same bundle and the app skips what it made the first time (it refuses only
// an app with collections the template does not bring: APP_NOT_EMPTY).
//
// The hub token is opened for the call only and added to ctx.secrets (scrubbed from every note,
// log line and error); the bundle travels in the body, never a note.
import { openSecret } from '../secrets.js'
import {
  readTemplateInstall,
  setTemplateInstall,
  TEMPLATE_MIN_VERSION
} from '../templates/choice.js'
import { readTemplateBundle } from '../templates/library.js'
import { type StepContext, StepFailure, type StepResult } from './steps.js'
import { requestTemplateInstall } from './template-client.js'

/** Codes worth asking again for (the app busy, restarting or the call cut off). */
const TEMPLATE_RETRY = new Set(['TIMEOUT', 'UNREACHABLE', 'HTTP_502', 'HTTP_503', 'HTTP_504'])
export const TEMPLATE_POLLS = 6
export const TEMPLATE_POLL_MS = 20_000

const yieldToIo = () => new Promise<void>((resolve) => setImmediate(resolve))

function count(report: Record<string, unknown>, key: string): number {
  const v = (report[key] as { created?: unknown } | undefined)?.created
  return typeof v === 'number' ? v : 0
}

/** What a refusal means to the operator (never the app's own text). */
export function templateRefusalText(code: string, collections?: string[]): string {
  if (code === 'HUB_LINK_MISSING')
    return `The app does not take templates: it runs a version older than ${TEMPLATE_MIN_VERSION}.`
  if (code === 'APP_NOT_EMPTY')
    return `The app already has collections of its own${
      collections?.length ? ` (${collections.slice(0, 5).join(', ')})` : ''
    }; a template is installed only into a new app.`
  if (code === 'BAD_DIGEST') return 'The app received a different bundle than the Hub sent.'
  if (code === 'BAD_BUNDLE') return 'The app could not read the template as a blueprint.'
  if (code === 'HUB_LINK_REFUSED')
    return "The app refused the Hub link: its HUB_TOKEN is not the Hub's."
  return `The app did not install the template (${code}).`
}

export async function stepTemplate(ctx: StepContext): Promise<StepResult> {
  const choice = await readTemplateInstall(ctx.env.id)
  if (!choice) return { status: 'done', note: 'No template.' }
  if (choice.status === 'done')
    return { status: 'done', note: choice.note ?? 'The template was installed.' }
  const t = await readTemplateBundle(choice.template_id)
  if (!t) {
    await setTemplateInstall(ctx.env.id, { status: 'failed', note: 'The template was deleted.' })
    throw new StepFailure('TEMPLATE_GONE', 'The picked template is no longer in the library.')
  }
  const plain = openSecret(ctx.env.hub_token)
  const token = plain ?? ''
  if (token) {
    ctx.secrets.add(token)
    ctx.secrets.add(Buffer.from(token).toString('base64'))
  }
  await setTemplateInstall(ctx.env.id, { status: 'installing', note: null })
  const payload = {
    bundle: t.bundle,
    digest: t.digest,
    template: { name: t.name, version: t.version }
  }
  let last = ''
  for (let i = 1; i <= TEMPLATE_POLLS; i++) {
    const r = await requestTemplateInstall(ctx.env.base_url, token, payload)
    if (r.result === 'installed') {
      const errors = Array.isArray(r.report.errors) ? r.report.errors.length : 0
      const note = `Template ${t.name} ${t.version} installed: +${count(r.report, 'collections')} collections, +${count(r.report, 'workflows')} workflows, +${count(r.report, 'queues')} queues${errors ? `, ${errors} parts skipped (see the app's install report)` : ''}.`
      await setTemplateInstall(ctx.env.id, { status: 'done', note, report: r.report })
      return { status: 'done', note }
    }
    if (!TEMPLATE_RETRY.has(r.code)) {
      const text = templateRefusalText(r.code, r.collections)
      await setTemplateInstall(ctx.env.id, { status: 'failed', note: `${r.code}: ${text}` })
      throw new StepFailure(r.code, text)
    }
    last = r.code
    if (i === 1) ctx.log(`Template: the app answered ${r.code}; asking again`)
    if (i < TEMPLATE_POLLS) {
      await ctx.deps.sleep(TEMPLATE_POLL_MS)
      await yieldToIo()
    }
  }
  const text = `The app did not answer the template install (${last}).`
  await setTemplateInstall(ctx.env.id, { status: 'failed', note: `${last}: ${text}` })
  throw new StepFailure(last || 'TEMPLATE_UNANSWERED', text)
}
