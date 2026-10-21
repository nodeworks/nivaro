import type { DocSection } from '../types'

export const layoutEditor: DocSection = {
  id: 'layout-editor',
  label: 'Layout Editor',
  content: [
    { type: 'h1', id: 'layout-editor', text: 'Layout Editor' },
    {
      type: 'p',
      text: 'Every form in Nivaro is a layout: which fields a record shows, in which sections, tabs or steps, with which panels and rules. The layout editor is where they are built. It opens from Data Model → a collection → Layout tab, and from any record page with Edit layout (admins only, in Nivaro admin and in headless frontends such as efp-new). The canvas is the real record form, so what you arrange is exactly what people get.'
    },

    { type: 'h2', id: 'layout-editor-overview', text: 'Which form does each record get?' },
    {
      type: 'p',
      text: 'The Layout tab opens on an overview that answers one question in plain words: which form does each kind of record open with, and why. Rows are listed in the order the server checks them, so reading top to bottom is reading the resolution itself. A `?layout=<id>` link skips the overview and opens that layout in the editor.'
    },
    {
      type: 'table',
      head: ['Section', 'What it lists'],
      rows: [
        [
          'Forms people fill in — checked in this order',
          'One row per grouped layout. "When the record…" is the layout\'s record rules as a sentence with field and choice labels ("is not unit-specific and is sparing"), role restrictions by role name ("for Finance only"), and "anything else" on the default. "Opens" names the layout with a default or rule pill and a shape line ("4 steps · 34 fields"). "Also" shows the New-menu label or "hidden from New menu". A row that can never be reached (another layout always matches first) carries a quiet warning.'
        ],
        [
          'Opened by a link or button only',
          "Grouped layouts nothing resolves to on its own but that have a link name: reached by `?layout=<slug>`, a queue's item layout, a grid's layout_slug or a transition dialog. Known references are listed."
        ],
        [
          'Other views of the same record',
          'Summary (read mode), detail (drill-down panel), file (PDF), addendum and table (grid columns when the collection is shown inside another record), each with one line on what uses it.'
        ],
        [
          'Unused',
          'Layouts nothing resolves to or references, with Delete. A layout with a link name is never called unused — it may be used by URLs or code. Delete lists any references it finds before asking you to confirm.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Order among grouped forms is computed (layouts with more record rules first, then role preferences, then the default), so those rows are not draggable. Drag to reorder exists only where `sort` decides — the first-by-sort fallbacks for table, addendum, detail and summary layouts.'
    },
    {
      type: 'ul',
      items: [
        'New form — asks for the kind up front (form, summary, detail, PDF, addendum, grid columns), then opens it in the editor.',
        'Row menu — Open, Rename, Duplicate, Duplicate as summary, Make default, Delete.',
        'No layouts yet — the empty state explains what a form layout is and offers Create first form, which seeds one section "Main" holding every visible field of the collection.'
      ]
    },

    { type: 'h3', id: 'layout-editor-test-record', text: 'Test a record' },
    {
      type: 'p',
      text: 'Test a record… picks a saved record and lights up the row it resolves to, with the reason in words, and says for every other form why it was passed over ("Its record rules do not match", "A form with record rules matched first", "Restricted to other roles"). Optionally test as a role. The test runs the live `/active` resolution itself — there is no separate preview logic — so the answer is what that person would get.'
    },

    { type: 'h2', id: 'layout-editor-editor', text: 'The editor' },
    {
      type: 'p',
      text: 'Three areas: on the left the layouts of the collection (grouped as on the overview, each with a one-line purpose) and an entry for Form settings; in the centre the canvas; on the right the inspector for whatever is selected. The top bar carries the layout name and purpose, Preview as, History, Undo / Redo and the save status.'
    },
    { type: 'h3', text: 'Canvas' },
    {
      type: 'p',
      text: 'The canvas is the shared record form (ItemEditForm, or the read view for summary and detail layouts) running in design mode: same styles, spacing, steps or tabs, header strip and slot cards as a real record. Inputs are inert — nothing on the canvas writes to a record, takes a lock or runs a rule that saves. Click a field, section, tab, slot card, header strip item or widget to select it (from the keyboard: Tab to it, Enter). Empty sections show a drop zone; Show hidden reveals fields and sections the preview would hide, faintly, so they can still be selected.'
    },
    {
      type: 'p',
      text: 'Preview as picks a record: the canvas shows its real values, its steps, and the fields its rules show or hide. "As a role" previews the form the way a role sees it — hidden and read-only fields are marked.'
    },
    {
      type: 'p',
      text: 'The same Preview as popover holds the other preview modes. A strip above the canvas says what each active mode changes; its × turns that mode off. Nothing in them changes a record.'
    },
    {
      type: 'ul',
      items: [
        'Compare with a second role: the canvas splits in two, the same record as each role. Fields one role can edit and the other only read (or never see), and sections only one of them sees, are ringed and tagged Differs; hover the tag for both answers. Both halves are preview only: select to edit, but drag on a single canvas.',
        'Workflow state: pick a state of a pipeline bound to the collection and the form shows it as if the record were there — the fields that state locks, and what each move out of it needs (tagged Needed to move on) — without finding a record in that state.',
        'What if: pick a field a step’s "Only when" condition reads, then one of the values the condition tests, Empty, or any value. The canvas lays it over the record and tags the steps that appear (Appears) or disappear (Hides, seen with Show hidden).',
        'Device: Desktop, Tablet (768 px) or Phone (390 px). The form measures its own width, so columns wrap exactly as on that screen.',
        'Who sees each field: every field is tinted by how many roles see it (every role, most, some, few, none — legend in the strip) with a chip such as 3/5 roles; click the chip for the roles that can edit it, only read it, or never see it. It combines each role’s permissions with this form’s section and lock rules; administrators see everything and are not counted.'
      ]
    },
    { type: 'h3', text: 'Inspector' },
    {
      type: 'table',
      head: ['Tab', 'What it holds'],
      rows: [
        [
          'Look',
          'Label on this form (or hidden), width, help text, placeholder, how the value is shown: input type, format, currency, unit, precision, input mask.'
        ],
        [
          'Rules',
          'Required, read-only, hidden, lock conditions, default value for new records, maximum number of values.'
        ],
        [
          'Picker',
          'Relation fields only: cascade filters, option field and sort, picker rules, pick or upload, inline editing, prefill from the parent, drill-down panel.'
        ],
        [
          'Grid / Table',
          'Child-record grids only: columns, row rules, parent cascades, parent context fields, the row-rule tester.'
        ],
        ['Advanced', 'Raw overrides and the keys that have no editor of their own.']
      ]
    },
    {
      type: 'p',
      text: 'Sections, tabs and steps, slot cards (pipeline, comments, tasks, owners, PDF, extension panels), header strip items, the subtitle and widgets each get an inspector of their own.'
    },
    { type: 'h3', id: 'layout-editor-scope', text: 'This form only vs every form' },
    {
      type: 'p',
      text: 'Every setting says where it applies. Most are this form only: they save with the layout (on Save, or at once with Autosave on) and can be undone. Some live on the field itself (format, currency, unit, mask, cascade filters, column presets, grid totals, file options, deprecation) and change every form that shows the field; a widget\'s own settings change every form that places it. Those are marked "every form", sit outside Undo and History, and save only after an inline confirm ("Save for every form") that names what else they affect.'
    },
    {
      type: 'note',
      text: 'Row rules, row lints, picker enforcement, max values and line SLA are enforced on the server from the default grouped form only. On any other layout the inspector labels those keys "enforced on the default form only".'
    },
    { type: 'h3', text: 'Form settings' },
    {
      type: 'p',
      text: "Layout-wide settings in short named sections, each control with a one-line effect, searchable from the box at the top: Who gets this form (kind, record rules, roles by name, link name, New-menu label and hiding) · How it's laid out (tabs or steps, check each step before Next, one section open at a time) · Buttons & panels (hide comments, tasks, revisions, clone, delete, banners; Schedule and Hide-from-pickers buttons for everyone) · Read view & summary · PDF (file layouts only) · Addendum · Defaults for new records · Inheritance · AI review, previews, version history. Only the settings that apply to the layout's kind are shown — addendum layouts get every setting that applies to them."
    },
    {
      type: 'p',
      text: '"Schedule button for everyone" and "Hide-from-pickers button for everyone" give people who may edit the record "Schedule a change…" and "Disable in pickers" (administrators always have both). Nivaro admin shows them in the record header; the shared record form shows them in its More menu when the host turns on `showGrantedTools` (efp-new does). The server checks the same grant for both. A non-admin must be able to see the record (otherwise the answer is Not found), the form that record opens with for them must have the setting on, and they must be allowed to update this record — the update rules of their role for the collection, its row filter and any tree permission, not just access to the collection. A form opened with a `?layout=` link counts only when it is a record form their role may open and its record rules match this record; naming any other form never grants the tool. Scheduling also checks every field in the change: each must be one the person may update, and a registered field with its own column that is not read-only, computed or an audit stamp; otherwise the request is refused naming the field. People who are not administrators see the scheduled changes on a record only when they can see the record, with values of fields they may not read left out, and may cancel only their own changes on records they can still update.'
    },
    { type: 'h3', text: 'Add panel' },
    {
      type: 'p',
      text: 'Add a field, section, panel or widget opens a searchable list showing labels (the key as secondary text), the type and an "on this form" mark for what is already placed. Click a row to add it after the selection, or drag it onto the canvas. A field already on the form can be added again ("Add another copy") — the same field may sit in two places, such as the header strip and a section.'
    },
    { type: 'h3', text: 'Drag and drop' },
    {
      type: 'ul',
      items: [
        'The whole element is the handle: field, section header, tab, step or slot card. Keyboard drag works too (focus, Space to lift, arrows to move, Space to drop, Escape to cancel).',
        'The drag preview is a copy of the element as it looks on the form, under the cursor at any scroll position; the canvas scrolls when you near its edge.',
        'An insertion slot opens where the element will land, within a section or across sections, including into an empty section. Dropping on a section header puts the field first in that section; sections reorder by dropping anywhere on the target section.',
        "Widths change with the inspector's width control, snapping to the grid fractions.",
        'Alt+arrow moves the selected item in one keystroke, without picking it up. A field: Alt+↑ / Alt+↓ moves it one place in its section; Alt+← / Alt+→ moves it to the end of the previous section or the start of the next. A section moves up or down the page; a tab or step moves left or right. Each keystroke is one Undo step.'
      ]
    },
    { type: 'h3', id: 'layout-editor-multi-select', text: 'Several fields at once' },
    {
      type: 'p',
      text: 'Shift-click (or ⌘ / Ctrl-click) fields to select several; click one again to take it out. The inspector then shows what they share: width, Required, Read-only, Hidden and Section. Each change applies to all of them as one Undo step. "Section" moves them to the end of that section, in the order they are on the form; a field the section already holds stays where it is. Sections, header items and page cards are selected one at a time. Dragging moves one item; use Section to move several.'
    },
    { type: 'h3', id: 'layout-editor-auto-arrange', text: 'Auto-arrange' },
    {
      type: 'p',
      text: 'Auto-arrange packs fields into tidy rows of the 12-column grid. A row with room left takes the widest of the next few fields that fits, so the order mostly holds, and "Widen fields to fill rows" stretches the fields of a row that still has room. The popover lists what changes per section (rows, gaps closed, fields moved and widened) before you press Arrange; the whole change is one Undo step. The top bar arranges the whole form; a section\'s inspector arranges that section only. Hidden fields stay next to the field they followed.'
    },
    { type: 'h3', id: 'layout-editor-table-view', text: 'Table view' },
    {
      type: 'p',
      text: 'Canvas | Table in the top bar switches the centre to a table of every field on the form, grouped by section: the label on this form, section, width, Required, Read-only and Hidden, all editable in place. Shift- or ⌘-click rows (or tick their boxes) to select several and change them together in the inspector. Fields that come from a parent layout are not listed. Table and PDF layouts keep their own canvases.'
    },
    { type: 'h3', id: 'layout-editor-find', text: 'Finding your way on a long form' },
    {
      type: 'ul',
      items: [
        'Find (⌘F / Ctrl+F in the editor, or the search button in the top bar) finds a field, panel, step, tab or section by label or key. Picking a match opens the step or tab it sits on, unfolds its section, scrolls to it and selects it. Hidden fields and fields a rule hides are found too; picking one turns on Show hidden when the form would not show it.',
        'Outline (the tree button in the top bar) lists the header strip, steps, tabs, sections and their fields beside the canvas. Clicking a row selects it on the canvas, and selecting on the canvas marks its row. Drag rows to reorder: the same moves as dragging on the canvas, one Undo step each. Parts that come from a parent layout show but do not move. The outline stays open for you until you close it.',
        "The inspector's header shows where the selection sits, for example Field · Flow › Billing. Click a part to select that step, tab or section.",
        'The canvas view button has Compact canvas (smaller spacing and inputs in the editor only, kept for you in this browser; the record page is unchanged), Expand all (every section open and every step and tab laid out one under another) and Collapse all (every section folded; steps and tabs back to one at a time).',
        'Press ? (when not typing) or the keyboard button for every shortcut, grouped by area: undo and redo, duplicate, moving with Alt+arrows or Space, find, the command palette and save.'
      ]
    },
    { type: 'h3', id: 'layout-editor-saving', text: 'Saving, undo and conflicts' },
    {
      type: 'p',
      text: 'Changes wait for Save. The form shows each change at once, but nobody else sees it until you press Save (or ⌘S / Ctrl+S); the top bar counts them ("3 unsaved changes") and Save turns blue while there is something to save. One Save sends every change together, and History names them.'
    },
    {
      type: 'p',
      text: 'Autosave (the switch in the top bar) saves every change as you make it instead; the status chip reads Saving… then Saved. It is off each time the editor opens and stays as you set it until you close the editor. Turning it on saves anything unsaved straight away.'
    },
    {
      type: 'p',
      text: "Leaving with unsaved changes asks first, beside what you clicked: Save, Discard or Keep editing. That covers Back, Done, Escape, opening another layout in the rail and links elsewhere in the app; closing or reloading the browser tab gets the browser's own warning. If the editor closes some other way (the browser's back button), the changes stay with that layout: open it again to save or discard them."
    },
    {
      type: 'p',
      text: 'Undo and Redo (⌘Z / ⇧⌘Z, Ctrl+Y) step back through this session\'s changes, saved or not, each named ("Undo Move Status"). Undoing an unsaved change just takes it away; undoing a saved one is a new change to save (or saves at once with Autosave). Typing in one box counts as one change until you leave the box, and a refresh never overwrites what you are typing or anything unsaved.'
    },
    {
      type: 'p',
      text: 'Changes go to the server as small operations against the revision the editor last saw. If another admin (or you in another tab) saved in between: with Save, your changes are laid on top of theirs and kept for you to Save again; if one no longer fits (they removed what it changed), a banner offers Reload, which discards your changes and shows their version. With Autosave, the editor reloads the layout, clears Undo and the chip reads "Reloaded — someone else saved". Nothing is silently overwritten. A refused Save keeps your changes and says why. Restoring a version from History drops unsaved changes.'
    },
    { type: 'h3', id: 'layout-editor-history', text: 'History' },
    {
      type: 'p',
      text: 'History lists the saved versions of the layout — one per editing burst, sections included — with who saved and the change\'s name. "What the last save changed" shows the newest difference first; any version can be compared with the layout now. Restore replaces the layout with that version exactly (sections added since are removed) after keeping the current one as a version first. Versions survive a layout delete.'
    },
    { type: 'h3', text: 'Inherited layouts' },
    {
      type: 'p',
      text: 'A layout that inherits from a parent shows the parent\'s placements on its canvas marked "from <parent>" and locked (an inherited step or tab gets a small dot instead, with the parent\'s name in its tip). The inspector offers Override here (copies the placement into this layout as the parent last saved it, then editable) and Edit in <parent>.'
    },

    { type: 'h2', id: 'layout-editor-other-kinds', text: 'Table and PDF layouts' },
    {
      type: 'ul',
      items: [
        'Table layouts (the columns a collection shows when it is a grid inside another record) edit on a columns strip that looks like the real grid header: column order and width, plus the Apply values and Create with defaults zones.',
        'File (PDF) layouts edit their sections in form style, labelled as the PDF prints them; Preview with sample values waits for the last change to save (unsaved changes are not in it — Save first), then renders the real PDF in a new tab. Theme, cover, logo, page size, orientation and button label live in Form settings → PDF, which has its own Preview PDF.',
        'Summary and detail layouts edit on the read view they render as, with the same selection and drag handles.'
      ]
    },

    { type: 'h2', id: 'layout-editor-record-page', text: 'Edit layout from a record' },
    {
      type: 'p',
      text: "On a record page an admin sees Edit layout in the record header (Nivaro admin ItemEdit and efp-new RecordDetail). It switches that page's form into design mode on the layout this record resolved to, with the layouts list, inspector and add panel as side panels over the page. The editor keeps the layout it opened on even if a save changes which layout the record resolves to. Back to record closes it at once; the record re-reads its layout as soon as the last change has saved, so it never shows the form from before your last edit. When the collection has no layout yet, the button links to the Layout tab to create the first form. When the page's ?layout= link names a form that doesn't exist, the button says Form not found and links to the collection's forms instead."
    },
    {
      type: 'p',
      text: 'Edits are the same operations, saving and History as in the Layout tab. People who are not administrators never see the button and never download the editor: it is a separate chunk, loaded only when an admin turns the mode on (efp-new loads it through the `@nivaro/react/layout-editor` subpath export).'
    },

    { type: 'h2', id: 'layout-editor-warning', text: 'Instances whose layouts are replaced' },
    {
      type: 'p',
      text: 'Layout configuration travels one way: development → staging every night (promote:config copies the layout, section and placement tables), staging → production at go-live. An edit made on staging is therefore gone the next morning. Set `LAYOUT_EDIT_WARNING` on such an instance and every layout editing surface — the overview, the editor and record-page Edit layout — shows it as an always-visible banner. Unset = no banner. The editor still works either way.'
    },
    {
      type: 'pre',
      code: `# staging .env
LAYOUT_EDIT_WARNING=Layouts here are replaced every night from development. Make lasting changes on development.`
    },

    { type: 'h2', id: 'layout-editor-api', text: 'API' },
    {
      type: 'p',
      text: 'Layout writes are admin-only. The older endpoints (PATCH a layout, PUT all placements, the field-groups routes) keep working for scripts; the editor uses the bundle + ops pair.'
    },
    {
      type: 'pre',
      code: `GET  /api/collection-layouts/overview?collection=orders
     → { data: { rows: [...], warning: string | null } }   // sectioned, in /active order

GET  /api/collection-layouts/explain?collection=orders&item=42[&role_id=<uuid>][&slug=x]
     → { data: { layout_id, reason, checked: [{ layout_id, matched, why }] } }

POST /api/collection-layouts  { collection, name, layout_type?, slug?, seed_fields?: true }
     // seed_fields: one section "Main" holding every visible field ("Create first form")

GET  /api/collection-layouts/:id/bundle
     → { layout, groups, placements, rev }

POST /api/collection-layouts/:id/ops  { ops: LayoutOp[], base_rev, note? }
     → the new bundle (applied all or nothing, at most 500 ops)
     409 { error: 'stale', bundle }       // someone saved since base_rev
     400 { error, op_index }              // an op was refused (also a rename onto a taken name)

POST /api/field-config/:collection/project  { assignments: [...] }   // administrators
     // the field rows GET /field-config would return if these placements were saved
     // (read-only: the canvas renders unsaved drafts through it; flushes no cache, pushes nothing)

GET  /api/collection-layouts/field-access?collection=orders      // administrators
     → { data: { roles: [{ role: { id, name, admin_access }, can_read, can_update,
                           hidden_fields, readonly_fields }] } }   // every role's field permissions

GET  /api/widgets-internal/:id/placements
     → { data: [{ layout_id, name, collection }] }   // every layout placing the widget`
    },
    {
      type: 'table',
      head: ['Op', 'Shape'],
      rows: [
        ['place', '`{ op, field, group_key, index, patch? }` — add a placement'],
        ['move', '`{ op, from: { field, group_key }, to_group_key, index }`'],
        ['update_placement', '`{ op, at: { field, group_key }, patch }`'],
        ['remove', '`{ op, at: { field, group_key } }`'],
        [
          'group_create',
          '`{ op, key, label, group_type, parent_key, index, patch? }` — section, tab or step'
        ],
        [
          'group_update',
          '`{ op, key, patch }` — a group holding fields cannot become a container or a text block'
        ],
        ['group_move', '`{ op, key, parent_key, index }` — also moves slot cards on the page'],
        ['group_remove', "`{ op, key, placements: 'ungroup' | 'delete' }`"],
        ['layout_update', '`{ op, patch }` — any setting PATCH /collection-layouts/:id accepts']
      ]
    },
    {
      type: 'note',
      text: "Placements are keyed by (field, group_key), matching the database's unique (layout_id, field, group_key): a field placed twice keeps both placements through every op and save path. After each op `sort` is renumbered per container, and the record page's top level (sections, the Ungrouped zone and slot cards) shares one order. `GET /collection-layouts/active` now also returns each placement's `col_span`, so slot cards keep their width on records."
    }
  ]
}
