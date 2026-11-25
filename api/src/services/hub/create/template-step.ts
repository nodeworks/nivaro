// The creation's last step (Hub enhancement 24): install the template the operator picked on
// Create app into this environment, over its hub link, once the first administrator exists. No
// template picked → done at once ("No template"). A done install stays done.
//
// The app runs the install in the background (review M2): the step starts it (POST → install id),
// then reads its status every TEMPLATE_POLL_MS until it ends or TEMPLATE_DEADLINE_MS passes. One
// install at a time runs on the app (its Redis lock); starting it again while it runs joins that
// run. A run that ends `partial` (some parts failed; each workflow, layout and queue goes in whole
// or not at all) fails this step with TEMPLATE_PARTIAL and keeps the report: Retry starts it again
// and the app installs the parts still missing. A run whose app process died reads `interrupted`
// and is started again (up to TEMPLATE_STARTS times in one leg).
//
// The hub token is opened for the calls only and added to ctx.secrets (scrubbed from every note,
// log line and error); the bundle travels in the body, never a note.
import { openSecret } from '../secrets.js'
import { TEMPLATE_MIN_VERSION } from '../templates/min-version.js'
import { type BaseStepContext, StepFailure, type StepResult } from './steps.js'
import { readTemplateInstall, startTemplateInstall } from './template-client.js'

/** Codes worth asking again for (the app busy, frozen for a moment, restarting, or cut off). */
const TEMPLATE_RETRY = new Set([
  'TIMEOUT',
  'UNREACHABLE',
  'MAINTENANCE',
  'TEMPLATE_INSTALLING',
  'REDIS_UNAVAILABLE',
  'HTTP_502',
  'HTTP_503',
  'HTTP_504'
])
export const TEMPLATE_POLL_MS = 10_000
export const TEMPLATE_DEADLINE_MS = 60 * 60_000
/** Starts (the first, a refused-for-now retry, an interrupted run) within one leg. */
export const TEMPLATE_STARTS = 8
/** Status reads in a row that may fail (the app restarting) before the step gives up. */
export const TEMPLATE_READ_MISSES = 12

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
  if (code === 'APP_MOVED') return 'The app has moved away from this home; nothing was installed.'
  if (code === 'BAD_DIGEST') return 'The app received a different bundle than the Hub sent.'
  if (code === 'BAD_BUNDLE' || code === 'BAD_SHAPE')
    return 'The app could not read the template as a blueprint.'
  if (code === 'TOO_MANY_PARTS') return 'The template is larger than an app takes.'
  if (code === 'HUB_LINK_REFUSED')
    return "The app refused the Hub link: its HUB_TOKEN is not the Hub's."
  return `The app did not install the template (${code}).`
}

export async function stepTemplate(ctx: BaseStepContext): Promise<StepResult> {
  // Loaded on use: the library reaches the blueprint installer, which the creation steps' other
  // importers (move, shared routing) must not load at module time.
  const { readTemplateInstall: readInstallRow, setTemplateInstall } = await import(
    '../templates/choice.js'
  )
  const { readTemplateBundle } = await import('../templates/library.js')
  const choice = await readInstallRow(ctx.env.id)
  if (!choice) return { status: 'done', note: 'No template.' }
  if (choice.status === 'done')
    return { status: 'done', note: choice.note ?? 'The template was installed.' }
  const t = await readTemplateBundle(choice.template_id)
  if (!t) {
    await setTemplateInstall(ctx.env.id, { status: 'failed', note: 'The template was deleted.' })
    throw new StepFailure('TEMPLATE_GONE', 'The picked template is no longer in the library.')
  }
  const token = openSecret(ctx.env.hub_token) ?? ''
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
  const fail = async (code: string, text: string, report?: Record<string, unknown>) => {
    await setTemplateInstall(ctx.env.id, {
      status: code === 'TEMPLATE_PARTIAL' ? 'partial' : 'failed',
      note: `${code}: ${text}`,
      ...(report ? { report } : {})
    })
    return new StepFailure(code, text)
  }
  const started = ctx.deps.now()
  const late = () => ctx.deps.now() - started > TEMPLATE_DEADLINE_MS
  const wait = async () => {
    await ctx.deps.sleep(TEMPLATE_POLL_MS)
    await yieldToIo()
  }

  let starts = 0
  let last = ''
  while (starts < TEMPLATE_STARTS && !late()) {
    starts++
    const s = await startTemplateInstall(ctx.env.base_url, token, payload)
    if (s.result === 'refused') {
      if (!TEMPLATE_RETRY.has(s.code))
        throw await fail(s.code, templateRefusalText(s.code, s.collections))
      last = s.code
      if (starts === 1) ctx.log(`Template: the app answered ${s.code}; asking again`)
      await wait()
      continue
    }
    let misses = 0
    while (!late()) {
      await wait()
      const r = await readTemplateInstall(ctx.env.base_url, token, s.install_id)
      if (r.result === 'refused') {
        if (r.code === 'UNKNOWN_INSTALL' || r.code === 'APP_MOVED') {
          last = r.code
          break
        }
        last = r.code
        if (++misses >= TEMPLATE_READ_MISSES) break
        continue
      }
      misses = 0
      if (r.status === 'running') continue
      if (r.status === 'interrupted') {
        last = 'INTERRUPTED'
        ctx.log('Template: the app stopped during the install; starting it again')
        break
      }
      const counts = `+${count(r.report, 'collections')} collections, +${count(r.report, 'workflows')} workflows, +${count(r.report, 'queues')} queues`
      if (r.status === 'done') {
        const note = `Template ${t.name} ${t.version} installed: ${counts}.`
        await setTemplateInstall(ctx.env.id, { status: 'done', note, report: r.report })
        return { status: 'done', note }
      }
      if (r.status === 'partial')
        throw await fail(
          'TEMPLATE_PARTIAL',
          `Template ${t.name} ${t.version} installed in part (${counts}); ${r.parts.failed.length || 'some'} parts failed${
            r.parts.failed.length ? ` (${r.parts.failed.slice(0, 3).join(', ')})` : ''
          }. Retry installs what is missing.`,
          r.report
        )
      throw await fail(
        r.code ?? 'TEMPLATE_FAILED',
        'The app could not install the template; Retry starts it again.'
      )
    }
    if (last === 'APP_MOVED') throw await fail('APP_MOVED', templateRefusalText('APP_MOVED'))
  }
  const code = late() ? 'TEMPLATE_UNANSWERED' : last || 'TEMPLATE_UNANSWERED'
  throw await fail(code, `The app did not finish the template install (${last || 'no answer'}).`)
}
