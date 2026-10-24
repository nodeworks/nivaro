import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ChatPanel } from './ChatPanel'
import { type ChatConfig, ChatConfigContext } from './chat-core'

// Presence is the only live source the Online tab reads; everything else the
// panel asks react-query for is empty, so the tab renders from these rows.
const presence = vi.hoisted(() => ({
  data: undefined as unknown
}))
const auth = vi.hoisted(() => ({ isAdmin: false }))

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) =>
    queryKey[0] === 'presence-online'
      ? { data: presence.data, isFetched: true, isLoading: false }
      : { data: undefined, isFetched: false, isLoading: false, isPending: false },
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => undefined, isPending: false }),
  useQueryClient: () => ({
    invalidateQueries: async () => undefined,
    setQueryData: () => undefined,
    cancelQueries: async () => undefined,
    getQueryData: () => undefined
  })
}))

vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useNivaroClient: () => ({}),
  useItemEditAuth: () => ({ isAdmin: auth.isAdmin }),
  useNavigation: () => ({ navigate: () => {} })
}))

const ME = { id: 'me-0001', name: 'Me' }

function config(onlineUsers: ChatConfig['onlineUsers']): ChatConfig {
  return {
    collections: { messages: 'chat_messages', reads: 'chat_reads', presence: 'presence' },
    globalRoom: 'global',
    globalLabel: 'General',
    me: ME,
    onlineUsers
  } as unknown as ChatConfig
}

function render(opts: {
  fields?: string[]
  rows: Array<Record<string, unknown>>
  users: ChatConfig['onlineUsers']
}): string {
  presence.data = {
    data: opts.rows,
    config: opts.fields ? { fields: opts.fields } : {}
  }
  return renderToStaticMarkup(
    createElement(
      ChatConfigContext.Provider,
      { value: config(opts.users) },
      createElement(ChatPanel, { open: true, onClose: () => {} })
    )
  )
}

const ZONED = {
  user_id: 'a0000000-0000-0000-0000-000000000001',
  display_name: 'Ada Approver',
  role_name: 'Workflow Approver',
  scopes: ['Zone 3', 'Zone 1', 'Zone 2'],
  page: 'Workflows › AB26-12345',
  app: null,
  current_path: '/records/workflows/312100'
}
const ZONED_USER = {
  user_id: ZONED.user_id,
  display_name: 'Ada Approver',
  role_name: 'workflow_approver'
}

describe('ChatPanel Online tab person row', () => {
  it('puts the page on its own line with its path as the tip, and keeps role/zones on a separate titled line', () => {
    const html = render({ fields: ['role', 'scopes', 'page'], rows: [ZONED], users: [ZONED_USER] })
    expect(html).toContain('data-chat-online-meta')
    expect(html).toContain('data-chat-online-page')
    expect(html).toContain('title="Workflow Approver · Zone 3, Zone 1, Zone 2"')
    expect(html).toContain('>Workflows › AB26-12345<')
    expect(html).toContain('data-tip="/records/workflows/312100"')
    expect(html).toContain('line-clamp-2')
    expect(html).toContain('break-words')
  })

  it('shows no page line when the person has no current page', () => {
    const html = render({
      rows: [{ ...ZONED, page: null, current_path: null }],
      users: [ZONED_USER]
    })
    expect(html).toContain('data-chat-online-meta')
    expect(html).not.toContain('data-chat-online-page')
  })

  it('falls back to "Online" when no configured part renders', () => {
    const html = render({
      rows: [{ ...ZONED, role_name: null, scopes: [], page: null, current_path: null }],
      users: [{ ...ZONED_USER, role_name: null }]
    })
    expect(html).not.toContain('data-chat-online-meta')
    expect(html).not.toContain('data-chat-online-page')
    expect(html).toContain('>Online<')
  })

  it('hides the page line when presence fields no longer include "page"', () => {
    const html = render({ fields: ['role', 'scopes'], rows: [ZONED], users: [ZONED_USER] })
    expect(html).toContain('data-chat-online-meta')
    expect(html).not.toContain('data-chat-online-page')
    // The presence dot's data-tip also carries the page, so match the row text only.
    expect(html).not.toContain('>Workflows › AB26-12345<')
  })

  it('hides the role and zones when presence fields are page-only', () => {
    const html = render({ fields: ['page'], rows: [ZONED], users: [ZONED_USER] })
    expect(html).toContain('data-chat-online-page')
    expect(html).not.toContain('data-chat-online-meta')
    expect(html).not.toContain('Zone 3')
  })
})

describe('ChatPanel Online tab — the photo opens the user card', () => {
  it('is its own button beside the DM button, never inside it', () => {
    const html = render({ fields: ['role'], rows: [ZONED], users: [ZONED_USER] })
    const row = html.slice(html.indexOf('data-chat-online-row'))
    expect(row).toContain('data-chat-online-avatar')
    expect(row).toContain('aria-label="Ada Approver — profile"')
    // the avatar button closes before the DM button opens
    expect(row.indexOf('data-chat-online-avatar')).toBeLessThan(
      row.indexOf('title="Send a direct message"')
    )
    const avatarButton = row.slice(row.indexOf('data-chat-online-avatar'))
    expect(avatarButton.indexOf('</button>')).toBeLessThan(
      avatarButton.indexOf('Send a direct message')
    )
  })
})

describe('ChatPanel Online tab — old build badge (#1048)', () => {
  const STALE = {
    ...ZONED,
    stale_build: [
      { app: 'efp-new', build: 'abc123', current_build: 'def456', reason: 'build', tabs: 2 }
    ]
  }

  it('shows administrators who still runs an old build', () => {
    auth.isAdmin = true
    try {
      const html = render({ rows: [STALE], users: [ZONED_USER] })
      expect(html).toContain('data-stale-build="efp-new"')
      expect(html).toContain('>Old build<')
      expect(html).toContain('current is def456 (2 tabs)')
    } finally {
      auth.isAdmin = false
    }
  })

  it('never shows it to anyone else, even if the field arrived', () => {
    const html = render({ rows: [STALE], users: [ZONED_USER] })
    expect(html).not.toContain('data-stale-build')
  })

  it('shows nothing for a person whose tabs are all current', () => {
    auth.isAdmin = true
    try {
      const html = render({ rows: [ZONED], users: [ZONED_USER] })
      expect(html).not.toContain('data-stale-build')
    } finally {
      auth.isAdmin = false
    }
  })
})

describe('ChatPanel Online tab — order', () => {
  it('lists people by name, whatever order the presence rows arrive in', () => {
    const row = (id: string, name: string) => ({ ...ZONED, user_id: id, display_name: name })
    const user = (id: string, name: string) => ({
      user_id: id,
      display_name: name,
      role_name: null
    })
    // The API used to answer freshest-heartbeat first, so this order changed every ~25 s.
    const rows = [row('u3', 'zoe Zimmer'), row('u1', 'Andrew Chura'), row('u2', 'ken Arreola')]
    const users = [user('u3', 'zoe Zimmer'), user('u1', 'Andrew Chura'), user('u2', 'ken Arreola')]
    const html = render({ rows, users })
    const a = html.indexOf('Andrew Chura')
    const k = html.indexOf('ken Arreola')
    const z = html.indexOf('zoe Zimmer')
    expect(a).toBeGreaterThan(-1)
    expect(a).toBeLessThan(k)
    expect(k).toBeLessThan(z)
  })
})
