import { openAskPanel, TipLayer, userErrorMessage } from '@nivaro/shared'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  Bookmark,
  BookmarkPlus,
  CornerDownLeft,
  FileText,
  Hand,
  History,
  Lightbulb,
  MessageSquare,
  Paperclip,
  Play,
  Plus,
  Search,
  Settings2,
  Sparkles,
  UserPlus,
  UserRound,
  X,
  Zap
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { ScrollTabs } from '@/components/scroll-tabs'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { showContrastAudit } from '@/lib/contrast-audit'
import { formatRelative, titleCase } from '@/lib/utils'
import {
  runSearchCommand,
  sendSearchClick,
  useRecentRecordLabels,
  useSavedSearches,
  useSaveSearch
} from './global-search-api'
import {
  altDigit,
  type ExtraHit,
  type ExtraKind,
  extraHref,
  extraTabs,
  friendlyIdChip,
  isExtraTab,
  isNewTabEnter,
  nextRecall,
  type ParsedQuery,
  personMeta,
  pushRecentRecord,
  pushRecentSearch,
  queryChips,
  type RecentRecord,
  type RecordPreview,
  readRecentRecords,
  readRecentSearches,
  recordFromPath,
  recordLabel,
  recordPath,
  type SearchCommand,
  type SearchExtra,
  type SearchRecord,
  whyMatched
} from './global-search-helpers'

// ─── Static page registry (mirrors AppLayout nav structure) ──────────────────

const PAGES: { label: string; path: string; keywords?: string }[] = [
  { label: 'Overview', path: '/', keywords: 'home dashboard' },
  { label: 'Search', path: '/search', keywords: 'find everything results saved searches' },
  { label: 'Dashboards', path: '/dashboards', keywords: 'kpi widgets' },
  {
    label: 'Collections (data model)',
    path: '/collections',
    keywords: 'content data items data model schema fields tables'
  },
  { label: 'Files', path: '/files', keywords: 'uploads media' },
  { label: 'Hierarchies', path: '/hierarchies', keywords: 'tree levels' },
  { label: 'Record Templates', path: '/record-templates' },
  { label: 'Collection Presets', path: '/promotion/starter-kits' },
  { label: 'Users', path: '/users', keywords: 'people accounts' },
  { label: 'Roles', path: '/roles', keywords: 'permissions policies rbac' },
  { label: 'Workspaces', path: '/workspaces' },
  { label: 'Pipelines', path: '/pipelines', keywords: 'owner matrix' },
  { label: 'Flows', path: '/flows', keywords: 'automation' },
  { label: 'Webhooks', path: '/connections/webhooks' },
  { label: 'Rules', path: '/flows/rules', keywords: 'automation conditions' },
  { label: 'Blackout Dates', path: '/deadlines/blackout' },
  { label: 'Scheduled Changes', path: '/deadlines/scheduled' },
  { label: 'Virtual Collections', path: '/virtual-collections' },
  { label: 'External APIs', path: '/connections', keywords: 'integrations' },
  { label: 'GraphQL Explorer', path: '/graphql', keywords: 'graphiql' },
  { label: 'Custom Queries', path: '/custom-queries', keywords: 'sql' },
  { label: 'Extensions', path: '/extensions', keywords: 'plugins' },
  { label: 'Analytics', path: '/analytics' },
  { label: 'Presence', path: '/security-center/presence' },
  { label: 'Docs', path: '/docs', keywords: 'documentation reference' },
  { label: 'API Docs', path: '/docs/api', keywords: 'rest reference' },
  { label: 'Settings', path: '/settings', keywords: 'configuration ai key' },
  { label: 'Activity', path: '/activity', keywords: 'audit log' },
  { label: 'Reports', path: '/reports', keywords: 'audit' },
  { label: 'Alerts', path: '/alerts', keywords: 'thresholds' },
  { label: 'SLA Rules', path: '/deadlines' },
  { label: 'Field Watches', path: '/alerts/watches', keywords: 'changelog' },
  { label: 'Subscriptions', path: '/alerts/subscriptions', keywords: 'notifications' },
  { label: 'Imports', path: '/imports', keywords: 'csv upload' },
  { label: 'Submission Forms', path: '/submission-forms', keywords: 'public forms' },
  { label: 'Schema Snapshot', path: '/promotion/schema' },
  { label: 'Profile', path: '/profile', keywords: 'account token' }
]

export type { SearchRecord } from './global-search-helpers'

/** One collection's match count as the caller (GET /global-search/counts). */
export interface CollectionCount {
  collection: string
  display_name: string | null
  count: number
}

export const collectionLabel = (c: { collection: string; display_name?: string | null }) =>
  c.display_name || titleCase(c.collection)

/** Tabs for a search: one per collection with hits, counted. Until the counts land a
 *  collection shows how many the first answer held, as a floor ("8+"). Exported for tests. */
export function searchTabs(
  hits: SearchRecord[],
  counts: CollectionCount[] | undefined
): Array<{ collection: string; label: string; count: string }> {
  const seen = new Map<string, { collection: string; display_name?: string | null; n: number }>()
  for (const h of hits) {
    const cur = seen.get(h.collection)
    if (cur) cur.n++
    else seen.set(h.collection, { collection: h.collection, display_name: h.display_name, n: 1 })
  }
  if (counts) {
    const out = counts.map((c) => ({
      collection: c.collection,
      label: collectionLabel(c),
      count: String(c.count)
    }))
    for (const s of seen.values())
      if (!counts.some((c) => c.collection === s.collection))
        out.push({ collection: s.collection, label: collectionLabel(s), count: `${s.n}+` })
    return out
  }
  return [...seen.values()]
    .sort((a, b) => b.n - a.n)
    .map((s) => ({ collection: s.collection, label: collectionLabel(s), count: `${s.n}+` }))
}

/** The exact-ID hit first, then the rest without it. */
export function withExactFirst(records: SearchRecord[], exact: SearchRecord | null | undefined) {
  if (!exact) return records
  const same = (r: SearchRecord) =>
    r.collection === exact.collection && String(r.id) === String(exact.id)
  return [{ ...exact, exact: true }, ...records.filter((r) => !same(r))]
}

const TAB_PAGE = 25

/** A person from the directory search: directory columns for everyone;
 *  status and account kind only reach an admin. */
export interface SearchPerson {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  title: string | null
  department: string | null
  status?: string | null
  account_kind?: string | null
  role_name?: string | null
  zones?: string[] | null
}

