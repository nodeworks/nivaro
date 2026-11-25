import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub enhancement 24: the creation's Template step — start the install on the app, poll it, and
// end done / partial / failed. The library, the install rows and the app calls are faked.

vi.mock('../../../services/hub/templates/choice.js', () => ({
  TEMPLATE_MIN_VERSION: '0.3.215',
  readTemplateInstall: vi.fn(),
  setTemplateInstall: vi.fn(async () => undefined)
}))
vi.mock('../../../services/hub/templates/library.js', () => ({ readTemplateBundle: vi.fn() }))
vi.mock('../../../services/hub/create/template-client.js', () => ({
  startTemplateInstall: vi.fn(),
  readTemplateInstall: vi.fn()
}))
vi.mock('../../../services/hub/secrets.js', async (orig) => ({
  ...(await orig<object>()),
  openSecret: vi.fn(() => 'plain-hub-token-0123456789')
}))

const choice = await import('../../../services/hub/templates/choice.js')
const library = await import('../../../services/hub/templates/library.js')
const client = await import('../../../services/hub/create/template-client.js')
const { stepTemplate, TEMPLATE_STARTS, templateRefusalText } = await import(
  '../../../services/hub/create/template-step.js'
)
const { STEPS } = await import('../../../services/hub/create/steps.js')
const { DOCKER_STEP_ORDER, SHARED_STEP_ORDER, STEP_ORDER } = await import(
  '../../../services/hub/create/types.js'
)
const { destSteps } = await import('../../../services/hub/create/docker-steps.js')

const readRow = vi.mocked(choice.readTemplateInstall)
const setRow = vi.mocked(choice.setTemplateInstall)
const readBundle = vi.mocked(library.readTemplateBundle)
const start = vi.mocked(client.startTemplateInstall)
const poll = vi.mocked(client.readTemplateInstall)

const TEMPLATE = {
  id: 7,
  name: 'Assets',
  version: '1.0.0',
  digest: 'sha256:abc',
  bundle: { type: 'nivaro-blueprint-package' }
}
const REPORT = { collections: { created: 2 }, workflows: { created: 1 }, queues: { created: 0 } }
const run = (status: string, extra: Record<string, unknown> = {}) =>
  ({
    result: 'run',
    status,
    report: REPORT,
    parts: { ok: 3, failed: [] },
    code: null,
    ...extra
  }) as never

function ctx() {
  let clock = 0
  return {
    env: { id: 5, base_url: 'https://app.example.com', hub_token: 'sealed' },
    secrets: new Set<string>(),
    log: vi.fn(),
    deps: {
      sleep: vi.fn(async (ms: number) => {
        clock += ms
      }),
      now: () => clock
    }
  } as never as Parameters<typeof stepTemplate>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  readBundle.mockResolvedValue(TEMPLATE as never)
  readRow.mockResolvedValue({ status: 'pending', template_id: 7 } as never)
  start.mockResolvedValue({ result: 'started', install_id: 'run-0001' })
})

