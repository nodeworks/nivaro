import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  type ContractTest,
  compareInputSchema,
  compareShapes,
  countTests,
  deleteTest,
  insertTest,
  listTests,
  MAX_TESTS,
  type RunOutcome,
  readTest,
  recordRun,
  type Shape,
  shapeOf,
  testsReady,
  updateTest
} from '../services/mcp-contract-tests.js'
import {
  base,
  type ConsoleCall,
  compactOf,
  connect,
  consoleFetch,
  hasDryRunArg,
  isWrite,
  type ToolInfo
} from './mcp-console.js'

/**
 * Tool contract tests (#3215) — /api/mcp-console/tests, administrators only.
 *
 *   GET    /             every saved test with its last run
 *   POST   /             {name, tool, arguments, output, is_error} — save a call just run in the
 *                        console (the input schema is read from the tool itself, now)
 *   PATCH  /:id          {name?, enabled?, accept?: true} — accept = the last run's schema and
 *                        shape become the contract
 *   DELETE /:id
 *   POST   /run          {ids?} — run the enabled tests (or the ones named): { summary, results }
 *
 * A run builds the same MCP server the console does, as the administrator running it, and holds
 * every write a tool would send (dry run) exactly like the console — a test never stores
 * anything. scripts/mcp-contract-tests.mjs calls POST /run with an administrator's API key and
 * exits 1 when a test fails (CI).
 */

const MAX_OUTPUT_CHARS = 400_000
const RUN_TIMEOUT_MS = 60_000
const NAME_MAX = 120
const TOOL_RE = /^[a-z][a-z0-9_]{0,63}$/

const notReady = {
  error: 'Contract tests need database migration 509 — they work once it has run',
  code: 'MCP_TESTS_NOT_READY'
}

type Result = {
  id: number
  name: string
  tool: string
  status: 'pass' | 'fail' | 'error'
  ms: number
  outcome: RunOutcome
}

/** Run tests in one MCP session as the caller. Writes are held (dry run). */
async function runTests(
  app: FastifyInstance,
  req: FastifyRequest,
  tests: ContractTest[]
): Promise<Result[]> {
  const calls: ConsoleCall[] = []
  let holding = false
  const mcp = await connect(
    req,
    consoleFetch(base(app, req), calls, () => holding)
  )
  const out: Result[] = []
  try {
    const { tools } = await mcp.client.listTools()
    for (const test of tests) {
      const t0 = performance.now()
      const ms = () => Math.round(performance.now() - t0)
      const tool = (tools as ToolInfo[]).find((t) => t.name === test.tool)
      if (!tool) {
        out.push({
          id: test.id,
          name: test.name,
          tool: test.tool,
          status: 'fail',
          ms: ms(),
          outcome: {
            problems: [`${test.tool} is not one of your MCP tools any more`],
            notes: []
          }
        })
        continue
      }
      const schema = (tool.inputSchema ?? {}) as Parameters<typeof compareInputSchema>[1]
      const input = compareInputSchema(test.input_schema, schema, test.arguments)
      const args = { ...test.arguments }
      const write = isWrite(tool)
      if (write && hasDryRunArg(tool)) args.dry_run = true
      holding = write
      try {
        const result = await mcp.client.callTool({ name: test.tool, arguments: args }, undefined, {
          timeout: RUN_TIMEOUT_MS
        })
        const isError = result.isError === true
        const compact = compactOf(result as { content?: unknown })
        const shape = shapeOf(compact.value)
        const problems = [...input.problems]
        const notes = [...input.notes]
        if (isError !== test.expect_error)
          problems.push(
            isError
              ? `It failed: ${messageOf(compact.value)}`
              : 'It answered where it used to refuse'
          )
        else if (!isError) {
          const v = compareShapes(test.output_shape, shape)
          problems.push(...v.problems)
          notes.push(...v.notes)
        }
        out.push({
          id: test.id,
          name: test.name,
          tool: test.tool,
          status: problems.length ? 'fail' : 'pass',
          ms: ms(),
          outcome: {
            problems,
            notes,
            observed: { input_schema: schema ?? null, output_shape: shape, is_error: isError }
          }
        })
      } catch (err) {
        out.push({
          id: test.id,
          name: test.name,
          tool: test.tool,
          status: 'error',
          ms: ms(),
          outcome: {
            problems: input.problems,
            notes: input.notes,
            message: (err as Error).message?.slice(0, 500) || 'The call failed'
          }
        })
      } finally {
        holding = false
      }
    }
  } finally {
    await mcp.close()
  }
  return out
}

function messageOf(v: unknown): string {
  if (v && typeof v === 'object' && 'error' in v) return String((v as { error: unknown }).error)
  return typeof v === 'string' ? v.slice(0, 200) : 'an error'
}

