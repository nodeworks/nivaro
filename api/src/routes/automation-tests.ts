import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { executeFlow, type FlowTraceStep } from '../services/flow-executor.js'

/**
 * Automation regression suite. Each test dry-runs its flow with a saved
 * payload (side-effect ops RENDER but never send — the flow tester's
 * machinery) and asserts expectations against the trace: no rejected steps,
 * specific op outcomes, rendered previews containing strings, output values.
 * Run one, or the whole suite — red/green per test, recorded as a job run.
 */

interface Expectations {
  no_errors?: boolean
  min_steps?: number
  op_statuses?: Record<string, 'resolve' | 'reject'>
  preview_contains?: string[]
  output_contains?: Array<{ path: string; value: unknown }>
}

function parseJson<T>(raw: unknown): T | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'object') return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return null
  }
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

interface TestRow {
  id: number
  name: string
  flow_id: string
  payload: string | null
  expectations: string | null
  is_active: boolean
}

async function runOneTest(
  app: FastifyInstance,
  test: TestRow,
  userId: string | undefined
): Promise<{ status: 'pass' | 'fail'; detail: string }> {
  const flow = await db('nivaro_flows').where({ id: test.flow_id }).first('id', 'name')
  if (!flow) return { status: 'fail', detail: 'Flow no longer exists' }

  const trace: FlowTraceStep[] = []
  let output: Record<string, unknown> = {}
  let runError: string | null = null
  try {
    output = await executeFlow({
      flowId: String(flow.id),
      flowName: String(flow.name),
      trigger: 'test',
      payload: parseJson<Record<string, unknown>>(test.payload) ?? {},
      log: app.log,
      userId,
      dryRun: true,
      trace
    })
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err)
  }

  const exp = parseJson<Expectations>(test.expectations) ?? { no_errors: true }
  const failures: string[] = []
  if (runError) failures.push(`flow errored: ${runError}`)
  if (exp.no_errors !== false) {
    for (const s of trace) {
      if (s.status === 'reject') failures.push(`step "${s.name}" (${s.type}) rejected`)
    }
  }
  if (exp.min_steps != null && trace.length < exp.min_steps) {
    failures.push(`only ${trace.length} step(s) ran (expected ≥ ${exp.min_steps})`)
  }
  for (const [key, want] of Object.entries(exp.op_statuses ?? {})) {
    const step = trace.find((s) => s.key === key || s.name === key)
    if (!step) failures.push(`op "${key}" never ran`)
    else if (step.status !== want) failures.push(`op "${key}" was ${step.status} (expected ${want})`)
  }
  for (const needle of exp.preview_contains ?? []) {
    const all = trace.map((s) => JSON.stringify(s.preview ?? '')).join('\n')
    if (!all.includes(needle)) failures.push(`no rendered preview contains "${needle}"`)
  }
  for (const oc of exp.output_contains ?? []) {
    const actual = getPath(output, oc.path)
    if (String(actual) !== String(oc.value)) {
      failures.push(`output ${oc.path} = ${JSON.stringify(actual)} (expected ${JSON.stringify(oc.value)})`)
    }
  }

  const status = failures.length === 0 ? 'pass' : 'fail'
  const detail =
    status === 'pass'
      ? `${trace.length} step(s), all expectations met`
      : failures.join('; ').slice(0, 2000)
  await db('nivaro_automation_tests')
    .where('id', test.id)
    .update({ last_status: status, last_run_at: new Date(), last_detail: detail })
  return { status, detail }
}

export async function automationTestRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const rows = await db('nivaro_automation_tests as t')
      .leftJoin('nivaro_flows as f', 'f.id', 't.flow_id')
      .orderBy('t.id', 'asc')
      .select('t.*', 'f.name as flow_name')
    return {
      data: rows.map((r: Record<string, unknown>) => ({
        ...r,
        payload: parseJson(r.payload),
        expectations: parseJson(r.expectations)
      }))
    }
  })

  app.post('/', async (req, reply) => {
    const b = req.body as {
      name?: string
      flow_id?: string
      payload?: unknown
      expectations?: unknown
      is_active?: boolean
    }
    const name = String(b.name ?? '').trim()
    if (!name || !b.flow_id) return reply.code(400).send({ error: 'name and flow_id are required' })
    const flow = await db('nivaro_flows').where({ id: b.flow_id }).first('id')
    if (!flow) return reply.code(404).send({ error: 'Flow not found' })
    const [inserted] = await db('nivaro_automation_tests')
      .insert({
        name: name.slice(0, 300),
        flow_id: b.flow_id,
        payload: b.payload ? JSON.stringify(b.payload) : null,
        expectations: b.expectations ? JSON.stringify(b.expectations) : null,
        is_active: b.is_active !== false,
        created_by: req.user?.id ?? null,
        created_at: new Date()
      })
      .returning('id')
    const id = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    await logActivity({ action: 'automation-test-create', user: req.user?.id, item: String(id), comment: name, req })
    return reply.code(201).send({ data: { id } })
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_automation_tests').where('id', req.params.id).first('id')
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const b = req.body as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 300)
    if (b.payload !== undefined) patch.payload = b.payload ? JSON.stringify(b.payload) : null
    if (b.expectations !== undefined) patch.expectations = b.expectations ? JSON.stringify(b.expectations) : null
    if (b.is_active !== undefined) patch.is_active = !!b.is_active
    if (Object.keys(patch).length > 0) await db('nivaro_automation_tests').where('id', row.id).update(patch)
    return { data: { id: row.id } }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_automation_tests').where('id', req.params.id).first('id', 'name')
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_automation_tests').where('id', row.id).del()
    await logActivity({ action: 'automation-test-delete', user: req.user?.id, item: String(row.id), comment: String(row.name), req })
    return { data: { deleted: true } }
  })

  app.post<{ Params: { id: string } }>('/:id/run', async (req, reply) => {
    const test = (await db('nivaro_automation_tests').where('id', req.params.id).first()) as TestRow | undefined
    if (!test) return reply.code(404).send({ error: 'Not found' })
    const result = await runOneTest(app, test, req.user?.id)
    return { data: result }
  })

  /** Run the whole suite, sequentially (dry runs are cheap; order keeps the
   *  output readable). Recorded as a job run; failures summarized. */
  app.post('/run', async (req) => {
    const tests = (await db('nivaro_automation_tests').where('is_active', true)) as TestRow[]
    const { startJobRun } = await import('../services/job-runs.js')
    const run = await startJobRun('cron', 'automation-suite', { triggeredBy: req.user?.id ?? null })
    const results: Array<{ id: number; name: string; status: string; detail: string }> = []
    let failed = 0
    try {
      for (const t of tests) {
        const r = await runOneTest(app, t, req.user?.id)
        results.push({ id: t.id, name: t.name, status: r.status, detail: r.detail })
        if (r.status === 'fail') failed++
        run.progress({ done: results.length, total: tests.length, failed })
      }
      const summary = `${tests.length - failed}/${tests.length} passed${failed ? ` — failing: ${results.filter((r) => r.status === 'fail').map((r) => r.name).join(', ').slice(0, 300)}` : ''}`
      if (failed > 0) await run.fail(summary)
      else await run.complete(summary)
      await logActivity({ action: 'automation-suite-run', user: req.user?.id, comment: summary.slice(0, 300), req })
      return { data: { total: tests.length, failed, results } }
    } catch (err) {
      await run.fail(err)
      throw err
    }
  })
}
