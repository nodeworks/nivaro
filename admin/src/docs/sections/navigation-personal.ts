import type { DocSection } from '../types.js'

/**
 * #3225 / #3226 / #3227 — breadcrumbs that follow your path, recently viewed
 * everywhere, and personal sidebars with role starters.
 */
export const navigationPersonal: DocSection = {
  id: 'navigation-personal',
  label: 'Breadcrumbs, Recent & Your Sidebar',
  audience: 'all',
  content: [
    { type: 'h1', id: 'navigation-personal', text: 'Breadcrumbs, Recent & Your Sidebar' },
    {
      type: 'p',
      text: 'Three things follow the way you work rather than the fixed menu: breadcrumbs that show how you actually reached a page, your recently viewed records in the sidebar and the command palette, and a sidebar you can arrange for yourself.'
    },

    { type: 'h2', id: 'navigation-breadcrumbs', text: 'Breadcrumbs that know the path' },
    {
      type: 'p',
      text: 'The header of a record (and of a collection’s records page) shows the pages you came through in this browser tab, for example **Pending approvals › PO 4471** while you look at one of its lines. The trail starts at the list, queue, hub or menu page you began from, and a page you visited twice shows once.'
    },
    {
      type: 'ul',
      items: [
        'Clicking a crumb goes back to that exact page: the same filters, the same tab, and the scroll position you left it at. The nearest crumb is the same place the page’s back arrow takes you.',
        'Cmd/Ctrl-click (or middle-click) opens a crumb in a new tab.',
        'Each browser tab keeps its own trail. It survives a reload of the tab.',
        'Opened from a link or bookmark with no trail yet, the breadcrumb shows where the page lives instead: **Collections › Purchase Orders**.',
        'Record names in the trail are read as you, so you only ever see names you are allowed to see.',
        'On a phone only the nearest crumb shows.'
      ]
    },

    { type: 'h2', id: 'navigation-back-to-list', text: 'Back to the exact list' },
    {
      type: 'p',
      text: 'Open a record from a list — a collection’s records, a queue worklist, search results — and going back returns to that list exactly as you left it: the same saved view, filters, search, sort, columns, page and scroll position. The crumb names it, for example **Workflows · My open · page 3**.'
    },
    {
      type: 'ul',
      items: [
        'The list keeps what it shows in its own address (the `lv` parameter), so the browser’s Back button, a crumb, a record’s back arrow, a reload and a copied address all bring the same list back.',
        'A list in its plain state (your default view, nothing changed) keeps a clean address.',
        'The saved view comes back highlighted when you still have it; someone you send the address to sees the same settings, read with their own access.',
        'Scroll positions are kept per browser tab and are not sent anywhere.'
      ]
    },

    { type: 'h2', id: 'navigation-recent', text: 'Recently viewed everywhere' },
    {
      type: 'p',
      text: 'The records you opened last now show in three places, all from the same list as the home page’s Recently viewed card:'
    },
    {
      type: 'ul',
      items: [
        '**Command palette (Cmd+K)** — before you type anything, Recently viewed is the first section.',
        '**Sidebar** — a short Recent list (up to five) at the bottom of every panel. Click its heading to fold it away; the choice is remembered in this browser.',
        'Each record shows its current pipeline state, and a **dot** when someone else changed it (an edit, a move or a comment) since you last opened it.'
      ]
    },
    {
      type: 'note',
      text: 'The dot only counts what you can see: an edit to a field your role cannot read does not light it, and records that have left your view are not listed.'
    },

    { type: 'h2', id: 'navigation-edited-by-me', text: 'Recently edited by me' },
    {
      type: 'p',
      text: 'Beside the records you opened, a second list shows the records you **changed** — created, edited, moved in the pipeline or commented on — newest first across every collection, each saying what you did: **Moved to Approved · edited 3 fields**. It is the **Edited by me** tab on the home page’s Recently viewed card, and the Edited by me section of the command palette in the portal.'
    },
    {
      type: 'ul',
      items: [
        'Built from your own entries in the activity log; nothing extra is recorded.',
        'Every record is checked as you: one you can no longer read (a scope or filter change, or it was deleted) is left out, and names are the ones you are allowed to see.',
        'Linking records (for example adding a division) counts as an edit of the record you linked them on.'
      ]
    },

    { type: 'h2', id: 'navigation-sidebar', text: 'Your own sidebar' },
    {
      type: 'p',
      text: 'Click the sliders button at the top of any sidebar panel to customise it. **This panel**: for each page you can pin it to the top of the panel, hide it, or move it up and down inside its section. **Main sections**: hide whole sections from the icon rail down the left edge and put the rest in your order (sections move within their own group, and at least one always stays). Changes save straight away and follow you to any computer. **Reset to default** puts every panel and the main sections back.'
    },
    {
      type: 'ul',
      items: [
        'You can only arrange pages your role may open; customising never adds a page.',
        'Favorites (the star) still holds your own cross-panel shortcuts — customising a panel does not change them.',
        'If everything in a panel is hidden, the panel says so; open Customize to bring pages back.'
      ]
    },

    { type: 'h2', id: 'navigation-role-starter', text: 'Starter sidebars per role (admins)' },
    {
      type: 'p',
      text: 'In **Roles → <role> → Sidebar** an administrator sets the sidebar people with that role start from: the main sections (hide and order) and the same pin, hide and order controls for each panel, listing only the sections and pages the role may open. Anyone with the role who has not customised their own sidebar sees it, and Reset to default brings people back to it. **Clear starter** returns the role to the standard sidebar.'
    },

    { type: 'h3', id: 'navigation-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        [
          '`GET /api/record-views/recent?limit=&changed=1`',
          'signed in',
          'Your recently viewed records; `changed=1` adds `changed` + `changed_at` (judged on what you can read).'
        ],
        [
          '`GET /api/record-views/edited?limit=`',
          'signed in',
          'Records you changed, newest first (≤30): `{collection, collection_label, item_id, label, did, last_edited_at, kinds, state}`; each read as you.'
        ],
        [
          '`PATCH /api/users/me/preferences {nav_layout}`',
          'signed in',
          'Your own sidebar layout `{v:1, categories:{<id>:{pinned,hidden,order}}}`; `null` = back to your role’s starter.'
        ],
        ['`GET /api/nav-layout/starter`', 'signed in', 'Your role’s starter layout (or null).'],
        ['`GET /api/nav-layout/roles`', 'admin', 'Every role’s starter.'],
        [
          '`PUT /api/nav-layout/roles/:roleId {layout}`',
          'admin',
          'Set or clear (`null`) one role’s starter.'
        ]
      ]
    }
  ]
}