describe('Template step', () => {
  it('runs last, after the first administrator', () => {
    expect(STEP_ORDER.at(-1)).toBe('template')
    expect(STEP_ORDER.indexOf('admin')).toBe(STEP_ORDER.length - 2)
    expect(STEPS.template).toBe(stepTemplate)
    // Docker creations too (after their admin step); a shared creation has no app of its own.
    expect(DOCKER_STEP_ORDER.at(-1)).toBe('template')
    expect(DOCKER_STEP_ORDER.at(-2)).toBe('admin')
    expect(destSteps().template).toBe(stepTemplate)
    expect(SHARED_STEP_ORDER).not.toContain('template')
  })

  it('no template picked → done at once; a done row stays done (no call)', async () => {
    readRow.mockResolvedValueOnce(null)
    expect(await stepTemplate(ctx())).toEqual({ status: 'done', note: 'No template.' })
    readRow.mockResolvedValueOnce({ status: 'done', note: 'Installed earlier.' } as never)
    expect(await stepTemplate(ctx())).toEqual({ status: 'done', note: 'Installed earlier.' })
    expect(start).not.toHaveBeenCalled()
  })

  it('starts once, polls while running, ends done with the counts; the token is scrubbed', async () => {
    poll.mockResolvedValueOnce(run('running')).mockResolvedValueOnce(run('done'))
    const c = ctx()
    const out = await stepTemplate(c)
    expect(out.status).toBe('done')
    expect(out.note).toMatch(/Assets 1\.0\.0 installed: \+2 collections, \+1 workflows/)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith('https://app.example.com', 'plain-hub-token-0123456789', {
      bundle: TEMPLATE.bundle,
      digest: 'sha256:abc',
      template: { name: 'Assets', version: '1.0.0' }
    })
    expect(poll).toHaveBeenCalledWith(
      'https://app.example.com',
      'plain-hub-token-0123456789',
      'run-0001'
    )
    expect(c.secrets.has('plain-hub-token-0123456789')).toBe(true)
    expect(setRow).toHaveBeenLastCalledWith(5, expect.objectContaining({ status: 'done' }))
  })

  it('partial → TEMPLATE_PARTIAL, the row kept partial with its report (Retry runs it again)', async () => {
    poll.mockResolvedValueOnce(run('partial', { parts: { ok: 2, failed: ['workflow:w1'] } }))
    await expect(stepTemplate(ctx())).rejects.toMatchObject({
      code: 'TEMPLATE_PARTIAL',
      message: expect.stringContaining('workflow:w1')
    })
    expect(setRow).toHaveBeenLastCalledWith(
      5,
      expect.objectContaining({ status: 'partial', report: REPORT })
    )
  })

  it('an interrupted run (the app process died) is started again', async () => {
    start
      .mockResolvedValueOnce({ result: 'started', install_id: 'run-0001' })
      .mockResolvedValueOnce({ result: 'started', install_id: 'run-0002' })
    poll.mockResolvedValueOnce(run('interrupted')).mockResolvedValueOnce(run('done'))
    expect((await stepTemplate(ctx())).status).toBe('done')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('busy or frozen for a moment (TEMPLATE_INSTALLING / MAINTENANCE) asks again; then runs', async () => {
    start
      .mockResolvedValueOnce({ result: 'refused', code: 'TEMPLATE_INSTALLING' })
      .mockResolvedValueOnce({ result: 'refused', code: 'MAINTENANCE' })
      .mockResolvedValueOnce({ result: 'started', install_id: 'run-0003' })
    poll.mockResolvedValueOnce(run('done'))
    expect((await stepTemplate(ctx())).status).toBe('done')
  })

  it('never starting → fails with the last code after the allowed starts', async () => {
    start.mockResolvedValue({ result: 'refused', code: 'UNREACHABLE' })
    await expect(stepTemplate(ctx())).rejects.toMatchObject({ code: 'UNREACHABLE' })
    expect(start).toHaveBeenCalledTimes(TEMPLATE_STARTS)
  })

  it('an app that is not new refuses at once (APP_NOT_EMPTY), naming its collections', async () => {
    start.mockResolvedValue({ result: 'refused', code: 'APP_NOT_EMPTY', collections: ['orders'] })
    await expect(stepTemplate(ctx())).rejects.toMatchObject({
      code: 'APP_NOT_EMPTY',
      message: expect.stringContaining('orders')
    })
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('a moved app fails APP_MOVED; a deleted template fails TEMPLATE_GONE', async () => {
    poll.mockResolvedValue({ result: 'refused', code: 'APP_MOVED' })
    await expect(stepTemplate(ctx())).rejects.toMatchObject({ code: 'APP_MOVED' })
    readBundle.mockResolvedValue(null)
    await expect(stepTemplate(ctx())).rejects.toMatchObject({ code: 'TEMPLATE_GONE' })
  })

  it('an app older than the route reads as too old, never as the app’s own text', () => {
    expect(templateRefusalText('HUB_LINK_MISSING')).toMatch(/older than 0\.3\.215/)
    expect(templateRefusalText('HTTP_500')).toBe('The app did not install the template (HTTP_500).')
  })
})
