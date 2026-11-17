import { describe, expect, it, vi } from 'vitest'
import { gitlabProvider, parseIssueUrl } from './gitlab.js'
import { TrackerError } from './types.js'

type Fetch = Parameters<typeof gitlabProvider>[1]

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })

const mk = (fn: ReturnType<typeof vi.fn<(...args: any[]) => any>>) =>
  gitlabProvider({ baseUrl: 'https://git.x/', token: 'tok' }, fn as unknown as Fetch)

const issueRow = (iid: number, extra: Record<string, unknown> = {}) => ({
  id: iid + 100,
  iid,
  project_id: 7,
  web_url: `https://git.x/g/p/-/issues/${iid}`,
  title: `t${iid}`,
  state: 'opened',
  labels: [],
  assignees: [],
  milestone: null,
  updated_at: '2026-01-01T00:00:00Z',
  description: null,
  ...extra
})

describe('gitlabProvider', () => {
  it('createIssue posts to /api/v4/projects/7/issues with PRIVATE-TOKEN', async () => {
    const f = vi.fn<(...args: any[]) => any>().mockResolvedValue(reply(issueRow(1), 201))
    await mk(f).createIssue(7, { title: 'a', description: 'b', labels: ['x', 'y'] })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://git.x/api/v4/projects/7/issues')
    expect(init.method).toBe('POST')
    expect(init.headers['PRIVATE-TOKEN']).toBe('tok')
    expect(init.timeoutMs).toBe(10000)
    expect(JSON.parse(init.body)).toMatchObject({ title: 'a', labels: 'x,y' })
  })

  it('maps 401 to auth without leaking the token', async () => {
    const f = vi
      .fn<(...args: any[]) => any>()
      .mockResolvedValue(reply({ message: '401 Unauthorized' }, 401))
    const err = await mk(f)
      .whoami()
      .catch((e) => e)
    expect(err).toBeInstanceOf(TrackerError)
    expect(err.kind).toBe('auth')
    expect(err.status).toBe(401)
    expect(err.message).toContain('401 Unauthorized')
    expect(err.message).not.toContain('tok')
  })

  it('a 3xx is an invalid TrackerError and is not followed', async () => {
    const f = vi
      .fn<(...args: any[]) => any>()
      .mockResolvedValue(reply('', 302, { location: 'https://other.example/api/v4/user' }))
    const err = await mk(f)
      .whoami()
      .catch((e) => e)
    expect(err).toBeInstanceOf(TrackerError)
    expect(err.kind).toBe('invalid')
    expect(err.status).toBe(302)
    expect(err.message).toContain('other.example')
    expect(err.message).not.toContain('tok')
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][1].redirect).toBe('manual')
  })

  it('maps other statuses and network failures', async () => {
    const f = vi.fn<(...args: any[]) => any>()
    f.mockResolvedValueOnce(reply('', 404))
    f.mockResolvedValueOnce(reply('', 429))
    f.mockResolvedValueOnce(reply('', 502))
    f.mockResolvedValueOnce(reply({ error: 'bad' }, 422))
    f.mockRejectedValueOnce(new Error('boom'))
    const p = mk(f)
    const kinds = []
    for (let i = 0; i < 5; i++) kinds.push((await p.getIssue(7, 1).catch((e) => e)).kind)
    expect(kinds).toEqual(['not_found', 'rate', 'server', 'invalid', 'network'])
  })

  it('findIssueByMarker searches with search=<marker>&in=description and returns null on none', async () => {
    const f = vi.fn<(...args: any[]) => any>()
    f.mockResolvedValueOnce(reply([issueRow(1, { description: 'fuzzy other' })]))
    f.mockResolvedValueOnce(reply([issueRow(2, { description: 'x\n\n<!-- nivaro:1 -->\n' })]))
    const p = mk(f)
    expect(await p.findIssueByMarker(7, '<!-- nivaro:1 -->')).toBeNull()
    const url = new URL(f.mock.calls[0][0])
    expect(url.searchParams.get('search')).toBe('<!-- nivaro:1 -->')
    expect(url.searchParams.get('in')).toBe('description')
    expect((await p.findIssueByMarker(7, '<!-- nivaro:1 -->'))?.iid).toBe(2)
  })

  it('marker mid-description does not match', async () => {
    const f = vi.fn<(...args: any[]) => any>()
    f.mockImplementation(async () =>
      reply([
        issueRow(3, { description: 'x <!-- nivaro:1 --> y' }),
        issueRow(4, { description: '<!-- nivaro:1 -->\nreal text after it\n<!-- nivaro:2 -->' })
      ])
    )
    expect(await mk(f).findIssueByMarker(7, '<!-- nivaro:1 -->')).toBeNull()
    expect((await mk(f).findIssueByMarker(7, '<!-- nivaro:2 -->'))?.iid).toBe(4)
  })

  it('updatedIssues follows x-next-page up to 500', async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => issueRow(n * 100 + i))
    const f = vi.fn<(...args: any[]) => any>().mockImplementation(async (url: string) => {
      const n = Number(new URL(url).searchParams.get('page'))
      return reply(page(n), 200, { 'x-next-page': String(n + 1) })
    })
    const out = await mk(f).updatedIssues(7, new Date('2026-01-01T00:00:00Z'))
    expect(out).toHaveLength(500)
    expect(f).toHaveBeenCalledTimes(5)
    expect(new URL(f.mock.calls[0][0]).searchParams.get('updated_after')).toBe(
      '2026-01-01T00:00:00.000Z'
    )
  })

  it('updatedIssues stops when x-next-page is empty', async () => {
    const f = vi
      .fn<(...args: any[]) => any>()
      .mockResolvedValue(reply([issueRow(1)], 200, { 'x-next-page': '' }))
    expect(await mk(f).updatedIssues(7, new Date())).toHaveLength(1)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('notes filters by since', async () => {
    const f = vi.fn<(...args: any[]) => any>().mockResolvedValue(
      reply([
        {
          id: 1,
          body: 'a',
          author: { username: 'u', name: 'U' },
          created_at: '2026-01-01T00:00:00Z',
          system: false
        },
        {
          id: 2,
          body: 'b',
          author: { username: 'u', name: 'U' },
          created_at: '2026-02-01T00:00:00Z',
          system: true
        }
      ])
    )
    const out = await mk(f).notes(7, 3, new Date('2026-01-15T00:00:00Z'))
    expect(out.map((n) => n.id)).toEqual([2])
  })

  it('upload sends multipart and returns markdown', async () => {
    const f = vi
      .fn<(...args: any[]) => any>()
      .mockResolvedValue(reply({ markdown: '![a](/uploads/x/a.png)' }, 201))
    const r = await mk(f).upload(7, { name: 'a.png', mime: 'image/png', data: Buffer.from('hi') })
    expect(r.markdown).toBe('![a](/uploads/x/a.png)')
    const init = f.mock.calls[0][1]
    expect(init.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(Buffer.isBuffer(init.body)).toBe(true)
  })

  it('encodes a path project id', async () => {
    const f = vi
      .fn<(...args: any[]) => any>()
      .mockResolvedValue(reply({ id: 1, path_with_namespace: 'g/p' }))
    const r = await mk(f).project('g/p')
    expect(f.mock.calls[0][0]).toBe('https://git.x/api/v4/projects/g%2Fp')
    expect(r.access_level).toBeNull()
  })
})

describe('parseIssueUrl', () => {
  it('parses an issue url', () => {
    expect(parseIssueUrl('https://git.x/g/sub/p/-/issues/12')).toEqual({
      projectPath: 'g/sub/p',
      iid: 12
    })
  })
  it('returns null for a merge request', () => {
    expect(parseIssueUrl('https://git.x/g/sub/p/-/merge_requests/12')).toBeNull()
  })
  it('returns null for junk', () => {
    expect(parseIssueUrl('nope')).toBeNull()
  })
})
