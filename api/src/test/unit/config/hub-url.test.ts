import { afterEach, describe, expect, it, vi } from 'vitest'

// A compose passthrough (`HUB_URL: ${HUB_URL}`) hands an unset variable over as '' — that must
// read as unset, never stop cloud or EFP from booting (ruling P5-1).

describe('HUB_URL setting', () => {
  const saved = process.env.HUB_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.HUB_URL
    else process.env.HUB_URL = saved
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
