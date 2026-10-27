// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { maskScreenshotClone, redactConsoleLine } from './bug-report-redact'

describe('redactConsoleLine', () => {
  it('redacts bearer values, JWTs and Nivaro tokens', () => {
    const out = redactConsoleLine(
      'GET failed Authorization: Bearer abcdefghijklmnop123 eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4 nvo_0123456789abcdefXYZ'
    )
    expect(out).not.toContain('abcdefghijklmnop123')
    expect(out).not.toContain('eyJhbGciOiJIUzI1')
    expect(out).not.toContain('nvo_0123456789abcdefXYZ')
    expect(out).toContain('GET failed')
  })

  it('redacts secret query parameters and JSON fields', () => {
    const out = redactConsoleLine(
      '/api/help-videos/x/stream?st=SIGNED123&w=10 {"access_token":"tok-secret","name":"Ann"} password=hunter2'
    )
    expect(out).not.toContain('SIGNED123')
    expect(out).not.toContain('tok-secret')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('w=10')
    expect(out).toContain('"name":"Ann"')
  })

  it('leaves an ordinary message alone', () => {
    expect(redactConsoleLine('[warn] Each child in a list should have a unique key')).toBe(
      '[warn] Each child in a list should have a unique key'
    )
  })
})

describe('maskScreenshotClone', () => {
  it('blanks never-record regions and masks password inputs', () => {
    document.body.innerHTML = `
      <div class="nvr-no-record"><span style="visibility:visible">secret chat</span></div>
      <section data-replay-block>blocked</section>
      <input type="password" value="hunter2">
      <input type="text" name="title" value="Visible title">`
    maskScreenshotClone(document)
    expect(document.body.textContent).not.toContain('secret chat')
    expect(document.body.textContent).not.toContain('blocked')
    const [pw, title] = Array.from(document.querySelectorAll('input'))
    expect(pw.value).not.toBe('hunter2')
    expect(title.value).toBe('Visible title')
  })
})
