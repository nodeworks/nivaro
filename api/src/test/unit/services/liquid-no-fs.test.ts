import { describe, expect, it } from 'vitest'
import { liquidWithoutFiles } from '../../../services/liquid-no-fs.js'

describe('liquidWithoutFiles — PDF template engines read no files', () => {
  const engine = liquidWithoutFiles()

  it('renders template text as usual', async () => {
    expect(await engine.parseAndRender('Hi {{ n | upcase }}', { n: 'kim' })).toBe('Hi KIM')
  })

  it.each([
    "{% include 'package.json' %}",
    "{% render 'package.json' %}",
    "{% include '/etc/passwd' %}",
    "{% include '../.env' %}",
    "{% render './src/config.ts' %}",
    "{% layout 'package.json' %}x"
  ])('refuses %s', async (tpl) => {
    await expect(engine.parseAndRender(tpl, {})).rejects.toThrow()
  })
})
