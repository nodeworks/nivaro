import {
  APPS_HUB,
  allowedHubTabs,
  type HubDef,
  type HubTabDef,
  type HubTabGroup,
  hubForPath,
  hubTabGroup,
  hubTabPath
} from '@/lib/hubs'

/**
 * The standalone Hub's top-bar sections. They ARE the Apps hub's groups (lib/hubs.ts): one map
 * of the Hub for the top bar, the strip under it, the Find box and the docs, so a page has one
 * home whichever way a person looks for it.
 *
 * A section shows only when this person may use at least one of its pages. An app owner (not a
 * Hub administrator) is never offered a page only administrators can use (`adminOnly`), so a home
 * with nothing for them does not show at all. Beyond that it is exactly as the old sidebar decided: the Apps entry in their permitted nav AND the tab allowed by their role's
 * ui_permissions (allowedHubTabs). It links to the first page they may open. Everything else a
 * standalone Hub keeps (HUB_ONLY_NAV: Users, Roles, Health, Jobs, Settings…) goes under "System".
 */
export interface HubSection {
  /** The group key (lib/hubs.ts); stable. */
  key: string
  /** Short name, as the bar shows it ("Domains"). */
  label: string
  /** Full name ("Domains, DNS and certificates"): the tip, and the phone menu. */
  title: string
  /** The first page of the section this person may open. */
  to: string
  /** Every page of the section this person may open, in strip order. */
  pages: Array<{ label: string; to: string; hint?: string }>
}

export interface SectionAccess {
  /** The nav entries this person may open (permittedCategories keys / paths). */
  permitted: ReadonlySet<string>
  /** Their role's ui_permissions (useUiPermissions). */
  disabled: ReadonlySet<string>
  /** false = signed in and not a Hub administrator: admin-only pages are left out. */
  admin?: boolean
}

/** May this person open `to` (same rule as the sidebar)? */
export function sectionAllowed(to: string, access: SectionAccess): boolean {
  const match = hubForPath(to)
  if (match) {
    if (!access.permitted.has(match.hub.base)) return false
    return allowedHubTabs(match.hub, access.disabled as Set<string>).some(
      (t) => hubTabPath(match.hub, t) === to && !(access.admin === false && t.adminOnly)
    )
  }
  return access.permitted.has(to)
}

function sectionOf(hub: HubDef, group: HubTabGroup, tabs: HubTabDef[]): HubSection | null {
  const pages = group.tabs
    .map((p) => tabs.find((t) => t.path === p))
    .filter((t): t is HubTabDef => !!t)
    .map((t) => ({ label: t.label, to: hubTabPath(hub, t), hint: t.hint }))
  if (pages.length === 0) return null
  return {
    key: group.key,
    label: group.label,
    title: group.title ?? group.label,
    to: pages[0].to,
    pages
  }
}

/** The sections this person sees, in order (no `access` = everything, as an administrator). */
export function visibleSections(
  access: SectionAccess | null,
  hub: HubDef = APPS_HUB
): HubSection[] {
  if (access && !access.permitted.has(hub.base)) return []
  const tabs = (access ? allowedHubTabs(hub, access.disabled as Set<string>) : hub.tabs).filter(
    (t) => !(access?.admin === false && t.adminOnly)
  )
  return (hub.groups ?? []).map((g) => sectionOf(hub, g, tabs)).filter((s): s is HubSection => !!s)
}

/** The section `path` is in: the group of the Hub page it shows, else none (a System page). */
export function activeSection(sections: HubSection[], path: string): HubSection | null {
  const match = hubForPath(path)
  if (!match?.hub.groups) return null
  const group = hubTabGroup(match.hub, match.tab.path)
  return sections.find((s) => s.key === group?.key) ?? null
}
