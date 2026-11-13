import {
  CollectionsDirectory,
  type CollectionsDirectoryAdminTools,
  type DirectoryRowMenuLink
} from '@nivaro/shared'
import {
  Download,
  GitBranch,
  LayoutTemplate,
  ListChecks,
  Settings2,
  TableProperties
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CollectionDesigner } from '@/components/collection-designer'
import { SchemaProposalsPanel } from '@/components/schema-proposals-panel'
import { api, type Collection } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { FolderSuggestions } from './collections/FolderSuggestions'
import { type FolderSuggestion, suggestFolders } from './collections/folder-suggestions'
import { MoveToFolderDialog } from './collections/MoveToFolderDialog'
import {
  moveCollections,
  readLocal,
  useFavoriteCollections,
  writeLocal
} from './collections/overview-data'
import {
  CreateTableInline,
  DescribePanel,
  OtherTablesSections,
  type SchemaPanel,
  SchemaToolsMenu
} from './collections/SchemaTools'

/**
 * Collections (/collections) — the shared collections directory (@nivaro/shared
 * CollectionsDirectory, also efp-new's All data) plus the admin app's editing tools: the
 * row ✏ link and Data model menu, Move to folder, Select, Arrange, suggested folders, the
 * data-model tools (new table, describe, proposals, designer) and the unregistered / system
 * tables. "My favorites" are the sidebar favorites, so a star here shows in the sidebar.
 */

const DISMISSED_KEY = 'nvr_collections_suggestions_dismissed'

const DATA_MODEL_TABS: Array<{ tab: string; label: string; icon: ReactNode }> = [
  { tab: 'fields', label: 'Fields', icon: <TableProperties /> },
  { tab: 'relations', label: 'Relations', icon: <GitBranch /> },
  { tab: 'groups', label: 'Form layouts', icon: <LayoutTemplate /> },
  { tab: 'rules', label: 'Rules', icon: <ListChecks /> },
  { tab: 'imports', label: 'Imports', icon: <Download /> },
  { tab: 'settings', label: 'Settings', icon: <Settings2 /> }
]

function suggestionKey(s: FolderSuggestion): string {
  return `${s.folder.key}:${[...s.collections].sort().join(',')}`
}

export function CollectionsPage() {
  const { user } = useAuth()
  const isAdmin = (user as { is_admin?: boolean } | null)?.is_admin ?? false
  const favorites = useFavoriteCollections()

  const [dismissed, setDismissed] = useState<string[]>(() => readLocal<string[]>(DISMISSED_KEY, []))
  // Data-model tools folded in from the old Data Model list page (?proposals=1 opens proposals).
  const [panel, setPanel] = useState<SchemaPanel>(() =>
    new URLSearchParams(window.location.search).get('proposals') === '1' ? 'proposals' : null
  )
  const [designerOpen, setDesignerOpen] = useState(false)

  const admin = useMemo<CollectionsDirectoryAdminTools | undefined>(() => {
    if (!isAdmin) return undefined
    return {
      toolbarActions: <SchemaToolsMenu onPanel={setPanel} onDesign={() => setDesignerOpen(true)} />,
      panels: (
        <>
          {panel === 'create' && <CreateTableInline onClose={() => setPanel(null)} />}
          {panel === 'describe' && <DescribePanel onClose={() => setPanel(null)} />}
          {panel === 'proposals' && (
            <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]'>
              <SchemaProposalsPanel onClose={() => setPanel(null)} />
            </div>
          )}
        </>
      ),
      editPath: (c) => `/data-model/${encodeURIComponent(c)}`,
      rowMenu: {
        heading: 'Data model',
        items: (c): DirectoryRowMenuLink[] =>
          DATA_MODEL_TABS.map((t) => ({
            key: t.tab,
            label: t.label,
            icon: t.icon,
            path: `/data-model/${encodeURIComponent(c)}?tab=${t.tab}`
          }))
      },
      moveCollections,
      renderMoveDialog: (p) => (
        <MoveToFolderDialog
          open={p.open}
          onOpenChange={p.onOpenChange}
          names={p.names}
          folders={p.folders}
          onMoved={p.onMoved}
        />
      ),
      reorder: (items) => api.patch('/collections/reorder', { items }),
      // Suggested folders (#13): loose, visible collections that look like they belong.
      renderSuggestions: ({ real, folders, refresh }) => {
        const loose = (real as Collection[]).filter((c) => !c.group && !c.hidden)
        const suggestions = suggestFolders(loose, folders, real as Collection[]).filter(
          (s) => !dismissed.includes(suggestionKey(s))
        )
        if (!suggestions.length) return null
        return (
          <FolderSuggestions
            suggestions={suggestions}
            onAccept={async (s) => {
              await moveCollections(s.collections, s.folder.key)
              toast.success(`Moved ${s.collections.length} to ${s.folder.label}`)
              refresh()
            }}
            onDismiss={(s) => {
              const next = [...dismissed, suggestionKey(s)]
              setDismissed(next)
              writeLocal(DISMISSED_KEY, next)
            }}
          />
        )
      },
      renderExtraSections: (ctx) => <OtherTablesSections {...ctx} />,
      onCreate: () => setPanel('create')
    }
  }, [isAdmin, panel, dismissed])

  return (
    <>
      <CollectionsDirectory isAdmin={isAdmin} favorites={favorites} admin={admin} />
      {isAdmin && <CollectionDesigner open={designerOpen} onClose={() => setDesignerOpen(false)} />}
    </>
  )
}
