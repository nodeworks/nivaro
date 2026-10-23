import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isCodeError, reportCodeError, SOMETHING_WENT_WRONG, userErrorMessage } from './safe-error'

vi.mock('./client-crash', () => ({ reportClientCrash: vi.fn(async () => undefined) }))

describe('userErrorMessage — never raw JavaScript error text', () => {
  it('a code error reads as one plain sentence', () => {
    const bug = new TypeError("Cannot read properties of null (reading 'id')")
    expect(isCodeError(bug)).toBe(true)
    expect(userErrorMessage(bug)).toBe(SOMETHING_WENT_WRONG)
    expect(userErrorMessage(new ReferenceError('x is not defined'))).toBe(SOMETHING_WENT_WRONG)
  })

  it('the server’s own explanation wins (SDK and axios shapes)', () => {
    expect(userErrorMessage({ response: { error: 'Zone is required' } })).toBe('Zone is required')
    expect(userErrorMessage({ response: { data: { error: 'Choose a Zone' } } })).toBe(
      'Choose a Zone'
    )
    // A coded refusal: the status word is not an explanation, the message is.
    expect(
      userErrorMessage({
        response: { error: 'Unprocessable Entity', message: 'Choose a Zone you have access to' }
      })
    ).toBe('Choose a Zone you have access to')
  })

  it('a network failure and a plain Error keep their message', () => {
    expect(isCodeError(new TypeError('Failed to fetch'))).toBe(false)
    expect(userErrorMessage(new TypeError('Failed to fetch'))).toBe('Failed to fetch')
    expect(userErrorMessage(new Error('Lines did not save'))).toBe('Lines did not save')
    expect(userErrorMessage(undefined, 'Save failed')).toBe('Save failed')
  })

  it('reports a code error once, and nothing else', async () => {
    const { reportClientCrash } = await import('./client-crash')
    const client = { request: vi.fn() }
    const bug = new TypeError('boom')
    reportCodeError(client as never, bug)
    reportCodeError(client as never, bug)
    reportCodeError(client as never, new Error('server said no'))
    expect(reportClientCrash).toHaveBeenCalledTimes(1)
  })
})

// Lint-style guard: a create's answer may hide the row from its writer
// (data {id} + meta.readable false; an older server answered data null). Code
// that POSTs to /items and then reads `.data.<x>` without `?.` crashed on
// exactly that (2026-10-23). New code must read `r?.data?.id` (or meta.id).
describe('no unguarded read of an /items create answer', () => {
  const SRC = join(__dirname, '..')
  const REACT = join(__dirname, '..', '..', '..', 'react', 'src')
  const files: string[] = []
  const walk = (dir: string) => {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      if (n === 'node_modules' || n === 'dist' || n === '__tests__') continue
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(p)
    }
  }
  walk(SRC)
  walk(REACT)

  it('every POST /items/<collection> answer is read with optional chaining', () => {
    const offenders: string[] = []
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/post(<[^>]*>)?\(\s*`\/items\/\$\{/.test(line)) return
        if (/\/items\/\$\{[^}]+\}\/(batch|bulk|import|export|aggregate|auto-id|[^`]*-)/.test(line))
          return
        // The next lines that read the answer (until the statement settles).
        for (let j = i; j < Math.min(i + 8, lines.length); j++) {
          const l = lines[j]
          if (/\b\w+\.data\.\w+/.test(l) && !/\.data\?\./.test(l) && !/\?\.data\b/.test(l))
            offenders.push(`${relative(SRC, f)}:${j + 1}: ${l.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
