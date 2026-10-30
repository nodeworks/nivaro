import { describe, expect, it } from 'vitest'
import type { NavCategory } from './nav-config'
import {
  applyNavLayout,
  effectiveNavLayout,
  moveItem,
  type NavLayout,
  PINNED_SECTION,
  parseNavLayout,
  permittedCategories,
  resetCategory,
  toggleHidden,
  togglePinned
} from './nav-layout'

const Icon = () => null
const cats: NavCategory[] = [
  {
    id: 'home',
    icon: Icon,
    label: 'Home',
    items: [
      { icon: Icon, label: 'Overview', to: '/' },
      { icon: Icon, label: 'My Work', to: '/my-work' },
      { icon: Icon, label: 'Tasks', to: '/tasks' },
      { icon: Icon, label: 'Chat', to: '/chat' }
    ]
  },
  {
    id: 'content',
    icon: Icon,
    label: 'Data',
    items: [
      { icon: Icon, label: 'Collections', to: '/collections', section: 'Records' },
      { icon: Icon, label: 'Files', to: '/files', section: 'Records' },
      { icon: Icon, label: 'Imports', to: '/imports', section: 'Bulk' },
      { icon: Icon, label: 'Find & Replace', to: '/find-replace', section: 'Bulk' }
    ]
  },
  {
    id: 'operations',
    icon: Icon,
    label: 'Operations',
    // a hub entry: /jobs opens its first allowed tab
    items: [{ icon: Icon, label: 'Jobs', to: '/jobs' }]
  }
]

const labels = (c: { items: Array<{ label: string }> }) => c.items.map((i) => i.label)

describe('permittedCategories', () => {
  it('drops what the role cannot open, by prefix, and empty categories', () => {
    const out = permittedCategories(
      cats,
      new Set(['/tasks', '/files', '/imports', '/find-replace'])
    )
    expect(labels(out[0])).toEqual(['Overview', 'My Work', 'Chat'])
    expect(labels(out[1])).toEqual(['Collections'])
  })

  it('keeps a hub while one tab is allowed and opens that tab; key stays the base', () => {
    const out = permittedCategories(cats, new Set(['/background-jobs']))
    const jobs = out.find((c) => c.id === 'operations')?.items[0]
    expect(jobs?.key).toBe('/jobs')
    expect(jobs?.to).toBe('/jobs/timeline')
  })
})

describe('applyNavLayout', () => {
  const base = permittedCategories(cats, new Set())

  it('no layout = the default', () => {
    expect(applyNavLayout(base, null)).toBe(base)
  })

  it('pins to a Pinned block on top, hides, orders inside sections', () => {
    const layout: NavLayout = {
      v: 1,
      categories: {
        home: { pinned: ['/chat'], hidden: ['/tasks'] },
        content: { order: ['/find-replace', '/files'] }
      }
    }
    const [home, content] = applyNavLayout(base, layout)
    expect(labels(home)).toEqual(['Chat', 'Overview', 'My Work'])
    expect(home.items[0].section).toBe(PINNED_SECTION)
    expect(home.items[1].section).toBe('More')
    // sections keep their order; inside each, the named order wins
    expect(labels(content)).toEqual(['Files', 'Collections', 'Find & Replace', 'Imports'])
  })

  it('includeHidden keeps hidden items, flagged, for the customise view', () => {
    const layout: NavLayout = { v: 1, categories: { home: { hidden: ['/tasks'] } } }
    const [home] = applyNavLayout(base, layout, { includeHidden: true })
    expect(home.items.find((i) => i.key === '/tasks')?.hidden).toBe(true)
  })

  it('a layout can never surface what the permission filter removed', () => {
    const restricted = permittedCategories(cats, new Set(['/tasks', '/files']))
    const layout: NavLayout = {
      v: 1,
      categories: {
        home: { pinned: ['/tasks'], order: ['/tasks', '/chat'] },
        content: { pinned: ['/files', '/secret'] }
      }
    }
    const out = applyNavLayout(restricted, layout, { includeHidden: true })
    const keys = out.flatMap((c) => c.items.map((i) => i.key))
    expect(keys).not.toContain('/tasks')
    expect(keys).not.toContain('/files')
    expect(keys).not.toContain('/secret')
  })
})

describe('role starter + personal', () => {
  const starter: NavLayout = { v: 1, categories: { home: { hidden: ['/chat'] } } }
  const mine: NavLayout = { v: 1, categories: { home: { pinned: ['/tasks'] } } }
  it('personal wins, then the role starter, then the default', () => {
    expect(effectiveNavLayout(mine, starter)).toBe(mine)
    expect(effectiveNavLayout(null, starter)).toBe(starter)
    expect(effectiveNavLayout(null, null)).toBeNull()
  })

  it('merged with permissions: a starter hiding a page the role lacks is harmless', () => {
    const permitted = permittedCategories(cats, new Set(['/my-work']))
    const [home] = applyNavLayout(permitted, effectiveNavLayout(null, starter))
    expect(labels(home)).toEqual(['Overview', 'Tasks'])
  })
})

describe('editing', () => {
  const base = permittedCategories(cats, new Set())

  it('pin and hide are exclusive; clearing everything returns null', () => {
    let l = togglePinned(null, 'home', '/chat')
    expect(l?.categories.home.pinned).toEqual(['/chat'])
    l = toggleHidden(l, 'home', '/chat')
    expect(l?.categories.home).toEqual({ hidden: ['/chat'] })
    l = toggleHidden(l, 'home', '/chat')
    expect(l).toBeNull()
  })

  it('moves inside a section only', () => {
    const shown = applyNavLayout(base, null, { includeHidden: true })[1].items
    const l = moveItem(null, 'content', shown, '/files', -1)
    expect(l?.categories.content.order).toEqual([
      '/files',
      '/collections',
      '/imports',
      '/find-replace'
    ])
    // top of its section: no move across into another section
    expect(moveItem(null, 'content', shown, '/imports', -1)).toBeNull()
  })

  it('moves inside the Pinned block', () => {
    let l = togglePinned(null, 'home', '/chat')
    l = togglePinned(l, 'home', '/tasks')
    const shown = applyNavLayout(base, l, { includeHidden: true })[0].items
    l = moveItem(l, 'home', shown, '/tasks', -1)
    expect(l?.categories.home.pinned).toEqual(['/tasks', '/chat'])
  })

  it('reset clears one category', () => {
    const l = togglePinned(togglePinned(null, 'home', '/chat'), 'content', '/files')
    expect(resetCategory(l, 'home')?.categories).toEqual({ content: { pinned: ['/files'] } })
  })

  it('parses stored JSON leniently', () => {
    expect(parseNavLayout('{"v":1,"categories":{"home":{"pinned":["/chat",3]}}}')).toEqual({
      v: 1,
      categories: { home: { pinned: ['/chat'] } }
    })
    expect(parseNavLayout('nope')).toBeNull()
    expect(parseNavLayout({ v: 1, categories: {} })).toBeNull()
  })
})
