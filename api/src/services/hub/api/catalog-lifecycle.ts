import type { HubField, HubRoute } from './catalog.js'

/**
 * Catalog entries for the Hub app lifecycle routes (routes/hub-lifecycle.ts: app cloning, the
 * retirement wizard). Kept beside catalog.ts so its list stays one spread line; the catalog guard
 * test reads HUB_ROUTES, which includes these.
 */

const s = (description: string, extra: Partial<HubField> = {}): HubField => ({
  type: 'string',
  description,
  ...extra
})
const o = (description: string): HubField => ({ type: 'object', description })
const list = (items: HubField['items'], description: string): HubField => ({
  type: 'array',
  items,
  description
})

const r = (
  method: HubRoute['method'],
  path: string,
  auth: HubRoute['auth'],
  access: HubRoute['access'],
  summary: string,
  extra: Partial<HubRoute> = {}
): HubRoute => ({ method, path, group: 'Lifecycle', auth, access, summary, ...extra })

const HEALS = 'This read also heals: a run whose server stopped is marked interrupted (idempotent).'

const SIGN_OFF = {
  note: s('Sign-off note (why, what you checked); required when something is done by hand'),
  confirm: s('freeze on an app with production, and remove: type the app key'),
  checklist_runs: o('First step only: environment id → the ticked `retire` checklist run'),
  manual: list(
    'integer',
    'freeze / remove: environments you handled by hand (no hub link / no stack)'
  ),
  skip: list('object', 'export: {environment_id, what: db|files} parts the Hub cannot back up'),
  reason: s('export: why the skipped parts need no backup (at least 10 characters)'),
  notice: s('notice: the final notice text (default: the one the retirement opened with)')
}

export const LIFECYCLE_ROUTES: HubRoute[] = [
  r(
    'GET',
    '/lifecycle/clones',
    'admin',
    'read',
    'Recent structure copies (each one a library template)'
  ),
  r(
    'POST',
    '/environments/:envId/clone',
    'admin',
    'write',
    'Copy an environment’s app structure into the template library',
    {
      notes:
        'Reads GET /api/hub-link/clone/blueprint (or the shared deployment’s /api/hub-deployment/clone/apps/<tenant>/blueprint) on the source, 0.3.215+: collections, fields, relations, workflows and pipelines, layouts, queues, rules (off), roles and flows (inactive). No records, files, people or secrets — credential values are emptied on the source before it answers. Create app then installs the template like any other. 409 SOURCE_TOO_OLD, ENV_ARCHIVED, TEMPLATE_EXISTS; 413 TOO_LARGE.'
    }
  ),
  r('GET', '/retirements', 'owner', 'read', 'Retirements the caller may see (owners: their apps)', {
    notes: HEALS
  }),
  r('GET', '/retirements/:id', 'owner', 'read', 'One retirement, step by step', { notes: HEALS }),
  r(
    'POST',
    '/apps/:id/retire/plan',
    'admin',
    'plan',
    'What retiring an app would do, and what blocks it'
  ),
  r('POST', '/apps/:id/retire', 'admin', 'write', 'Open a retirement on the plan read', {
    sensitive: true,
    body: {
      plan_hash: s('The plan_hash of the plan read', { required: true }),
      notice: s('The final notice to the app’s people (at most 2000 characters)')
    },
    notes:
      '409 PLAN_STALE (the app changed), PLAN_BLOCKED (RETIRE_OPEN, MOVE_OPEN, CREATION_OPEN, APP_ARCHIVED).'
  }),
  r(
    'POST',
    '/retirements/:id/steps/:step',
    'admin',
    'write',
    'Sign off and start the next step: freeze, export, notice, remove, archive',
    {
      sensitive: true,
      accepted: true,
      body: SIGN_OFF,
      notes:
        'Steps go in order; each is judged at start: MOVE_OPEN, CREATION_OPEN, freezes and deploy windows (action retire; FROZEN, OUTSIDE_WINDOW), the retire checklist of every production environment (claimed at the first step), CONFIRM_REQUIRED, MANUAL_NEEDED, EXPORT_INCOMPLETE. remove cannot be undone.'
    }
  ),
  r('POST', '/retirements/:id/undo', 'admin', 'write', 'Undo the last reversible step', {
    accepted: true,
    notes:
      'Never waits on a freeze, window or checklist. 409 NOT_UNDOABLE once the removal started.'
  }),
  r(
    'POST',
    '/retirements/:id/cancel',
    'admin',
    'write',
    'Undo every reversible step and close the retirement',
    { accepted: true, notes: '409 NOT_CANCELLABLE once the removal started.' }
  ),
  r(
    'POST',
    '/retirements/:id/resume',
    'admin',
    'write',
    'Continue a step whose Hub process stopped',
    { accepted: true }
  )
]