export interface GlobalSearchResponse {
  records: SearchRecord[]
  people?: SearchPerson[]
  semantic?: SearchRecord[]
  pages: { label: string; path: string }[]
  actions: { label: string; path: string }[]
  query?: ParsedQuery
  exact?: SearchRecord | null
  suggestions?: string[]
  extra?: SearchExtra
  commands?: SearchCommand[]
}

export function personName(p: SearchPerson): string {
  return [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.email || 'Unnamed person'
}

/** Why an admin sees this account flagged: machine kind first, then suspended. */
export function personFlag(p: SearchPerson): string | null {
  if (p.account_kind) return titleCase(p.account_kind)
  if (p.status === 'suspended') return 'Suspended'
  return null
}

/** Second line of a person row: role · zones · title when the API sends them (#17),
 *  else the older title · email. */
export function personLine(p: SearchPerson): string {
  if (p.role_name || p.zones?.length) return personMeta(p)
  return [p.title, p.email].filter(Boolean).join(' · ')
}

function matchesQuery(p: { label: string; path: string; keywords?: string }, q: string) {
  const lower = q.toLowerCase()
  return (
    p.label.toLowerCase().includes(lower) ||
    (p.keywords ?? '').toLowerCase().includes(lower) ||
    p.path.toLowerCase().includes(lower)
  )
}

// ─── Palette v2 (#323): recents + fuzzy highlight + preview pane ─────────────

interface RecentEntry {
  label: string
  path: string
}

const RECENTS_KEY = 'nvr_palette_recents'

/** Recently opened pages. Records live in their own list (global-search-helpers). */
function readRecents(): RecentEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((r) => !recordFromPath(r?.path ?? '')).slice(0, 5) : []
  } catch {
    return []
  }
}

function pushRecent(entry: RecentEntry) {
  try {
    const list = [entry, ...readRecents().filter((r) => r.path !== entry.path)].slice(0, 5)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list))
  } catch {
    /* storage unavailable */
  }
}

