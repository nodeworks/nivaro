import { beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny stand-in for the scope table: rows by conn; every other table reads empty.
const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    let conn: string | null = null
    const b: Record<string, unknown> = {
      where: (w: { conn?: string }) => {
        conn = w.conn ?? null
        return b
      },
      first: async () =>
        table === 'nivaro_mcp_connection_scopes' && conn ? rows.get(conn) : undefined,
      select: () => b,
      catch: () => Promise.resolve([])
    }
    return b
  }
  return { db: builder }
})

const {
  applyMcpConnectionScope,
  bustScopes,
  effectiveScope,
  innerToolRefusal,
  intersectLists,
  intersectScopes,
  normalizeScopePatch,
  scopeAsKeyScopes,
  scopeIsOpen
} = await import('../../../services/mcp-scope.js')
const { BUILTIN_KITS, normalizeKit } = await import('../../../services/mcp-kits.js')

const GRANT = '0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b'
const kits = new Map(BUILTIN_KITS.map((k) => [k.key, k]))
const row = (over: Record<string, unknown> = {}) => ({
  conn: `o${GRANT}`,
  kit: null,
  tools: null,
  collections: null,
  actions: null,
  locked: false,
  note: null,
  user: 'U1',
  updated_by: 'U1',
  updated_at: null,
  ...over
})

describe('limits only narrow', () => {
  it('intersects lists, null meaning no limit', () => {
    expect(intersectLists(null, null)).toBeNull()
    expect(intersectLists(['a', 'b'], null)).toEqual(['a', 'b'])
    expect(intersectLists(null, ['b'])).toEqual(['b'])
    expect(intersectLists(['a', 'b'], ['b', 'c'])).toEqual(['b'])
  })

  it('a kit and the connection’s own list meet', () => {
    const eff = effectiveScope(
      row({ kit: 'buyer', tools: ['read_items', 'health'] }) as never,
      kits
    )
    // health is not in the buyer kit, so even listing it on the connection does not add it.
    expect(eff.tools).toEqual(['read_items'])
    expect(eff.kit_missing).toBe(false)
  })

  it('a kit that no longer exists allows nothing', () => {
    const eff = effectiveScope(row({ kit: 'gone' }) as never, kits)
    expect(eff).toMatchObject({ kit_missing: true, tools: [], collections: [], actions: [] })
  })

  it('no limits = open', () => {
    expect(scopeIsOpen(effectiveScope(row() as never, kits))).toBe(true)
  })
})

describe('collections and actions become key scopes', () => {
  it('limits nothing without collections or actions', () => {
    expect(scopeAsKeyScopes({ collections: null, actions: null })).toBeNull()
  })
  it('names each collection and keeps the directory readable', () => {
    expect(scopeAsKeyScopes({ collections: ['projects'], actions: ['read'] })).toEqual([
      { collection: 'projects', actions: ['read'] },
      { collection: 'nivaro_users', actions: ['read'] }
    ])
  })
  it('actions alone apply everywhere', () => {
    expect(scopeAsKeyScopes({ collections: null, actions: ['read'] })).toEqual([
      { collection: '*', actions: ['read'] }
    ])
  })

  it('never widens an API key’s own scopes', () => {
    const key = [{ collection: 'projects', actions: ['read'] }]
    const narrow = [{ collection: '*', actions: ['*'] }]
    const out = intersectScopes(key, narrow)
    expect(out).toEqual([{ collection: 'projects', actions: ['read'] }])
  })

  it('meets two lists collection by collection', () => {
    const key = [
      { collection: '*', actions: ['read'] },
      { collection: 'orders', actions: ['*'] }
    ]
    const narrow = [{ collection: 'orders', actions: ['read', 'update'] }]
    expect(intersectScopes(key, narrow)).toEqual([
      { collection: 'orders', actions: ['read', 'update'] }
    ])
  })

  it('takes the narrow list as it is when the credential had none', () => {
    const narrow = [{ collection: 'projects', actions: ['read'] }]
    expect(intersectScopes(undefined, narrow)).toEqual(narrow)
  })

  it('keeps $chat entries of the key', () => {
    const key = [
      { collection: '*', actions: ['*'] },
      { collection: '$chat', actions: ['read'] }
    ]
    const out = intersectScopes(key, [{ collection: 'projects', actions: ['read'] }])
    expect(out).toContainEqual({ collection: '$chat', actions: ['read'] })
    expect(out).toContainEqual({ collection: 'projects', actions: ['read'] })
  })

  it('an empty meeting refuses everything', () => {
    expect(
      intersectScopes(
        [{ collection: 'a', actions: ['read'] }],
        [{ collection: 'b', actions: ['read'] }]
      )
    ).toEqual([])
  })
})

