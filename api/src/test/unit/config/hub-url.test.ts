import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A compose passthrough (`HUB_URL: ${HUB_URL}`) hands an unset variable over as '' — that must
// read as unset, never stop cloud or EFP from booting (ruling P5-1).

describe('HUB_URL setting', () => {
  // Importing config.ts writes to process.env: DB_URL fills the DB_* variables
  // (applyDbUrlToProcess), DB_CLIENT=sqlite fills DB_HOST / DB_USER / DB_PASSWORD, X_FILE values
  // land as X (applyEnvFiles). Snapshot the whole environment and put it back after each case.
  let saved: NodeJS.ProcessEnv = {}
  beforeEach(() => {
    saved = { ...process.env }
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    for (const [k, v] of Object.entries(saved)) process.env[k] = v
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('blank is unset, a URL is kept, anything else is refused', async () => {
    const { hubUrlSetting } = await import('../../../config.js')
    expect(hubUrlSetting.parse('')).toBeUndefined()
    expect(hubUrlSetting.parse('   ')).toBeUndefined()
    expect(hubUrlSetting.parse(undefined)).toBeUndefined()
    expect(hubUrlSetting.parse('https://hub.example')).toBe('https://hub.example')
    expect(hubUrlSetting.safeParse('not a url').success).toBe(false)
  })

  it.each(['', '  '])('config boots with HUB_URL=%j', async (v) => {
    process.env.HUB_URL = v
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.resetModules()
    const { config } = await import('../../../config.js')
    expect(exit).not.toHaveBeenCalled()
    expect(config.HUB_URL).toBeUndefined()
  })
})