/** Highlight the query match inside a label (case-insensitive, first hit). */
export function Hi({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className='rounded-sm bg-nvr-cyan/20 px-0 text-inherit'>
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className='inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground'>
      {children}
    </kbd>
  )
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'
export const ALT_KEY = IS_MAC ? '⌥' : 'Alt'

const EXTRA_ICON: Record<ExtraKind, typeof FileText> = {
  comments: MessageSquare,
  files: Paperclip,
  videos: Play,
  docs: FileText,
  chat: MessageSquare,
  config: Settings2
}

const COMMAND_ICON: Record<SearchCommand['kind'], typeof FileText> = {
  transition: Zap,
  hold: Hand,
  create: Plus,
  assign: UserPlus
}

/** The second line of a record row: why it matched (#9), else the snippet. */
function RecordLine({ r, q }: { r: SearchRecord; q: string }) {
  const why = r.exact ? null : whyMatched(r)
  if (why && r.matched_value) {
    const label = r.matched_label || titleCase(r.matched_field ?? '')
    return (
      <div className='truncate text-[11px] text-muted-foreground'>
        <span className='text-foreground/70'>{label}:</span> <Hi text={r.matched_value} q={q} />
      </div>
    )
  }
  if (why) return <div className='truncate text-[11px] text-muted-foreground'>{why}</div>
  if (r.snippet && r.snippet !== r.label)
    return <div className='truncate text-[11px] text-muted-foreground'>{r.snippet}</div>
  return null
}

/** A hit's readable id (#776), when its label does not already say it. */
function FriendlyIdChip({ r }: { r: SearchRecord }) {
  const f = friendlyIdChip(r)
  if (!f) return null
  return (
    <span
      data-search-friendly-id
      data-tip={`#${String(r.id)}`}
      className='ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'
    >
      {f}
    </span>
  )
}

function ExactChip() {
  return (
    <span className='ml-2 shrink-0 rounded bg-nvr-cyan/15 px-1.5 py-0.5 text-[10px] font-medium text-foreground'>
      Exact ID
    </span>
  )
}

const recordValue = (prefix: string, r: SearchRecord) => `${prefix}-${r.collection}-${r.id}`
const extraValue = (kind: ExtraKind, h: ExtraHit) => `extra-${kind}-${h.id}`

/** What the highlighted row is, for the preview pane and Cmd+Enter. */
interface PaneEntry {
  kind: string
  title: string
  sub?: string
  path: string
  record?: SearchRecord | RecentRecord
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CommandPalette() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user } = useAuth()
  const isAdmin = !!user?.is_admin
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  // ⌘K / Ctrl+K + custom focus-search event
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onFocusSearch = () => setOpen(true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('nivaro:focus-search', onFocusSearch)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('nivaro:focus-search', onFocusSearch)
    }
  }, [])

  // Debounce live record search (250ms)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  // #19 — a command result asks first (inline, never a modal), then runs through
  // the record's own route.
  const [pendingCmd, setPendingCmd] = useState<SearchCommand | null>(null)
  const [cmdNote, setCmdNote] = useState('')

  // Reset query when closing
  useEffect(() => {
    if (!open) {
      setQuery('')
      setDebouncedQuery('')
      setPendingCmd(null)
    }
  }, [open])

  // null = everything; a collection = its matches; `extra:<kind>` = that kind.
  const [tab, setTab] = useState<string | null>(null)
  // A saved search reopens on its scope's tab once its query settles.
  const pendingTabRef = useRef<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new search or a reopen starts on All
  useEffect(() => {
    setTab(pendingTabRef.current)
    pendingTabRef.current = null
  }, [debouncedQuery, open])

  // #1581 — search analytics: what was typed, how many results, how long, what was opened.
  const searchMsRef = useRef(0)
  const searchLogRef = useRef<{ key: string; id: Promise<number | null> } | null>(null)
  const { data: searchData, isFetching } = useQuery({
    queryKey: ['global-search', debouncedQuery],
    queryFn: () => {
      const started = Date.now()
      return api
        .get<{ data: GlobalSearchResponse }>('/global-search', {
          params: { q: debouncedQuery }
        })
        .then((r) => {
          searchMsRef.current = Date.now() - started
          return r.data.data
        })
    },
    enabled: open && debouncedQuery.length >= 2,
    staleTime: 15_000
  })

  // Extension palette entries (#260): server extensions declare navigation
  // entries; served beside the UI-bundle manifest (not admin-gated).
  const { data: extPalette = [] } = useQuery<
    Array<{ label: string; path: string; extension: string }>
  >({
    queryKey: ['extension-palette'],
    queryFn: () =>
      api
        .get<{ palette?: Array<{ label: string; path: string; extension: string }> }>(
          '/extensions/manifest'
        )
        .then((r) => r.data.palette ?? [])
        .catch(() => []),
    enabled: open,
    staleTime: 300_000
  })

  const { data: collections } = useQuery({
    queryKey: ['command-palette-collections'],
    queryFn: () =>
      api
        .get<{ data: { collection: string; display_name?: string | null }[] }>('/collections')
        .then((r) => r.data.data),
    enabled: open,
    staleTime: 60_000
  })
  const scopeLabel = (scope: string) => {
    if (scope === '__people__') return 'People'
    const c = collections?.find((x) => x.collection === scope)
    return c ? collectionLabel(c) : titleCase(scope)
  }

  const { saved, available: savedAvailable } = useSavedSearches(open)
  const saveSearch = useSaveSearch()

  const q = query.trim()
  const live = debouncedQuery.length >= 2
  const allPages = [
    ...PAGES,
    ...extPalette.map((e) => ({ label: e.label, path: e.path, keywords: e.extension }))
  ]
  const pageMatches = q
    ? allPages.filter((p) => matchesQuery(p, q)).slice(0, 8)
    : allPages.slice(0, 8)
  const records = live ? withExactFirst(searchData?.records ?? [], searchData?.exact) : []
  const people = live ? (searchData?.people ?? []) : []
  const serverActions = live ? (searchData?.actions ?? []) : []
  const semantic = debouncedQuery.length >= 4 ? (searchData?.semantic ?? []) : []
  const extras = live ? extraTabs(searchData?.extra) : []
  const commands = live ? (searchData?.commands ?? []) : []
  const suggestions = live
    ? (searchData?.suggestions ?? []).filter(
        (s) => s.toLowerCase() !== debouncedQuery.toLowerCase()
      )
    : []
  const chips = live ? queryChips(query, searchData?.query, scopeLabel) : []

  // Collection tabs: each matched collection's count as the caller, then one
  // collection's matches a page at a time.
  const hitCollections = [...new Set(records.map((r) => r.collection))].sort().join(',')
  const { data: counts } = useQuery({
    queryKey: ['global-search-counts', debouncedQuery, hitCollections],
    queryFn: () =>
      api
        .get<{ data: CollectionCount[] }>('/global-search/counts', {
          params: { q: debouncedQuery, collections: hitCollections }
        })
        .then((r) => (Array.isArray(r.data.data) ? r.data.data : [])),
    enabled: open && live && hitCollections !== '',
    staleTime: 15_000
  })
  const tabs = searchTabs(records, counts)
  const tabOrder: Array<{ key: string | null; label: string; count: string }> = [
    { key: null, label: 'All', count: '' },
    ...tabs.map((t) => ({ key: t.collection as string | null, label: t.label, count: t.count })),
    ...extras.map((t) => ({ key: t.key as string | null, label: t.label, count: t.count }))
  ]
  const showTabs = live && tabOrder.length > 2
  const collectionTab = tab && !isExtraTab(tab) ? tab : null
  const tabPages = useInfiniteQuery({
    queryKey: ['global-search-tab', debouncedQuery, collectionTab],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api
        .get<{ data: SearchRecord[]; total: number | null }>('/global-search/records', {
          params: {
            q: debouncedQuery,
            collection: collectionTab,
            offset: pageParam,
            limit: TAB_PAGE
          }
        })
        .then((r) => r.data),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, pg) => n + (pg.data?.length ?? 0), 0)
      if ((last.data?.length ?? 0) < TAB_PAGE) return undefined
      return last.total != null && loaded >= last.total ? undefined : loaded
    },
    enabled: open && !!collectionTab && live,
    staleTime: 15_000
  })
  const tabRecords = (tabPages.data?.pages ?? []).flatMap((pg) => pg.data ?? [])
  const tabTotal = tabPages.data?.pages[0]?.total ?? null
  const activeExtra = isExtraTab(tab) ? extras.find((x) => x.key === tab) : undefined
  const cycleTab = (dir: 1 | -1) => {
    const order = tabOrder.map((t) => t.key)
    const i = order.indexOf(tab)
    setTab(order[(i + dir + order.length) % order.length])
  }

  const newItemActions = q
    ? (collections ?? [])
        .filter(
          (c) =>
            !c.collection.toLowerCase().startsWith('nivaro_') &&
            (c.collection.toLowerCase().includes(q.toLowerCase()) ||
              (c.display_name ?? '').toLowerCase().includes(q.toLowerCase()))
        )
        .slice(0, 5)
    : []

  const [recents, setRecents] = useState<RecentEntry[]>([])
  const [recentRecords, setRecentRecords] = useState<RecentRecord[]>([])
  const [recentSearches, setRecentSearches] = useState<string[]>([])
  // Preview pane (#323): cmdk exposes the highlighted item's value — map it
  // back to the entity so the right pane can describe it before Enter.
  const [selectedValue, setSelectedValue] = useState('')
  useEffect(() => {
    if (open) {
      setRecents(readRecents())
      setRecentRecords(readRecentRecords())
      setRecentSearches(readRecentSearches())
    }
  }, [open])
  // Recents stored without a label (or with an old pk-only one) are named as the viewer.
  const recentLabels = useRecentRecordLabels(recentRecords, open, setRecentRecords)
  const recentTitle = (r: RecentRecord) => recentLabels[`${r.collection}:${r.id}`] ?? recordLabel(r)
  const recallRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Back to the box once a command's confirm closes.
  useEffect(() => {
    if (!pendingCmd) inputRef.current?.focus()
  }, [pendingCmd])
  const listRef = useRef<HTMLDivElement>(null)

  // One log row per settled query per open; the row remembers what was picked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: allPages is derived from stable inputs
  useEffect(() => {
    if (!open || isFetching || !searchData || debouncedQuery.length < 2) return
    const key = debouncedQuery
    if (searchLogRef.current?.key === key) return
    const count =
      (searchData.records?.length ?? 0) +
      (searchData.people?.length ?? 0) +
      (searchData.actions?.length ?? 0) +
      (debouncedQuery.length >= 4 ? (searchData.semantic?.length ?? 0) : 0) +
      allPages.filter((p) => matchesQuery(p, debouncedQuery)).length
    searchLogRef.current = {
      key,
      id: api
        .post<{ data: { id: number | null } }>('/search-analytics/log', {
          surface: 'palette',
          query: debouncedQuery,
          result_count: count,
          duration_ms: searchMsRef.current
        })
        .then((r) => r.data.data.id)
        .catch(() => null)
    }
  }, [open, isFetching, searchData, debouncedQuery])
  useEffect(() => {
    if (!open) searchLogRef.current = null
  }, [open])

  /** Open a result. `newTab` keeps the palette open and opens a browser tab (#10). */
  function go(
    path: string,
    opts: { label?: string; kind?: string; position?: number; newTab?: boolean } = {}
  ) {
    const logged = searchLogRef.current
    const rec = recordFromPath(path)
    if (logged && q.length >= 2) {
      void logged.id
        .then((id) =>
          id == null
            ? null
            : api.post(`/search-analytics/log/${id}/open`, {
                type: rec ? 'record' : 'page',
                collection: rec?.collection ?? null,
                item: rec?.id ?? null
              })
        )
        .catch(() => {})
      if (rec && opts.position != null)
        sendSearchClick({ q, collection: rec.collection, id: rec.id, position: opts.position })
    }
    if (q.length >= 2) setRecentSearches(pushRecentSearch(q))
    if (rec)
      setRecentRecords(
        pushRecentRecord({
          ...rec,
          // pushRecentRecord stores no pk-only label; '' is resolved on display.
          label: opts.label ?? '',
          kind: opts.kind ?? titleCase(rec.collection)
        })
      )
    else if (opts.label) pushRecent({ label: opts.label, path })
    if (opts.newTab) {
      window.open(path, '_blank', 'noopener')
      return
    }
    setOpen(false)
    navigate(path)
  }

  // Natural-language mode: route prose to the right collection, then let the
  // browser's existing AI query translate it to filters (?ai= param).
  const aiNavigate = useMutation({
    mutationFn: (prompt: string) =>
      api
        .post<{ data: { collection: string | null } }>('/ai/navigate', { prompt })
        .then((r) => r.data.data),
    onSuccess: (res, prompt) => {
      if (!res.collection) {
        toast.message('Could not match that to a collection')
        return
      }
      go(`/collections/${res.collection}?ai=${encodeURIComponent(prompt)}`)
    },
    onError: () => toast.error('AI navigation failed')
  })
  const showAiRow = q.length >= 10 && q.split(/\s+/).length >= 3

  const runCmd = useMutation({
    mutationFn: (cmd: SearchCommand) =>
      runSearchCommand(cmd, cmdNote, (path) => {
        setOpen(false)
        navigate(path)
      }),
    onSuccess: (refusal, cmd) => {
      setPendingCmd(null)
      if (cmd.kind === 'create') return
      if (refusal) toast.error(refusal)
      else toast.success(`${cmd.label} — done`)
      void qc.invalidateQueries({ queryKey: ['global-search'] })
      if (cmd.collection) void qc.invalidateQueries({ queryKey: ['items', cmd.collection] })
    },
    onError: (err) => toast.error(userErrorMessage(err, 'The command did not run'))
  })
  const cmdNeedsNote = (cmd: SearchCommand) =>
    !!(cmd.payload as { require_reason?: boolean } | null)?.require_reason
  const cmdTakesNote = (cmd: SearchCommand) => cmd.kind === 'transition' || cmd.kind === 'hold'

  const noResults =
    live &&
    !isFetching &&
    !!searchData &&
    records.length === 0 &&
    people.length === 0 &&
    semantic.length === 0 &&
    extras.length === 0 &&
    commands.length === 0 &&
    pageMatches.length === 0 &&
    serverActions.length === 0

  const hasResults =
    !!q ||
    pageMatches.length > 0 ||
    records.length > 0 ||
    people.length > 0 ||
    semantic.length > 0 ||
    newItemActions.length > 0 ||
    serverActions.length > 0

  const seeAllPath = `/search?q=${encodeURIComponent(q)}${collectionTab ? `&tab=${encodeURIComponent(collectionTab)}` : ''}`

  // ── What each row value points at: preview pane + Cmd+Enter (#8/#10) ──
  const entries = new Map<string, PaneEntry>()
  for (const [prefix, list] of [
    ['tab', tabRecords],
    ['record', records],
    ['sem', semantic]
  ] as const)
    for (const r of list)
      entries.set(recordValue(prefix, r), {
        kind: collectionLabel(r),
        title: recordLabel(r),
        sub: whyMatched(r) ?? (r.snippet && r.snippet !== r.label ? r.snippet : ''),
        path: recordPath(r.collection, r.id),
        record: r
      })
  for (const r of recentRecords)
    entries.set(`rrec-${r.collection}-${r.id}`, {
      kind: r.kind ?? titleCase(r.collection),
      title: recentTitle(r),
      path: recordPath(r.collection, r.id),
      record: r
    })
  for (const r of recents)
    entries.set(`recent-${r.path}`, { kind: 'Recent', title: r.label, path: r.path })
  for (const p of pageMatches)
    entries.set(`page-${p.path}`, {
      kind: 'Page',
      title: p.label,
      sub: p.keywords ?? '',
      path: p.path
    })
  for (const p of people)
    entries.set(`person-${p.id}`, {
      kind: personFlag(p) ?? 'Person',
      title: personName(p),
      sub: [personMeta(p), p.department, p.email]
        .filter((x, i, a) => !!x && a.indexOf(x) === i)
        .join(' · '),
      path: `/users/${encodeURIComponent(p.id)}`
    })
  for (const x of extras)
    for (const h of x.hits)
      entries.set(extraValue(x.kind, h), {
        kind: titleCase(h.kind || x.kind),
        title: h.label,
        sub: h.snippet,
        path: extraHref(h) ?? ''
      })
  for (const c of newItemActions)
    entries.set(`new-${c.collection}`, {
      kind: 'Action',
      title: `New item in ${collectionLabel(c)}`,
      path: `/collections/${c.collection}/new`
    })
  if (live)
    entries.set('see-all', { kind: 'Search', title: `All results for “${q}”`, path: seeAllPath })

  const openRecord = (r: SearchRecord, position: number, newTab = false) =>
    go(recordPath(r.collection, r.id), {
      label: recordLabel(r),
      kind: collectionLabel(r),
      position,
      newTab
    })

  const openSaved = (s: { q: string; scope: string | null }) => {
    pendingTabRef.current = s.scope && !s.scope.startsWith('__') ? s.scope : null
    setQuery(s.q)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (pendingCmd) return
    if (isNewTabEnter(e)) {
      const entry = entries.get(selectedValue)
      if (entry?.path) {
        e.preventDefault()
        go(entry.path, {
          label: entry.title,
          kind: entry.kind,
          newTab: true,
          position: entry.record ? 0 : undefined
        })
      }
      return
    }
    const digit = showTabs ? altDigit(e) : null
    if (digit != null) {
      e.preventDefault()
      if (digit < tabOrder.length) setTab(tabOrder[digit].key)
      return
    }
    // With tabs showing, Tab belongs to the tab strip, so Backspace on an empty caret
    // removes the last filter chip (the × buttons stay as mouse targets).
    if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const el = e.target as HTMLInputElement
      const last = chips[chips.length - 1]
      if (
        last?.without != null &&
        el.selectionStart === 0 &&
        el.selectionEnd === 0 &&
        el.tagName === 'INPUT'
      ) {
        e.preventDefault()
        setQuery(last.without)
        return
      }
    }
    if (e.key === 'Tab' && showTabs) {
      e.preventDefault()
      cycleTab(e.shiftKey ? -1 : 1)
      return
    }
    // ↑ on the first row of an empty box (or of a recalled search) recalls the
    // previous search, like a shell (#7).
    if (e.key === 'ArrowUp' && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const recalling = query === '' || query === recallRef.current
      if (!recalling) return
      const first = listRef.current?.querySelector('[cmdk-item]')?.getAttribute('data-value')
      if (selectedValue && first && selectedValue !== first) return
      const next = nextRecall(recentSearches, query)
      if (next) {
        e.preventDefault()
        recallRef.current = next
        setQuery(next)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open && <TipLayer />}
      <DialogContent
        className='overflow-hidden p-0 shadow-lg sm:max-w-[780px]'
        onEscapeKeyDown={(e) => {
          // Esc first backs out of a command's confirm, then closes.
          if (pendingCmd) {
            e.preventDefault()
            setPendingCmd(null)
          }
        }}
      >
        <DialogTitle className='sr-only'>Command palette</DialogTitle>
        <Command
          shouldFilter={false}
          value={selectedValue}
          onValueChange={setSelectedValue}
          onKeyDown={onKeyDown}
          className='[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-input]]:h-11 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2'
        >
          <CommandInput
            ref={inputRef}
            placeholder='Search pages, people, records, actions…'
            value={query}
            onValueChange={(v) => {
              setQuery(v)
              if (v !== recallRef.current) recallRef.current = null
            }}
          />
          {chips.length > 0 && (
            <div
              className='flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5'
              data-palette-chips
            >
              <span className='text-[11px] text-muted-foreground'>Searching</span>
              {chips.map((c) => (
                <span
                  key={c.key}
                  className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px] ${
                    c.kind === 'scope'
                      ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-foreground'
                      : 'border-border bg-muted text-foreground'
                  }`}
                >
                  {c.kind === 'scope' ? <span className='text-muted-foreground'>in</span> : null}
                  {c.label}
                  {c.without != null && (
                    <button
                      type='button'
                      aria-label={`Remove ${c.label}`}
                      data-tip={`Remove ${c.label}`}
                      onClick={() => setQuery(c.without ?? '')}
                      className='-mr-0.5 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                    >
                      <X className='h-3 w-3' />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {showTabs && (
            <div className='flex items-center border-b border-border'>
              <ScrollTabs
                role='tablist'
                aria-label='Search results by kind'
                activeKey={tab}
                className='px-2 py-1.5'
              >
                {tabOrder.map((t, i) => {
                  const on = tab === t.key
                  return (
                    <button
                      key={t.key ?? '__all__'}
                      type='button'
                      role='tab'
                      aria-selected={on}
                      aria-keyshortcuts={i < 9 ? `Alt+${i + 1}` : undefined}
                      data-palette-tab={t.key ?? 'all'}
                      data-tip={i < 9 ? `${ALT_KEY}${i + 1}` : undefined}
                      onClick={() => setTab(t.key)}
                      className={`flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan ${
                        on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {t.label}
                      {t.count && (
                        <span
                          className={`rounded px-1 font-mono text-[10px] tabular-nums ${
                            on ? 'bg-nvr-cyan/15 text-foreground' : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {t.count}
                        </span>
                      )}
                    </button>
                  )
                })}
              </ScrollTabs>
            </div>
          )}
          {pendingCmd && (
            <CommandConfirm
              cmd={pendingCmd}
              note={cmdNote}
              onNote={setCmdNote}
              takesNote={cmdTakesNote(pendingCmd)}
              needsNote={cmdNeedsNote(pendingCmd)}
              running={runCmd.isPending}
              onConfirm={() => runCmd.mutate(pendingCmd)}
              onCancel={() => setPendingCmd(null)}
            />
          )}
          <div className='flex'>
            <CommandList ref={listRef} className='max-h-[400px] flex-1'>
              {collectionTab ? (
                <>
                  {tabRecords.length === 0 && (
                    <CommandEmpty>
                      {tabPages.isFetching ? 'Searching…' : 'No results found.'}
                    </CommandEmpty>
                  )}
                  {tabRecords.length > 0 && (
                    <CommandGroup
                      heading={`${collectionLabel(tabs.find((t) => t.collection === collectionTab) ?? { collection: collectionTab })}${
                        tabTotal != null ? ` · ${tabTotal}` : ''
                      }`}
                    >
                      {tabRecords.map((r, i) => (
                        <CommandItem
                          key={`tab-${r.collection}-${r.id}`}
                          value={recordValue('tab', r)}
                          onSelect={() => openRecord(r, i)}
                        >
                          <Search className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
                          <div className='min-w-0 flex-1'>
                            <div className='truncate text-[13px]'>
                              <Hi text={recordLabel(r)} q={q} />
                            </div>
                            <RecordLine r={r} q={q} />
                          </div>
                          <FriendlyIdChip r={r} />
                          {r.exact && <ExactChip />}
                        </CommandItem>
                      ))}
                      {tabPages.hasNextPage && (
                        <CommandItem
                          value='tab-show-more'
                          onSelect={() => void tabPages.fetchNextPage()}
                          className='text-[12px] text-cyan-700 dark:text-nvr-cyan'
                        >
                          {tabPages.isFetchingNextPage
                            ? 'Loading…'
                            : `Show more${tabTotal != null ? ` (${tabRecords.length} of ${tabTotal})` : ''}`}
                        </CommandItem>
                      )}
                    </CommandGroup>
                  )}
                  <SeeAllGroup path={seeAllPath} q={q} go={go} />
                </>
              ) : activeExtra ? (
                <>
                  <CommandGroup heading={`${activeExtra.label} · ${activeExtra.hits.length}`}>
                    {activeExtra.hits.map((h) => (
                      <ExtraItem
                        key={`${h.kind}-${h.id}`}
                        hit={h}
                        kind={activeExtra.kind}
                        q={q}
                        go={go}
                      />
                    ))}
                  </CommandGroup>
                  <SeeAllGroup path={seeAllPath} q={q} go={go} />
                </>
              ) : (
                <>
                  {!hasResults && (
                    <CommandEmpty>{isFetching ? 'Searching…' : 'No results found.'}</CommandEmpty>
                  )}

                  {q && (
                    <CommandGroup heading='Ask AI'>
                      {/* #1835 — the question opens the Ask AI panel on THIS page,
                      with the page's record, list or report as context. */}
                      <CommandItem
                        value={`ask-${q}`}
                        data-palette-ask
                        onSelect={() => {
                          setOpen(false)
                          openAskPanel(q)
                        }}
                        className='text-[13px]'
                      >
                        <Sparkles className='mr-2 h-4 w-4 text-nvr-cyan' />
                        Ask… “{q}”
                        <span className='ml-auto text-[11px] text-muted-foreground'>
                          {MOD_KEY}J
                        </span>
                      </CommandItem>
                      {showAiRow && (
                        <CommandItem
                          value={`ai-${q}`}
                          onSelect={() => aiNavigate.mutate(q)}
                          className='text-[13px]'
                        >
                          <Sparkles className='mr-2 h-4 w-4 text-nvr-cyan' />
                          {aiNavigate.isPending ? 'Thinking…' : <>Find records: “{q}”</>}
                        </CommandItem>
                      )}
                    </CommandGroup>
                  )}

                  {/* #14 — a search that found nothing says what to try next. */}
                  {noResults && (
                    <CommandGroup heading={`Nothing matched “${debouncedQuery}”`} data-palette-zero>
                      {suggestions.map((s) => (
                        <CommandItem
                          key={`suggest-${s}`}
                          value={`suggest-${s}`}
                          onSelect={() => setQuery(s)}
                        >
                          <Lightbulb className='mr-2 h-3.5 w-3.5 text-amber-600 dark:text-amber-400' />
                          <span className='text-[13px]'>
                            Did you mean <span className='font-medium'>{s}</span>?
                          </span>
                        </CommandItem>
                      ))}
                      {isAdmin && (
                        <CommandItem
                          value='zero-add-synonym'
                          onSelect={() =>
                            go(`/search?q=${encodeURIComponent(debouncedQuery)}&synonym=1`)
                          }
                        >
                          <Plus className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
                          <span className='text-[13px]'>Add a synonym for “{debouncedQuery}”</span>
                          <span className='ml-auto text-[11px] text-muted-foreground'>Admin</span>
                        </CommandItem>
                      )}
                      <div className='px-2 pb-2 pt-1 text-[11.5px] leading-snug text-muted-foreground'>
                        Try fewer words, a record number, or a filter such as{' '}
                        <code className='rounded bg-muted px-1 font-mono text-[11px] text-foreground'>
                          field:value
                        </code>
                        .
                      </div>
                    </CommandGroup>
                  )}

                  {!q && saved.length > 0 && (
                    <CommandGroup heading='Saved searches'>
                      {saved.slice(0, 6).map((s) => (
                        <CommandItem
                          key={`saved-${s.id}`}
                          value={`saved-${s.id}`}
                          onSelect={() => openSaved(s)}
                        >
                          <Bookmark className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
                          <span className='truncate text-[13px]'>{s.name}</span>
                          {s.name !== s.q && (
                            <span className='ml-auto max-w-[220px] truncate font-mono text-[11px] text-muted-foreground'>
                              {s.q}
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {!q && recentSearches.length > 0 && (
                    <CommandGroup heading='Recent searches'>
                      {recentSearches.map((s, i) => (
                        <CommandItem
                          key={`rs-${s}`}
                          value={`rsearch-${s}`}
                          onSelect={() => setQuery(s)}
                        >
                          <History className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
                          <span className='truncate text-[13px]'>{s}</span>
                          {i === 0 && (
                            <span className='ml-auto flex items-center gap-1 text-[11px] text-muted-foreground'>
                              <Kbd>↑</Kbd> recall
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {!q && recentRecords.length > 0 && (
                    <CommandGroup heading='Recently opened'>
                      {recentRecords.map((r) => {
                        const value = `rrec-${r.collection}-${r.id}`
                        return (
                          <CommandItem
                            key={value}
                            value={value}
                            onSelect={() =>
                              go(recordPath(r.collection, r.id), {
                                label: recentTitle(r),
                                kind: r.kind
                              })
                            }
                          >
                            <Search className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
                            <span className='truncate text-[13px]'>{recentTitle(r)}</span>
                            <span className='ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
                              {r.kind ?? titleCase(r.collection)}
                            </span>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  )}

                  {!q && recents.length > 0 && (
                    <CommandGroup heading='Recent pages'>
                      {recents.map((r) => {
                        return (
                          <CommandItem
                            key={`recent-${r.path}`}
                            value={`recent-${r.path}`}
                            onSelect={() => go(r.path, { label: r.label })}
                          >
                            <History className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
                            <span className='text-[13px]'>{r.label}</span>
                            <span className='ml-auto max-w-[220px] truncate font-mono text-[11px] text-muted-foreground'>
                              {r.path}
                            </span>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  )}

                  {commands.length > 0 && (
                    <CommandGroup heading='Commands'>
                      {commands.map((c) => {
                        const Icon = COMMAND_ICON[c.kind] ?? Zap
                        return (
                          <CommandItem
                            key={`cmd-${c.id}`}
                            value={`cmd-${c.id}`}
                            onSelect={() => {
                              setCmdNote('')
                              setPendingCmd(c)
                            }}
                          >
                            <Icon className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
                            <span className='truncate text-[13px]'>{c.label}</span>
                            <span className='ml-auto text-[11px] text-muted-foreground'>
                              Asks first
                            </span>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  )}

                  {pageMatches.length > 0 && (
                    <CommandGroup heading='Pages'>
                      {pageMatches.map((p) => {
                        return (
                          <CommandItem
                            key={`page-${p.path}`}
                            value={`page-${p.path}`}
                            onSelect={() => go(p.path, { label: p.label })}
                          >
                            <FileText className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
                            <span className='text-[13px]'>
                              <Hi text={p.label} q={q} />
                            </span>
                            <span className='ml-auto font-mono text-[11px] text-muted-foreground'>
                              {p.path}
                            </span>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  )}

                  {people.length > 0 && (
                    <>
                      <CommandSeparator />
                      <CommandGroup heading='People'>
                        {people.map((p) => {
                          const name = personName(p)
                          const flag = personFlag(p)
                          const sub = personLine(p)
                          const path = `/users/${encodeURIComponent(p.id)}`
                          return (
                            <CommandItem
                              key={`person-${p.id}`}
                              value={`person-${p.id}`}
                              onSelect={() => go(path, { label: name })}
                            >
                              <UserRound className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
                              <div className='min-w-0 flex-1'>
                                <div className='truncate text-[13px]'>
                                  <Hi text={name} q={q} />
                                </div>
                                {sub && (
                                  <div className='truncate text-[11px] text-muted-foreground'>
                                    <Hi text={sub} q={q} />
                                  </div>
                                )}
                              </div>
                              {flag && (
                                <span className='ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
                                  {flag}
                                </span>
                              )}
                            </CommandItem>
                          )
                        })}
                      </CommandGroup>
                    </>
                  )}

                  {records.length > 0 && (
                    <>
                      <CommandSeparator />
                      <CommandGroup heading='Records'>
                        {records.map((r, i) => (
                          <CommandItem
                            key={`record-${r.collection}-${r.id}`}
                            value={recordValue('record', r)}
                            onSelect={() => openRecord(r, i)}
                          >
                            <Search className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
                            <div className='min-w-0 flex-1'>
                              <div className='truncate text-[13px]'>
                                <Hi text={recordLabel(r)} q={q} />
                              </div>
                              <RecordLine r={r} q={q} />
                            </div>
                            <FriendlyIdChip r={r} />
                            {r.exact && <ExactChip />}
                            <span className='ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
                              {collectionLabel(r)}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </>
                  )}

                  {extras.map((x) => (
                    <CommandGroup key={x.key} heading={x.label}>
                      {x.hits.slice(0, 3).map((h) => (
                        <ExtraItem key={`${h.kind}-${h.id}`} hit={h} kind={x.kind} q={q} go={go} />
                      ))}
                      {x.hits.length > 3 && (
                        <CommandItem
                          value={`more-${x.key}`}
                          onSelect={() => setTab(x.key)}
                          className='text-[12px] text-nvr-cyan'
                        >
                          All {x.hits.length} {x.label.toLowerCase()}
                        </CommandItem>
                      )}
                    </CommandGroup>
                  ))}

                  {semantic.length > 0 && (
                    <>
                      <CommandSeparator />
                      <CommandGroup heading='Similar meaning'>
                        {semantic.map((r) => (
                          <CommandItem
                            key={`sem-${r.collection}-${r.id}`}
                            value={recordValue('sem', r)}
                            onSelect={() => go(recordPath(r.collection, r.id), { label: r.label })}
                          >
                            <Sparkles className='mr-2 h-3.5 w-3.5 text-purple-500' />
                            <div className='min-w-0 flex-1'>
                              <div className='truncate text-[13px]'>{recordLabel(r)}</div>
                            </div>
                            <span className='ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
                              {titleCase(r.collection)}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </>
                  )}

                  {'audit contrast'.includes(q.toLowerCase()) && q.length >= 3 && (
                    <CommandGroup heading='Tools'>
                      <CommandItem
                        value='tool-contrast-audit'
                        onSelect={() => {
                          setOpen(false)
                          setTimeout(() => showContrastAudit(), 250)
                        }}
                      >
                        <Sparkles className='mr-2 h-3.5 w-3.5 text-amber-500' />
                        <span className='text-[13px]'>Audit contrast on this page</span>
                      </CommandItem>
                    </CommandGroup>
                  )}

                  {(newItemActions.length > 0 || serverActions.length > 0) && (
                    <>
                      <CommandSeparator />
                      <CommandGroup heading='Actions'>
                        {newItemActions.map((c) => {
                          return (
                            <CommandItem
                              key={`new-${c.collection}`}
                              value={`new-${c.collection}`}
                              onSelect={() => go(`/collections/${c.collection}/new`)}
                            >
                              <Plus className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
                              <span className='text-[13px]'>
                                New item in {c.display_name ?? titleCase(c.collection)}
                              </span>
                            </CommandItem>
                          )
                        })}
                        {serverActions.map((a) => (
                          <CommandItem
                            key={`action-${a.path}-${a.label}`}
                            value={`action-${a.path}-${a.label}`}
                            onSelect={() => go(a.path)}
                          >
                            <ArrowRight className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
                            <span className='text-[13px]'>{a.label}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </>
                  )}

                  {live && (
                    <SeeAllGroup
                      path={seeAllPath}
                      q={q}
                      go={go}
                      onSave={
                        savedAvailable && !saved.some((s) => s.q === q)
                          ? () => saveSearch.mutate({ name: q, q, scope: null })
                          : undefined
                      }
                      saving={saveSearch.isPending}
                    />
                  )}
                </>
              )}
            </CommandList>
            <PreviewPane entry={entries.get(selectedValue) ?? null} open={open} />
          </div>

          {/* Footer hint row */}
          <div className='flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-[11px] text-muted-foreground'>
            <span className='flex items-center gap-1'>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span className='flex items-center gap-1'>
              <Kbd>
                <CornerDownLeft className='h-2.5 w-2.5' />
              </Kbd>{' '}
              open
            </span>
            <span className='flex items-center gap-1'>
              <Kbd>{MOD_KEY}</Kbd>
              <Kbd>
                <CornerDownLeft className='h-2.5 w-2.5' />
              </Kbd>{' '}
              new tab
            </span>
            {showTabs && (
              <span className='flex items-center gap-1'>
                <Kbd>{ALT_KEY}</Kbd>
                <Kbd>1–9</Kbd> tabs
              </span>
            )}
            <span className='flex items-center gap-1'>
              <Kbd>esc</Kbd> close
            </span>
            <span className='ml-auto flex items-center gap-1'>
              <Kbd>{MOD_KEY}</Kbd>
              <Kbd>K</Kbd>
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

type GoFn = (
  path: string,
  opts?: { label?: string; kind?: string; position?: number; newTab?: boolean }
) => void

function ExtraItem({ hit, kind, q, go }: { hit: ExtraHit; kind: ExtraKind; q: string; go: GoFn }) {
  const Icon = EXTRA_ICON[kind] ?? FileText
  const value = extraValue(kind, hit)
  const path = extraHref(hit) ?? ''
  return (
    <CommandItem value={value} onSelect={() => go(path, { label: hit.label })}>
      <Icon className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
      <div className='min-w-0 flex-1'>
        <div className='truncate text-[13px]'>
          <Hi text={hit.label} q={q} />
        </div>
        {hit.snippet && (
          <div className='truncate text-[11px] text-muted-foreground'>
            <Hi text={hit.snippet} q={q} />
          </div>
        )}
      </div>
      {hit.collection && (
        <span className='ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
          {titleCase(hit.collection)}
        </span>
      )}
    </CommandItem>
  )
}

/** "See all results" (#12) + "Save this search" (#13) at the foot of the list. */
function SeeAllGroup({
  path,
  q,
  go,
  onSave,
  saving
}: {
  path: string
  q: string
  go: GoFn
  onSave?: () => void
  saving?: boolean
}) {
  if (q.length < 2) return null
  return (
    <>
      <CommandSeparator />
      <CommandGroup heading='More'>
        <CommandItem value='see-all' onSelect={() => go(path)} data-palette-see-all>
          <ArrowRight className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
          <span className='text-[13px]'>See all results for “{q}”</span>
          <span className='ml-auto text-[11px] text-muted-foreground'>Filters, sort, export</span>
        </CommandItem>
        {onSave && (
          <CommandItem value='save-search' onSelect={onSave}>
            <BookmarkPlus className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
            <span className='text-[13px]'>{saving ? 'Saving…' : 'Save this search'}</span>
          </CommandItem>
        )}
      </CommandGroup>
    </>
  )
}

/** Inline confirm for a command result (#19): what it will do, an optional note,
 *  Confirm / Cancel. Enter confirms (the button has focus), Esc backs out. */
function CommandConfirm({
  cmd,
  note,
  onNote,
  takesNote,
  needsNote,
  running,
  onConfirm,
  onCancel
}: {
  cmd: SearchCommand
  note: string
  onNote: (v: string) => void
  takesNote: boolean
  needsNote: boolean
  running: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const blocked = needsNote && !note.trim()
  return (
    <div
      role='alertdialog'
      aria-label={cmd.label}
      // Keys here belong to the confirm (Enter on a button, typing a note) — never
      // to the list behind it. Esc still reaches the dialog (capture listener).
      onKeyDown={(e) => e.stopPropagation()}
      className='flex flex-col gap-2 border-b border-border bg-muted/60 px-3 py-2.5'
      data-palette-confirm
    >
      <p className='text-[12.5px] leading-snug text-foreground'>
        <span className='font-medium'>{cmd.label}</span>
        {cmd.confirm && <span className='text-muted-foreground'> — {cmd.confirm}</span>}
      </p>
      <div className='flex items-center gap-2'>
        {takesNote && (
          <Input
            value={note}
            onChange={(e) => onNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !blocked && !running) {
                e.preventDefault()
                onConfirm()
              }
            }}
            placeholder={needsNote ? 'Why? (required)' : 'Note (optional)'}
            aria-label='Note'
            autoFocus={needsNote}
            className='h-7 flex-1 text-[12px]'
          />
        )}
        <div className='ml-auto flex shrink-0 items-center gap-1.5'>
          <Button variant='ghost' size='sm' className='h-7 text-[12px]' onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size='sm'
            autoFocus={!needsNote}
            disabled={blocked || running}
            onClick={onConfirm}
            className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
          >
            {running ? 'Working…' : cmd.kind === 'create' ? 'Open form' : 'Confirm'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function PreviewPane({ entry, open }: { entry: PaneEntry | null; open: boolean }) {
  // Arrowing through rows changes the entry quickly — ask only once it rests.
  const rec = entry?.record
  const key = rec ? `${rec.collection}\u0000${rec.id}` : ''
  const [settled, setSettled] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSettled(key), 160)
    return () => clearTimeout(t)
  }, [key])
  const preview = useQuery({
    queryKey: ['global-search-preview', rec?.collection, rec ? String(rec.id) : null],
    queryFn: () =>
      api
        .get<{ data: RecordPreview }>('/global-search/preview', {
          params: { collection: rec?.collection, id: rec ? String(rec.id) : '' }
        })
        .then((r) => r.data.data ?? null),
    enabled: open && !!rec && settled === key,
    retry: false,
    staleTime: 30_000
  })
  const p = rec && preview.isSuccess ? preview.data : null
  const loading = !!rec && (settled !== key || preview.isLoading)

  if (!entry)
    return (
      <div className='hidden w-[240px] shrink-0 flex-col border-l border-border p-3 sm:flex'>
        <p className='m-auto text-center text-[11.5px] text-muted-foreground'>
          Arrow through results to preview
        </p>
      </div>
    )

  return (
    <div
      className='hidden max-h-[400px] w-[240px] shrink-0 flex-col gap-1.5 overflow-y-auto border-l border-border p-3 sm:flex'
      data-palette-preview
    >
      <div className='flex flex-wrap items-center gap-1.5'>
        <span className='w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
          {entry.kind}
        </span>
        {p?.state && (
          <span className='inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-foreground'>
            <span
              className='h-1.5 w-1.5 rounded-full bg-slate-400'
              style={p.state.color ? { backgroundColor: p.state.color } : undefined}
            />
            {p.state.label}
          </span>
        )}
      </div>
      <p className='break-words text-[13px] font-medium leading-snug'>{p?.label || entry.title}</p>
      {entry.sub && (
        <p className='break-words text-[11.5px] leading-snug text-muted-foreground'>{entry.sub}</p>
      )}
      {loading && !p && (
        <div className='mt-1 space-y-1.5' aria-hidden>
          <Skeleton className='h-3 w-4/5' />
          <Skeleton className='h-3 w-3/5' />
          <Skeleton className='h-3 w-2/3' />
        </div>
      )}
      {p && p.fields.length > 0 && (
        <dl className='mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11.5px] leading-snug'>
          {p.fields.slice(0, 8).map((f) => (
            <div key={f.label} className='contents'>
              <dt className='text-muted-foreground'>{f.label}</dt>
              <dd className='min-w-0 break-words text-foreground'>{f.value || '—'}</dd>
            </div>
          ))}
        </dl>
      )}
      {p?.owners && p.owners.length > 0 && (
        <p className='text-[11.5px] leading-snug'>
          <span className='text-muted-foreground'>Owners </span>
          {p.owners
            .slice(0, 3)
            .map((o) => o.name)
            .join(', ')}
          {p.owners.length > 3 ? ` +${p.owners.length - 3}` : ''}
        </p>
      )}
      {p?.updated_at && (
        <p className='text-[11px] text-muted-foreground'>
          Updated {formatRelative(p.updated_at)}
          {p.updated_by ? ` by ${p.updated_by}` : ''}
        </p>
      )}
      <p className='mt-auto break-all pt-1 font-mono text-[10.5px] text-muted-foreground'>
        {entry.path}
      </p>
    </div>
  )
}