export async function mcpContractTestRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async (_req, reply) => {
    if (!(await testsReady())) return reply.code(409).send(notReady)
    return { data: { tests: await listTests() } }
  })

  app.post('/', async (req, reply) => {
    if (!(await testsReady())) return reply.code(409).send(notReady)
    const body = (req.body ?? {}) as Record<string, unknown>
    const tool = typeof body.tool === 'string' ? body.tool : ''
    if (!TOOL_RE.test(tool)) return reply.code(400).send({ error: 'Name the tool' })
    const name =
      String(body.name ?? '')
        .trim()
        .slice(0, NAME_MAX) || tool
    const args =
      body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
        ? { ...(body.arguments as Record<string, unknown>) }
        : {}
    // The console adds dry_run itself on each run; the contract is the person's own inputs.
    delete args.dry_run
    if (JSON.stringify(args).length > 50_000)
      return reply.code(400).send({ error: 'The arguments are too large to keep' })
    const raw = JSON.stringify(body.output ?? null)
    if (raw.length > MAX_OUTPUT_CHARS)
      return reply.code(400).send({ error: 'The answer is too large to take a shape from' })
    if ((await countTests()) >= MAX_TESTS)
      return reply.code(400).send({ error: `At most ${MAX_TESTS} contract tests` })
    // The input schema comes from the tool as it is now, not from the browser.
    const mcp = await connect(req, base(app, req))
    let schema: unknown
    try {
      const { tools } = await mcp.client.listTools()
      const found = (tools as ToolInfo[]).find((t) => t.name === tool)
      if (!found) return reply.code(404).send({ error: `${tool} is not one of your MCP tools` })
      schema = found.inputSchema ?? {}
    } finally {
      await mcp.close()
    }
    const test = await insertTest({
      name,
      tool,
      arguments: args,
      input_schema: schema,
      output_shape: shapeOf(body.output ?? null) as Shape,
      expect_error: body.is_error === true,
      source: body.source === 'connection' ? 'connection' : 'console',
      source_ref: typeof body.source_ref === 'string' ? body.source_ref.slice(0, 64) || null : null,
      created_by: String(req.user!.id)
    })
    await logActivity({
      action: 'mcp-contract-test',
      user: req.user!.id,
      comment: `saved ${test.id} (${tool})`,
      req
    })
    return { data: test }
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!(await testsReady())) return reply.code(409).send(notReady)
    const id = Number(req.params.id)
    const test = Number.isInteger(id) ? await readTest(id) : null
    if (!test) return reply.code(404).send({ error: 'Test not found' })
    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if (typeof body.name === 'string' && body.name.trim())
      patch.name = body.name.trim().slice(0, NAME_MAX)
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (body.accept === true) {
      const seen = test.last_result?.observed
      if (!seen)
        return reply.code(409).send({ error: 'Run the test first — there is nothing to accept' })
      patch.input_schema = JSON.stringify(seen.input_schema ?? {})
      if (seen.output_shape) patch.output_shape = JSON.stringify(seen.output_shape)
      patch.expect_error = seen.is_error
      patch.last_status = 'pass'
      patch.last_result = JSON.stringify({
        problems: [],
        notes: ['Changes accepted'],
        observed: seen
      })
    }
    if (!Object.keys(patch).length) return reply.code(400).send({ error: 'Nothing to change' })
    await updateTest(id, patch)
    if (body.accept === true)
      await logActivity({
        action: 'mcp-contract-test',
        user: req.user!.id,
        comment: `accepted changes on ${id} (${test.tool})`,
        req
      })
    return { data: await readTest(id) }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!(await testsReady())) return reply.code(409).send(notReady)
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || !(await deleteTest(id)))
      return reply.code(404).send({ error: 'Test not found' })
    await logActivity({
      action: 'mcp-contract-test',
      user: req.user!.id,
      comment: `removed ${id}`,
      req
    })
    return { data: { removed: true } }
  })

  app.post('/run', async (req, reply) => {
    if (!(await testsReady())) return reply.code(409).send(notReady)
    const body = (req.body ?? {}) as { ids?: unknown }
    const ids = Array.isArray(body.ids)
      ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : []
    const tests = (await listTests(ids.length ? ids : undefined)).filter(
      (t) => ids.length > 0 || t.enabled
    )
    const results = await runTests(app, req, tests)
    await Promise.all(results.map((r) => recordRun(r.id, r.status, r.outcome, r.ms)))
    const summary = {
      total: results.length,
      passed: results.filter((r) => r.status === 'pass').length,
      failed: results.filter((r) => r.status === 'fail').length,
      errored: results.filter((r) => r.status === 'error').length
    }
    if (results.length)
      await logActivity({
        action: 'mcp-contract-run',
        user: req.user!.id,
        comment: `${summary.passed}/${summary.total} passed`,
        req
      })
    return { data: { summary, results } }
  })
}
