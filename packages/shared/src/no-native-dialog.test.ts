import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A native browser dialog (window.confirm / alert / prompt) blocks the page's
// JS thread until someone answers it. An automated tab (Claude in Chrome, CDP,
// Playwright without a dialog handler) cannot see or dismiss it, so the tab
// hangs for good (army 10 item 3: BOM Re-Upload froze the record form), and an
// embedded host gets a bare browser box. Shared components ask in the app
// instead — ConfirmButton (components/profile/primitives.tsx), an inline
// confirm row, or a dialog. This guard covers every non-test source file.

const NATIVE = /\b(?:window|globalThis|self|top|parent)\s*\.\s*(?:confirm|alert|prompt)\s*\(/
// A bare call; not a member call (`w.confirm()`), not a declaration
// (`function confirm(`, `confirm(): void`, `confirm() {`).
const BARE = /(?<![\w$.])(?<!function\s+)(?:confirm|alert|prompt)\((?!\s*\)\s*[:{])/

/** Drop comments so prose that names `window.confirm` never trips the guard. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n')
}

function nativeDialogCalls(src: string): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = []
  stripComments(src)
    .split('\n')
    .forEach((text, i) => {
      if (NATIVE.test(text) || BARE.test(text)) hits.push({ line: i + 1, text: text.trim() })
    })
  return hits
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts'))
      out.push(full)
  }
  return out
}

describe('shared components open no native browser dialog', () => {
  it('the scanner finds native calls and ignores look-alikes', () => {
    const lines = (src: string) => nativeDialogCalls(src).map((h) => h.line)
    expect(lines("if (window.confirm('Delete?')) go()")).toEqual([1])
    expect(lines('window.alert(`x`)')).toEqual([1])
    expect(lines("const v = window.prompt('Name')")).toEqual([1])
    expect(lines("globalThis.confirm('x')")).toEqual([1])
    expect(lines('if (confirm(`Delete it?`)) go()')).toEqual([1])
    expect(lines("alert('saved')")).toEqual([1])
    expect(lines('  prompt("Name")')).toEqual([1])
    // look-alikes
    expect(lines('w.confirm()')).toEqual([])
    expect(lines('writer?.confirm()')).toEqual([])
    expect(lines('  confirm(): void')).toEqual([])
    expect(lines('  confirm() {')).toEqual([])
    expect(lines('function confirm(x) {}')).toEqual([])
    expect(lines('const onConfirm = () => doConfirm(id)')).toEqual([])
    expect(lines('// replaces window.confirm( here')).toEqual([])
    expect(lines('/* the old window.alert(...) */')).toEqual([])
    expect(lines("const url = 'https://x.test' // window.confirm(")).toEqual([])
  })

  it('no non-test file under packages/shared/src calls window.confirm / alert / prompt', () => {
    const root = dirname(fileURLToPath(import.meta.url))
    const offenders: string[] = []
    for (const file of sourceFiles(root)) {
      for (const hit of nativeDialogCalls(readFileSync(file, 'utf8')))
        offenders.push(`${relative(root, file)}:${hit.line}  ${hit.text}`)
    }
    expect(offenders).toEqual([])
  })
})
