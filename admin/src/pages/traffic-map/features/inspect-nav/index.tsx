// Investigation group "nav" — Task 7 of the Traffic Map drill-down program.
// Registers the `load` (page load waterfall) and `search` inspectables, the Related rail and the
// Page load link (inspectFooters), the time anchor and keys header actions, and the toolbar search
// box. Imported once from registry/index.ts; edit only this folder.
import { shortId } from '../../inspect/format'
import { inspectables } from '../../registry/inspectables'
import { inspectFooters } from '../../registry/inspectFooters'
import { inspectHeaderActions } from '../../registry/inspectHeaderActions'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import { AnchorAction, KeysAction } from './HeaderActions'
import { LoadPanel } from './LoadPanel'
import { PageLoadLink, pageLoadApplies, RelatedRail } from './RelatedRail'
import { SearchBox, SearchPanel } from './Search'

register(inspectables, {
  id: 'load',
  label: 'Page load',
  Panel: LoadPanel,
  title: (ref) => ref.label ?? `Page load ${shortId(ref.id)}`
})

register(inspectables, {
  id: 'search',
  label: 'Search',
  Panel: SearchPanel,
  title: (ref) => ref.label ?? `Search “${ref.id.length > 24 ? `${ref.id.slice(0, 22)}…` : ref.id}”`
})

register(inspectFooters, {
  id: 'nav-page-load',
  order: 9,
  applies: pageLoadApplies,
  Component: PageLoadLink
})

register(inspectFooters, {
  id: 'nav-related',
  order: 10,
  applies: (ref) => ref.kind !== 'search',
  Component: RelatedRail
})

register(inspectHeaderActions, { id: 'nav-anchor', order: 10, Component: AnchorAction })
register(inspectHeaderActions, { id: 'nav-keys', order: 90, Component: KeysAction })

register(toolbarItems, { id: 'nav-search', slot: 'actions', order: 1, Component: SearchBox })