describe('inner calls under a tool allowlist', () => {
  const s = { tools: ['read_items', 'call_instance_tool', 'weekly_report'] }
  it('allows a listed tool', () => {
    expect(innerToolRefusal(s, 'read_items', 'GET', '/api/items/projects')).toBeNull()
  })
  it('refuses a tool not listed', () => {
    expect(innerToolRefusal(s, 'delete_item', 'DELETE', '/api/items/projects/1')).toMatch(
      /delete_item/
    )
  })
  it('judges the instance tool a proxy call names', () => {
    expect(
      innerToolRefusal(s, 'call_instance_tool', 'POST', '/api/mcp-tools/secret_flow/call')
    ).toMatch(/secret_flow/)
    expect(
      innerToolRefusal(s, 'call_instance_tool', 'POST', '/api/mcp-tools/weekly_report/call')
    ).toBeNull()
  })
  it('a request with no tool may only read', () => {
    expect(innerToolRefusal(s, null, 'GET', '/api/items/projects/1')).toBeNull()
    expect(innerToolRefusal(s, null, 'PATCH', '/api/items/projects/1')).not.toBeNull()
  })
  it('no allowlist refuses nothing', () => {
    expect(innerToolRefusal({ tools: null }, 'delete_item', 'DELETE', '/api/items/x/1')).toBeNull()
  })
})

describe('applyMcpConnectionScope', () => {
  beforeEach(() => {
    rows.clear()
    bustScopes()
  })
  const req = (over: Record<string, unknown> = {}) =>
    ({
      url: '/api/items/projects',
      method: 'GET',
      headers: {} as Record<string, string>,
      authMethod: 'oauth',
      oauthGrantId: GRANT,
      mcpInner: true,
      user: { id: 'U1' },
      ...over
    }) as never as Parameters<typeof applyMcpConnectionScope>[0]

  it('does nothing outside MCP', async () => {
    rows.set(`o${GRANT}`, { ...row({ collections: '["projects"]' }) })
    const r = req({ mcpInner: false })
    await applyMcpConnectionScope(r)
    expect(r.mcpScope).toBeUndefined()
    expect(r.user?.api_key_scopes).toBeUndefined()
  })

  it('narrows the user’s scopes on an inner call', async () => {
    rows.set(`o${GRANT}`, { ...row({ collections: '["projects"]', actions: '["read"]' }) })
    const r = req()
    await applyMcpConnectionScope(r)
    expect(r.user?.api_key_scopes).toEqual([
      { collection: 'projects', actions: ['read'] },
      { collection: 'nivaro_users', actions: ['read'] }
    ])
  })

  it('applies on the outer POST /api/mcp too', async () => {
    rows.set(`o${GRANT}`, { ...row({ tools: '["search"]' }) })
    const r = req({ url: '/api/mcp', method: 'POST', mcpInner: false })
    await applyMcpConnectionScope(r)
    expect(r.mcpScope?.tools).toEqual(['search'])
  })

  it('refuses an inner call whose tool is not allowed', async () => {
    rows.set(`o${GRANT}`, { ...row({ tools: '["search"]' }) })
    const r = req({ method: 'DELETE', headers: { 'x-nivaro-mcp-tool': 'delete_item' } })
    await expect(applyMcpConnectionScope(r)).rejects.toMatchObject({
      statusCode: 403,
      code: 'MCP_TOOL_NOT_ALLOWED'
    })
  })

  it('leaves session and static-token callers alone', async () => {
    rows.set(`o${GRANT}`, { ...row({ tools: '[]' }) })
    const r = req({ authMethod: 'session' })
    await applyMcpConnectionScope(r)
    expect(r.mcpScope).toBeUndefined()
  })

  it('is idempotent', async () => {
    rows.set(`o${GRANT}`, { ...row({ collections: '["projects"]' }) })
    const r = req()
    await applyMcpConnectionScope(r)
    const once = JSON.stringify(r.user?.api_key_scopes)
    await applyMcpConnectionScope(r)
    expect(JSON.stringify(r.user?.api_key_scopes)).toBe(once)
  })
})

describe('posted scopes and kits', () => {
  it('cleans a scope patch', () => {
    const n = normalizeScopePatch({
      kit: 'buyer',
      tools: ['read_items', 'read_items', 'Bad Name'],
      collections: ['projects'],
      actions: ['read', 'explode'],
      locked: true,
      note: '  for the pilot '
    })
    expect(n).toEqual({
      patch: {
        kit: 'buyer',
        tools: ['read_items'],
        collections: ['projects'],
        actions: ['read'],
        locked: true,
        note: 'for the pilot'
      }
    })
  })
  it('refuses a non-list', () => {
    expect(normalizeScopePatch({ tools: 'read_items' })).toEqual({
      error: 'tools must be a list or null'
    })
  })
  it('refuses a kit named like a built-in, or with no tools', () => {
    expect(normalizeKit({ key: 'buyer', label: 'B', tools: ['search'] })).toHaveProperty('error')
    expect(normalizeKit({ key: 'finance', label: 'Finance', tools: [] })).toHaveProperty('error')
    expect(
      normalizeKit({ key: 'finance', label: 'Finance', tools: ['search'], actions: ['read'] })
    ).toMatchObject({ kit: { key: 'finance', tools: ['search'], actions: ['read'] } })
  })
  it('built-in kits never include writes they do not mean', () => {
    const admin = BUILTIN_KITS.find((k) => k.key === 'admin')!
    for (const w of ['create_item', 'update_item', 'delete_item', 'transition'])
      expect(admin.tools).not.toContain(w)
    for (const k of BUILTIN_KITS) expect(k.tools).not.toContain('delete_item')
  })
})
