import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub enhancement 24: the creation's Template step. The library, the install rows and the app
// call are faked; the step's own rules are what is tested.

vi.mock('../../../services/hub/templates/choice.js', () => ({
  TEMPLATE_MIN_VERSION: '0.3.215',
  readTemplateInstall: vi.fn(),
  setTemplateInstall: vi.fn(async () => undefined)
}))
vi.mock('../../../services/hub/templates/library.js', () => ({ readTemplateBundle: vi.fn() }))
vi.mock('../../../services/hub/create/template-client.js', () => ({
  requestTemplateInstall: vi.fn()
}))
vi.mock('../../../services/hub/secrets.js', async (orig) => ({
  ...(await orig<object>()),
  openSecret: vi.fn(() => 'plain-hub-token-0123456789')
}))

const choice = await import('../../../services/hub/templates/choice.js')
const library = await import('../../../services/hub/templates/library.js')
const client = await import('../../../services/hub/create/template-client.js')
const { stepTemplate, TEMPLATE_POLLS, templateRefusalText } = await import(
  '../../../services/hub/create/template-step.js'
)
const { STEPS } = await import('../../../services/hub/create/steps.js')
const { STEP_ORDER } = await import('../../../services/hub/create/types.js')

const readInstall = vi.mocked(choice.readTemplateInstall)
const setInstall = vi.mocked(choice.setTemplateInstall)
const readBundle = vi.mocked(library.readTemplateBundle)
const install = vi.mocked(client.requestTemplateInstall)

const TEMPLATE = {
  id: 7,
  name: 'Assets',
  version: '1.0.0',
  digest: 'sha256:abc',
  bundle: { type: 'nivaro-blueprint-package' }
}

function ctx() {
  return {
    env: { id: 5, base_url: 'https://app.example.com', hub_token: 'sealed' },
    secrets: new Set<string>(),
    log: vi.fn(),
    deps: { sleep: vi.fn(async () => undefined) }
  } as never as Parameters<typeof stepTemplate>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  readBundle.mockResolvedValue(TEMPLATE as never)
})

describe('Template step', () => {
  it('runs last, after the first administrator', () => {
    expect(STEP_ORDER.at(-1)).toBe('template')
    expect(STEP_ORDER.indexOf('admin')).toBe(STEP_ORDER.length - 2)
    expect(STEPS.template).toBe(stepTemplate)
  })

  it('no template picked → done at once, the app is never called', async () => {
    readInstall.mockResolvedValue(null)
    expect(await stepTemplate(ctx())).toEqual({ status: 'done', note: 'No template.' })
    expect(install).not.toHaveBeenCalled()
  })

  it('an install already done stays done (a retry does not send it again)', async () => {
    readInstall.mockResolvedValue({ status: 'done', note: 'Installed earlier.' } as never)
    expect(await stepTemplate(ctx())).toEqual({ status: 'done', note: 'Installed earlier.' })
    expect(install).not.toHaveBeenCalled()
  })

  it('installs: sends bundle + digest with the token, keeps the report, names the counts', async () => {
    readInstall.mockResolvedValue({ status: 'pending', template_id: 7 } as never)
    install.mockResolvedValue({
      result: 'installed',
      report: {
        collections: { created: 2 },
        workflows: { created: 1 },
        queues: { created: 0 },
        errors: []
      },
      collections: ['assets']
    })
    const c = ctx()
    const out = await stepTemplate(c)
    expect(out.status).toBe('done')
    expect(out.note).toMatch(/Assets 1\.0\.0 installed: \+2 collections, \+1 workflows/)
    expect(install).toHaveBeenCalledWith('https://app.example.com', 'plain-hub-token-0123456789', {
      bundle: TEMPLATE.bundle,
      digest: 'sha256:abc',
      template: { name: 'Assets', version: '1.0.0' }
    })
    // The token is scrubbed from everything the runner stores.
    expect(c.secrets.has('plain-hub-token-0123456789')).toBe(true)
    expect(setInstall).toHaveBeenNthCalledWith(1, 5, { status: 'installing', note: null })
    expect(setInstall).toHaveBeenLastCalledWith(
      5,
      expect.objectContaining({ status: 'done', report: expect.any(Object) })
    )
  })

  it('a cut-off call is asked again; then it installs', async () => {
    readInstall.mockResolvedValue({ status: 'pending', template_id: 7 } as never)
    install
      .mockResolvedValueOnce({ result: 'refused', code: 'TIMEOUT' })
      .mockResolvedValueOnce({ result: 'installed', report: {}, collections: [] })
    const c = ctx()
    expect((await stepTemplate(c)).status).toBe('done')
    expect(install).toHaveBeenCalledTimes(2)
  })

  it('never answering → TEMPLATE fails with the last code after every poll', async () => {
    readInstall.mockResolvedValue({ status: 'pending', template_id: 7 } as never)
    install.mockResolvedValue({ result: 'refused', code: 'UNREACHABLE' })
    await expect(stepTemplate(ctx())).rejects.toMatchObject({ code: 'UNREACHABLE' })
    expect(install).toHaveBeenCalledTimes(TEMPLATE_POLLS)
    expect(setInstall).toHaveBeenLastCalledWith(5, expect.objectContaining({ status: 'failed' }))
  })

  it('an app that is not new refuses at once (APP_NOT_EMPTY), naming its collections', async () => {
    readInstall.mockResolvedValue({ status: 'pending', template_id: 7 } as never)
    install.mockResolvedValue({ result: 'refused', code: 'APP_NOT_EMPTY', collections: ['orders'] })
    await expect(stepTemplate(ctx())).rejects.toMatchObject({
      code: 'APP_NOT_EMPTY',
      message: expect.stringContaining('orders')
    })
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('a deleted template fails TEMPLATE_GONE', async () => {
    readInstall.mockResolvedValue({ status: 'pending', template_id: 7 } as never)
    readBundle.mockResolvedValue(null)
    await expect(stepTemplate(ctx())).rejects.toMatchObject({ code: 'TEMPLATE_GONE' })
  })

  it('an app older than the route reads as too old, never as the app’s own text', () => {
    expect(templateRefusalText('HUB_LINK_MISSING')).toMatch(/older than 0\.3\.215/)
    expect(templateRefusalText('HTTP_500')).toBe('The app did not install the template (HTTP_500).')
  })
})
