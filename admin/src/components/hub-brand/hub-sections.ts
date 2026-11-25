import { HUB_PATHS } from '@/lib/hubs'

/**
 * The standalone Hub's top-bar sections, as config. A section whose route does not exist in this
 * build (another Hub area not shipped yet: Fleet, Deploys, Moves, People…) is hidden, never a
 * dead link. Everything else a standalone Hub keeps (HUB_ONLY_NAV: Users, Roles, Health, Jobs…)
 * goes under "System" in the bar.
 */
export interface HubSection {
  label: string
  to: string
  /** Other paths that light this section up (its own tab paths). */
  match?: (path: string) => boolean
}

export const HUB_SECTIONS: HubSection[] = [
  { label: 'Fleet', to: '/hub/fleet' },
  {
    label: 'Apps',
    to: '/hub',
    // The Apps hub's own tabs that have no section of their own.
    match: (p) =>
      p === '/hub' ||
      ['/hub/drivers', '/hub/targets', '/hub/databases', '/hub/signin'].some(
        (t) => p === t || p.startsWith(`${t}/`)
      )
  },
  { label: 'Deploys', to: '/hub/deploys' },
  { label: 'Shared', to: '/hub/shared' },
  { label: 'Moves', to: '/hub/moves' },
  { label: 'People', to: '/hub/people' },
  { label: 'Settings', to: '/settings' }
]

/** Routes outside the hub registry this build is known to answer. */
const PLAIN_ROUTES = new Set(['/settings'])

export function routeExists(to: string, hubPaths: ReadonlySet<string> = HUB_PATHS): boolean {
  return hubPaths.has(to) || PLAIN_ROUTES.has(to)
}

/** The sections this build shows, in order. */
export function visibleSections(
  hubPaths: ReadonlySet<string> = HUB_PATHS,
  sections: HubSection[] = HUB_SECTIONS
): HubSection[] {
  return sections.filter((s) => routeExists(s.to, hubPaths))
}

/** Is `section` the one `path` is in? */
export function sectionActive(section: HubSection, path: string): boolean {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path
  if (section.match) return section.match(p)
  return p === section.to || p.startsWith(`${section.to}/`)
}
