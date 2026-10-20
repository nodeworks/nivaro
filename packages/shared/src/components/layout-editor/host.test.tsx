import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LayoutEditorHostContext, useLayoutEditorHost } from './host'
import { IconPicker } from './pickers/icon-picker'

const here = dirname(fileURLToPath(import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.(tsx?|json)$/.test(name) && !/\.test\./.test(name) ? [p] : []
  })
}

function Probe() {
  const host = useLayoutEditorHost()
  return (
    <span>
      {String(host.isAdmin)}|{host.recordLink('orders', '7')}|{host.aiReviewSlot?.(3)}
    </span>
  )
}

describe('layout editor host contract', () => {
  it('renders editor pieces with a minimal host', () => {
    const html = renderToStaticMarkup(
      <LayoutEditorHostContext.Provider
        value={{
          isAdmin: true,
          navigate: () => {},
          warning: null,
          recordLink: (c, id) => `/r/${c}/${id}`,
          aiReviewSlot: (id) => `review-${id}`
        }}
      >
        <Probe />
        <IconPicker value='' onChange={() => {}} />
      </LayoutEditorHostContext.Provider>
    )
    expect(html).toContain('true|/r/orders/7|review-3')
  })

  it('defaults to a non-admin host with no warning', () => {
    expect(renderToStaticMarkup(<Probe />)).toContain('false|/collections/orders/7|')
  })

  it('has no admin/ or @/ import anywhere under layout-editor/', () => {
    const bad: string[] = []
    for (const file of sourceFiles(here)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1]
        if (spec.startsWith('@/') || /(^|\/)admin\//.test(spec) || spec.includes('/admin/src')) {
          bad.push(`${file}: ${spec}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})
