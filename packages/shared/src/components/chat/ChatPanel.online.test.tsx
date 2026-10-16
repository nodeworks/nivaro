import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ChatConfigContext, type ChatConfig } from './chat-core'
import { ChatPanel } from './ChatPanel'

// Presence is the only live source the Online tab reads; everything else the
// panel asks react-query for is empty, so the tab renders from these rows.
const presence = vi.hoisted(() => ({
  data: undefined as unknown
}))

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
  useItemEditAuth: () => ({ isAdmin: false }),
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
const ZONED_USER = { user_id: ZONED.user_id, display_name: 'Ada Approver', role_name: 'workflow_approver' }

describe('ChatPanel Online tab person row', () => {
  it('puts the page on its own line with a title, and keeps role/zones on a separate titled line', () => {
    const html = render({ fields: ['role', 'scopes', 'page'], rows: [ZONED], users: [ZONED_USER] })
    expect(html).toContain('data-chat-online-meta')
    expect(html).toContain('data-chat-online-page')
    expect(html).toContain('title="Workflow Approver · Zone 3, Zone 1, Zone 2"')
    expect(html).toContain('title="Workflows › AB26-12345"')
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
