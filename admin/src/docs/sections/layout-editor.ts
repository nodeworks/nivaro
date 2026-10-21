import type { DocSection } from '../types'

export const layoutEditor: DocSection = {
  id: 'layout-editor',
  label: 'Layout Editor',
  content: [
    { type: 'h1', id: 'layout-editor', text: 'Layout Editor' },
    {
      type: 'p',
      text: 'Every form in Nivaro is a layout: which fields a record shows, in which sections, tabs or steps, with which panels and rules. The layout editor is where they are built. It opens from Data Model → a collection → Layout tab, and from any record page with Edit form (admins only, in Nivaro admin and in headless frontends such as efp-new). The canvas is the real record form, so what you arrange is exactly what people get.'
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
        'The header holds Test a record, Find a field (on every form), Analyze ▾ (Check coverage, Worst first, Compare forms…), ⋯ (Every form) and New form. When people suggested changes, the line under the title says how many; click it for the forms they are about.',
        'One strip under the header gathers what needs a look across the forms: "4 things need a look" with a chip per kind — rule loops, placements that point at nothing, forms missing translations, fields labelled differently, near copies. A chip opens its rows; the heading opens them all. The last coverage check sits at the strip\'s end ("Coverage: 2 forms get no records") with Check again.',
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
    {
      type: 'p',
      text: 'Pick Phone under Screen to see which form the record opens with on a small screen, and a day under On day to test active dates on another day.'
    },
    { type: 'h3', id: 'layout-editor-active-dates', text: 'Active dates' },
    {
      type: 'p',
      text: 'Form settings → Who gets this form → Active dates limits a form to the days between From and Until (both included, in the instance time zone). Outside them the form takes no part in choosing a form: records open with the next form that fits, as if the form were restricted to other roles. A link that names the form falls through the same way. The overview shows the dates beside the form and warns when they have not started or have passed. Scheduled changes publish edits to a form; active dates decide when the form is used at all.'
    },
    { type: 'h3', id: 'layout-editor-phone-version', text: 'Phone version' },
    {
      type: 'p',
      text: 'Form settings → Who gets this form → Phone version → Make a phone version copies the form as a lighter one for small screens (remove what a phone does not need). Record pages on a screen narrower than 640 px ask for the phone version (`viewport=phone` on `/collection-layouts/active`): after the usual rules pick a form, its phone version opens in its place. A phone version never opens on its own and needs no rules of its own; its roles and active dates still apply. On the overview it sits under the form it stands in for.'
    },
    { type: 'h3', id: 'layout-editor-coverage', text: 'Check coverage and health' },
    {
      type: 'p',
      text: 'Check coverage runs the 500 newest records through the same matching the record page uses (as an administrator sees them) and says, under each form, how many of them open with it. A form nobody gets, and record rules that match none of the records, are flagged. Forms chosen by role are not counted. Check again samples afresh.'
    },
    {
      type: 'p',
      text: 'Each form carries a health score from 0 to 100. It loses points for many fields, many steps, fields nobody sees and what the Problems panel finds; it reads "Health 72" with a coloured dot, and hovering it shows what cost it points. Analyze → Worst first sorts each section by score — turn it off to read the matching order again. Analyze → Check coverage runs the coverage check; its result sits at the end of the strip under the header.'
    },

    { type: 'h2', id: 'layout-editor-editor', text: 'The editor' },
    {
      type: 'p',
      text: 'Three areas: on the left the layouts of the collection (grouped as on the overview, each with a one-line purpose) and an entry for Form settings; in the centre the canvas; on the right the inspector for whatever is selected. The top bar is one row: ‹ Forms, the form’s name and who else has it open, Undo / Redo, the view (Canvas, Table, States, Roles) and Rules, Preview ▾, Tools ▾, AI ▾, the Problems count, History, ⋯, the save status and Save ▾. Tools holds Auto-arrange, Find on this form, Find and replace, Outline, Compact / Expand all / Collapse all, Show how full each field is, Every form, Form map and Keyboard shortcuts. AI holds Rebuild or lighter version, Test as a role, Review the look, Tune from autofill, Ask…, Type a change… and Suggested changes (its count shows on AI). ⋯ holds Test, Share & watchers, Watch this form, Save as template, New form from this record and Download this form. On a narrow screen the view switch shows icons only and the Preview summary and the Rules, Tools and AI labels drop away, so the bar never wraps.'
    },
    { type: 'h3', id: 'layout-editor-canvas', text: 'Canvas' },
    {
      type: 'p',
      text: 'The canvas is the shared record form (ItemEditForm, or the read view for summary and detail layouts) running in design mode: same styles, spacing, steps or tabs, header strip and slot cards as a real record. Inputs are inert — nothing on the canvas writes to a record, takes a lock or runs a rule that saves. Click a field, section, tab, slot card, header strip item or widget to select it (from the keyboard: Tab to it, Enter). Empty sections show a drop zone; Show hidden reveals fields and sections the preview would hide, faintly, so they can still be selected.'
    },
    { type: 'h3', id: 'layout-editor-inspector', text: 'Inspector' },
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
    { type: 'h3', id: 'layout-editor-form-settings', text: 'Form settings' },
    {
      type: 'p',
      text: "Layout-wide settings in short named sections, each control with a one-line effect, searchable from the box at the top: Who gets this form (kind, record rules, roles by name, link name, New-menu label and hiding) · How it's laid out (tabs or steps, check each step before Next, one section open at a time) · Buttons & panels (hide comments, tasks, revisions, clone, delete, banners; Schedule and Hide-from-pickers buttons for everyone) · Read view & summary · PDF (file layouts only) · Addendum · Defaults for new records · Inheritance · AI review, previews, version history. Only the settings that apply to the layout's kind are shown — addendum layouts get every setting that applies to them. This page calls that last section Form settings → Tools."
    },
    {
      type: 'p',
      text: '"Schedule button for everyone" and "Hide-from-pickers button for everyone" give people who may edit the record "Schedule a change…" and "Disable in pickers" (administrators always have both). Nivaro admin shows them in the record header; the shared record form shows them in its More menu when the host turns on `showGrantedTools` (efp-new does). The server checks the same grant for both. A non-admin must be able to see the record (otherwise the answer is Not found), the form that record opens with for them must have the setting on, and they must be allowed to update this record — the update rules of their role for the collection, its row filter and any tree permission, not just access to the collection. A form opened with a `?layout=` link counts only when it is a record form their role may open and its record rules match this record; naming any other form never grants the tool. Scheduling also checks every field in the change: each must be one the person may update, and a registered field with its own column that is not read-only, computed or an audit stamp; otherwise the request is refused naming the field. People who are not administrators see the scheduled changes on a record only when they can see the record, with values of fields they may not read left out, and may cancel only their own changes on records they can still update.'
    },
    { type: 'h3', id: 'layout-editor-add-panel', text: 'Add panel' },
    {
      type: 'p',
      text: 'Add a field, section, panel or widget opens a searchable list showing labels (the key as secondary text), the type and an "on this form" mark for what is already placed. Click a row to add it after the selection, or drag it onto the canvas. A field already on the form can be added again ("Add another copy") — the same field may sit in two places, such as the header strip and a section.'
    },
    {
      type: 'p',
      text: "On other forms lists, above the fields, the fields this collection's other forms of the same kind place and this one does not, most-carried first, with how many forms carry each and their names."
    },
    { type: 'h3', id: 'layout-editor-drag', text: 'Drag and drop' },
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
        'Find on this form (⌘F / Ctrl+F in the editor, or Tools → Find on this form) finds a field, panel, step, tab or section by label or key. Picking a match opens the step or tab it sits on, unfolds its section, scrolls to it and selects it. Hidden fields and fields a rule hides are found too; picking one turns on Show hidden when the form would not show it.',
        'Outline (Tools → Outline) lists the header strip, steps, tabs, sections and their fields beside the canvas. Clicking a row selects it on the canvas, and selecting on the canvas marks its row. Drag rows to reorder: the same moves as dragging on the canvas, one Undo step each. Parts that come from a parent layout show but do not move. The outline stays open for you until you close it.',
        "The inspector's header shows where the selection sits, for example Field · Flow › Billing. Click a part to select that step, tab or section.",
        'Tools has Compact canvas (smaller spacing and inputs in the editor only, kept for you in this browser; the record page is unchanged), Expand all (every section open and every step and tab laid out one under another) and Collapse all (every section folded; steps and tabs back to one at a time).',
        'Press ? (when not typing) or the keyboard button for every shortcut, grouped by area: undo and redo, duplicate, moving with Alt+arrows or Space, find, the command palette and save.'
      ]
    },
    {
      type: 'h3',
      id: 'layout-editor-arrange',
      text: 'Arrange: duplicate, wrap, split, join, convert, pin'
    },
    {
      type: 'p',
      text: "Right-click anything on the canvas (or press the context-menu key on it), or press Arrange… in a section's inspector, to open the Arrange menu beside it. Every action in it is one Undo step."
    },
    {
      type: 'ul',
      items: [
        "Duplicate (⌘D / Ctrl+D) copies the selected section, tab, step or holder right after itself, with all its settings and every field's settings (label, width, rules). A holder brings its tabs. The copy's fields are the same fields, so they now show in both sections. A single field cannot be duplicated: a field shows once per section.",
        "Wrap puts the selected fields in a new section right after the first one's section. Fields in a tab or step get a new tab or step beside it, since a section cannot sit in a holder.",
        'Unwrap removes a section, tab or step and keeps its fields as ungrouped fields. When there are no ungrouped fields yet, they stay where the section was.',
        "Convert to… turns a section into a tab or step (it joins the holder just above it when that holder shows the same way, else a new holder takes its place), a tab or step into a section (an emptied holder goes), tabs into steps and back, or a holder's tabs into sections. Each choice lists what it would change before you press Convert. A holder shows all its tabs one way, so one tab becomes a step only with its siblings.",
        'Copy rules to other sections… copies Hidden for, Read-only for and (from a tab or step) Only when onto the sections you tick. Step conditions are skipped on plain sections, where they do nothing.',
        'Pin in the editor marks a section so it cannot be dragged and takes no drops, with its fields and tabs, while you arrange the rest. Alt+arrow skips it too. The pin only affects the editor; the form people see is unchanged.',
        'Split the section here (on a selected field) moves that field and everything after it to a new section right below, named “… (continued)”, in the same order. The first part keeps all its settings; the new part takes its look, rules and visibility, but not its intro, collapsed summary or field swap. A split cannot fall inside a row of fields side by side.',
        'Join with … (on a section, tab or step) moves the fields of the section right below into this one, after its own, and removes the emptied section. This section keeps its settings; a field both hold shows once.',
        'Put side by side under one label (with two to six fields of one section selected) puts them in one row, such as Street / City / Zip or Qty / Unit. The row shows one label and one required marker; each input is captioned with its own name. Rename or take a row apart in the section’s inspector under Side by side; take one field out from its own inspector.'
      ]
    },
    {
      type: 'h3',
      id: 'layout-editor-structure',
      text: 'Show more, sticky sections and empty text'
    },
    {
      type: 'ul',
      items: [
        'Behind “Show more” (a field’s Look tab) tucks an optional field under a “Show 4 more” button at the end of its section. The fold opens on its own as soon as one of its fields has a value, so nothing filled is ever hidden. Required fields and fields in a row always show. The read view and the PDF leave out an empty folded field.',
        'Stick to the top (a section’s inspector) keeps that section, such as totals or status, at the top of the form while people scroll the rest. A form has one sticky section: turning it on for one turns it off for the other. It does not stick on phone widths, nor on the canvas, where it is tagged “Sticks to the top”.',
        'When nothing is filled (a section’s inspector) is the text the read view and the PDF show for a section none of whose fields has a value, such as “No shipping details yet”, instead of a list of dashes.',
        'Rows of fields side by side print the same way everywhere: one label on the record page, and on the read view and the PDF their values on one line, joined by a dot.',
        'Select a field to get a width handle on its right edge: drag it to make the field full, half, a third or a quarter wide (or focus it and press ← →). While you drag a field or a width, faint guides show the form’s 12 columns, so widths line up across sections.'
      ]
    },
    { type: 'h3', id: 'layout-editor-find-replace', text: 'Find and replace in labels' },
    {
      type: 'p',
      text: "Find and replace (Tools) searches this form's field labels, section names, text blocks and help text, for example Oracle to Fusion. Where the form sets no label or help text of its own, the collection's is searched too; replacing it gives this form its own. Every match is listed with its before and after and a tick box; Replace changes the ticked ones as one Undo step."
    },
    { type: 'h3', id: 'layout-editor-inherited', text: 'Inherited layouts' },
    {
      type: 'p',
      text: 'A layout that inherits from a parent shows the parent\'s placements on its canvas marked "from <parent>" and locked (an inherited step or tab gets a small dot instead, with the parent\'s name in its tip). The inspector offers Override here (copies the placement into this layout as the parent last saved it, then editable) and Edit in <parent>.'
    },
    {
      type: 'p',
      text: "What this layout changes of the parent's is tagged \"Overrides parent\". Select it and the inspector offers Reset to parent: this layout's copy goes and the parent's shows again, as one Undo step. Resetting a section also resets the fields in it that the parent places; fields only this layout places move to Ungrouped. The States and Roles views mark rows the same way, with Reset or Override beside the name."
    },
    { type: 'h3', id: 'layout-editor-translations', text: 'Translations' },
    {
      type: 'p',
      text: "When Settings → Localization lists more than one language, the first is the one the form is written in and the others get a Translations section: a field's label and help text (Look tab) and a section's, tab's or step's name (its inspector). Translations save with the layout and version with it. The record form shows them to people reading in that language — their chosen admin language, else the page's, else the browser's — and the text as written where a translation is missing. A suggested translation (for example one drafted by AI) shows marked as a suggestion and stays off records until Approve; the overview counts it as missing until then. The overview counts the missing translations per form. Section names need migration 465; field labels and help text work without it. Record values are translated separately (field translations)."
    },
    { type: 'h3', id: 'layout-editor-other-kinds', text: 'Table and PDF layouts' },
    {
      type: 'ul',
      items: [
        'Table layouts (the columns a collection shows when it is a grid inside another record) edit on a columns strip that looks like the real grid header: column order and width, plus the Apply values and Create with defaults zones.',
        'File (PDF) layouts edit their sections in form style, labelled as the PDF prints them; Preview with sample values waits for the last change to save (unsaved changes are not in it — Save first), then renders the real PDF in a new tab. Theme, cover, logo, page size, orientation and button label live in Form settings → PDF, which has its own Preview PDF.',
        'Summary and detail layouts edit on the read view they render as, with the same selection and drag handles.'
      ]
    },
    { type: 'h3', id: 'layout-editor-record-page', text: 'Edit form from a record' },
    {
      type: 'p',
      text: "On a record page an admin finds Edit form in the record's More menu (Nivaro admin ItemEdit and efp-new RecordDetail). It switches that page's form into design mode on the layout this record resolved to, with the layouts list, inspector and add panel as side panels over the page. The editor keeps the layout it opened on even if a save changes which layout the record resolves to. Back to record closes it at once; the record re-reads its layout as soon as the last change has saved, so it never shows the form from before your last edit. When the collection has no layout yet, the same menu row reads Create the first form and opens the Layout tab. When the page's ?layout= link names a form that doesn't exist, it reads Form not found and opens the collection's forms instead."
    },
    {
      type: 'p',
      text: 'Edits are the same operations, saving and History as in the Layout tab. People who are not administrators never see the menu row and never download the editor: it is a separate chunk, loaded only when an admin turns the mode on (efp-new loads it through the `@nivaro/react/layout-editor` subpath export).'
    },

    { type: 'h2', id: 'layout-editor-saving-history', text: 'Saving and history' },
    { type: 'h3', id: 'layout-editor-saving', text: 'Saving, undo and conflicts' },
    {
      type: 'p',
      text: 'Changes wait for Save. The form shows each change at once, but nobody else sees it until you press Save (or ⌘S / Ctrl+S); the top bar counts them ("3 unsaved changes") and Save turns blue while there is something to save. The arrow beside Save opens the Save menu: Review changes on canvas, What changes, AI review, Schedule… and Autosave. One Save sends every change together, and History names them.'
    },
    {
      type: 'p',
      text: 'Autosave (Save ▾ → Autosave) saves every change as you make it instead; the status chip reads Saving… then Saved. It is off each time the editor opens and stays as you set it until you close the editor. Turning it on saves anything unsaved straight away; the bar then shows only the save status, with the arrow beside it to turn Autosave off.'
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
      text: 'Changes go to the server as small operations against the revision the editor last saw. If another admin (or you in another tab) saved in between, your changes are replayed on top of theirs instead of thrown away: with Save they stay unsaved for you to Save again; with Autosave they are sent again at once. A change that no longer fits (they removed what it changed) is dropped and listed in a banner above the form for you to redo by hand; the rest are kept. Undo keeps every change that was kept, and a saved setting change as long as nobody changed that setting since. Nothing is silently overwritten. A refused Save keeps your changes and says why. Restoring a version from History drops unsaved changes.'
    },
    {
      type: 'p',
      text: 'Every field or section an unsaved change touched shows a small blue dot until you save. Click the unsaved count in the top bar to list the changes; click one to select what it changed and scroll to it (a form-settings change opens Form settings).'
    },
    {
      type: 'p',
      text: 'Unsaved changes are also kept in this browser. If the tab crashed or was closed, opening the layout again offers Recover, which brings them back as unsaved changes. If the layout was saved by anyone since, they cannot be laid on it safely: the editor says so and drops them.'
    },
    { type: 'h3', id: 'layout-editor-presence', text: 'Who else is here' },
    {
      type: 'p',
      text: "The other admins who have the same layout open show as avatars beside the layout's name. What each has selected gets an outline in their colour with their first name; click an avatar to jump to it. Only names and what is selected are shared, never unsaved changes."
    },
    { type: 'h3', id: 'layout-editor-change-note', text: 'Ask why on every save' },
    {
      type: 'p',
      text: "Form settings → Tools → Ask why on every save makes Save ask for a short reason, or a reason and a ticket link. The reason and ticket lead the version's note in History. Autosave stays off for that layout, and the server refuses a save without them (turning the setting off needs a reason too)."
    },
    { type: 'h3', id: 'layout-editor-freeze', text: 'Freeze edits' },
    {
      type: 'p',
      text: 'Form settings → Tools → Freeze edits stops changes to a layout until a date (a go-live or an audit), with a reason people read. Until that day the server refuses every save, restore, settings change and delete of the layout with the reason (400 `LAYOUT_FROZEN`). An administrator can still save by giving an override note: the editor asks for it at Save, the note becomes the version note in History and an activity entry (`layout-freeze-override`). Lifting the freeze early is a save too, so it asks for a note. The freeze lifts by itself on its date; copies of a frozen layout are not frozen.'
    },
    { type: 'h3', id: 'layout-editor-sections-on-open', text: 'Sections that load when opened' },
    {
      type: 'p',
      text: 'Select a section that starts collapsed and turn on Load when opened. Until someone opens it, the record page does not read what only that section holds: its grids\' rows, its relation-path values and its widgets. Fields the folded section shows in its summary still load. Test → Cost counts these requests apart ("more once someone opens…"). It changes when data loads on live records, so it is off unless you turn it on for a section.'
    },
    { type: 'h3', id: 'layout-editor-history', text: 'History' },
    {
      type: 'p',
      text: 'History lists the saved versions of the layout — one per editing burst, sections included — with who saved and the change\'s name. "What the last save changed" shows the newest difference first; any version can be compared with the layout now. Restore replaces the layout with that version exactly (sections added since are removed) after keeping the current one as a version first. Versions survive a layout delete.'
    },
    {
      type: 'p',
      text: 'This session (at the top of History) lists every Undo step since you opened the layout, oldest first, each marked saved or unsaved, and what Redo would bring back. Click a step to go back (or forward) to the layout right after it: that is the same as pressing Undo or Redo that many times, so it saves, or waits for Save, the same way.'
    },
    {
      type: 'p',
      text: 'Name a version to keep it: older unnamed versions are pruned (the newest 30 are kept), named ones never are. "Name the saved form…" keeps the form as it is saved now ("Go-live baseline"); Name / Rename on a version names that one, and clearing the name lets it be pruned again. Compare any later state against a named version like any other.'
    },
    {
      type: 'p',
      text: 'Show on canvas (from the comparison, or Canvas on a version) marks the difference on the form itself: added fields and sections are outlined green, moved ones amber with the section they came from, changed ones violet with the settings that differ, and removed ones come back faintly in their old place, tagged Removed (they cannot be selected or dragged). With unsaved changes, Save ▾ → Review changes on canvas does the same for what you are about to save. Close the comparison from the bar above the canvas.'
    },
    {
      type: 'p',
      text: 'Explain in words, under a comparison, says what the differences mean for the people filling the form, using the History notes of the saves in between (administrators, with AI set up). The exact differences and the notes stay one click away, and without AI they are what you get. Compare two forms and Merge two forms use the same explanation for two different layouts.'
    },
    {
      type: 'p',
      text: 'The selected section, or the one under the pointer, shows on its frame who last changed it and when. It is worked out from the versions the layout keeps, so a change older than the kept versions is not named.'
    },
    { type: 'h3', id: 'layout-editor-schedule', text: 'Scheduled changes' },
    {
      type: 'p',
      text: 'With unsaved changes, Save ▾ → Schedule… applies them at a time you pick instead of now (for example the morning of a release). They leave the editor at once and nobody sees them until then. At that time the server applies them like a Save, as a version named "Scheduled change by <you>". If someone changed the layout meanwhile, your changes still apply when every one of them fits; if one no longer fits, nothing is applied and you get a notification saying why.'
    },
    {
      type: 'p',
      text: "The overview shows each form's scheduled changes (when, who, how many) under its name; any administrator can cancel one. A change that could not be applied stays there with the reason until dismissed (or for a week)."
    },

    { type: 'h2', id: 'layout-editor-preview', text: 'Preview and test' },
    { type: 'h3', id: 'layout-editor-preview-as', text: 'Preview as' },
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
    {
      type: 'h3',
      id: 'layout-editor-testing',
      text: 'Test records, new-record walkthrough, form cost'
    },
    {
      type: 'p',
      text: "⋯ → Test in the top bar has three tabs. Test records: pin up to 5 records that cover the form's important cases, each as a role or as an administrator. They are stored with the layout (versioned with it, never sent to non-admins). Re-check runs the live resolver, the same one as Test a record, for each one against your draft and shows which form it gets, how many fields it sees and what changed: against the last save while changes wait for Save, otherwise against your previous check."
    },
    {
      type: 'p',
      text: 'New record acts out creating a record on this form as a role, step by step, and stops where the form would stop them: at Next when the form validates each step, otherwise at Save. A required field blocks when the role may not write it, it is locked or read-only, or its step or section is hidden for the values you pick under "Values they enter". Required fields the form never shows are listed under "Saves without". Nothing is written.'
    },
    {
      type: 'p',
      text: "Cost estimates how many requests a record page fires when it opens on this form: one per picker, three per inline grid, one per widget, panel, relation-path or remote-options field, plus the page's own reads. It warns above the Form cost limit (Form settings → Tools; default 40). It complements form-ready timing, which is measured after release."
    },
    {
      type: 'p',
      text: 'What changes (Save ▾ → What changes, while changes wait) runs the same check before you save and lists what changes for the pinned records ("Record 284212 loses the Zone field", "lands on another form") and the form cost against its limit. It only reads.'
    },

    { type: 'h2', id: 'layout-editor-rules', text: 'Rules and checks' },
    { type: 'h3', id: 'layout-editor-rules-view', text: 'Rules on the canvas' },
    {
      type: 'p',
      text: "The Rules switch in the top bar (the branch icon; on by default, remembered per browser) puts small tags on the canvas that say why each field behaves as it does: Required here or Required field (this form or every form), Needed to Approve (a pipeline move requires it), Read-only here, Read-only field, Calculated, Locked for Finance, Locked in Approved, Hidden here, Hidden field, and Filled by a rule. Hover a tag for the whole sentence; click it to open what causes it: the field's Rules, Look or Advanced tab, the section, the pipeline or the field rules page."
    },
    {
      type: 'p',
      text: 'Sections carry their rules as sentences too, worded as on the overview: "Shows when Is Sparing is Yes", "Skipped when Project is filled", "Hidden for Finance", "Read-only for Finance".'
    },
    {
      type: 'p',
      text: 'Hover a field whose value decides something else: every section it shows or hides, picker it filters, field a rule fills and grid whose lines or row rules read it gets a dashed amber ring, and the field a "Controls n" tag.'
    },
    {
      type: 'p',
      text: 'Without a preview record, each input shows in grey the value a new record on this form starts with: "Default: Open" from the form\'s defaults, "By rule: …" when a field rule fills it from those defaults, "From Project: …" when a cross-record default copies it from a record a default picks. Yes/no and multi-pick fields show it as a tag. Nothing is saved; preview a record to see its real values instead.'
    },
    {
      type: 'p',
      text: 'Rule loops are flagged in a banner above the canvas and on the overview: a section that shows only by a field placed inside that same section (once hidden, nobody can change the field back), or fields whose rules, cascades and section rules decide each other in a circle. The fields involved get a Rule loop tag; Show selects the first one. A loop of field rules alone is the same on every form, so the overview says it once above the list.'
    },
    { type: 'h3', id: 'layout-editor-state-matrix', text: 'Fields by state' },
    {
      type: 'p',
      text: "States in the top bar shows every field against the states of the collection's pipeline (a switcher picks one when several run on it), with an Every state column first. Click a cell to set the field to Editable, Read-only, Required or Hidden. Every state writes the field's own Read-only, Required and Hidden on this form. Read-only in one state adds that state to the field's Read-only when. Required in one state makes the moves that leave the state ask for the value (a record-fields requirement on those moves); that is saved to the pipeline at once, for every form, and its toast has Undo. A field cannot be hidden in one state only, and a state nothing leaves cannot require anything: those choices stay greyed with the reason. A dot on a cell marks a field that is read-only but required, which nobody could fill in."
    },
    { type: 'h3', id: 'layout-editor-role-matrix', text: 'Sections by role' },
    {
      type: 'p',
      text: "Roles in the top bar shows every section and tab against every role. Click a cell to make the section Can edit, Read-only or Hidden for that role (the section's Hidden for and Read-only for). Each cell is one change to save. Administrator roles are greyed: they always see and edit everything. Field permissions still apply inside a section."
    },
    { type: 'h3', id: 'layout-editor-problems', text: 'Problems' },
    {
      type: 'p',
      text: 'The Problems count in the top bar (the alert icon and a number) counts the errors and warnings on the form as you edit it; it opens the Problems panel listing them, worst first (Errors, Warnings, Tips). Click one to select it on the canvas. Many come with a fix that is one undo step.'
    },
    {
      type: 'ul',
      items: [
        'A required field the form hides, or one in a section hidden or locked for a role that can edit the record — or that must fill it to make a transition.',
        'A picker that narrows its choices by a field that is not on the form.',
        'Empty sections, steps and tabs holders.',
        'Steps and sections no record reaches (their show-when rules can never hold, or contradict the record rules of the form, or every role but administrators is hidden from them), and fields that sit only there or are hidden everywhere they are placed.',
        'Accessibility: fields without a label, a required field whose label (and so its required mark) is hidden, a half-width field that sits after a wider one although it would fit beside the field above it, and a chosen colour that reads below 3:1 on the light or dark background.'
      ]
    },
    {
      type: 'p',
      text: 'These checks are counted, never guessed. The AI review in Form settings → Tools also reads labels and help text.'
    },
    { type: 'h3', id: 'layout-editor-db-checks', text: 'Checks against the database' },
    {
      type: 'ul',
      items: [
        "Stored as (Look tab): the database type and size behind the field, for example nvarchar(50). A warning shows when this form's default value, the input mask or the label cannot fit: a default longer than the column or past its digits, a mask that stores more characters than the column holds, or a label longer than the field's width shows.",
        'Check the width against stored values (Look tab, single-line fields): reads the newest 5,000 stored values, never the whole table, and says how long 95% of them are and how much the current width shows. When the width cuts them off, or is far wider than needed, Use ⅓ (or the width it names) sets it in one Undo step.',
        "Options for a record (Picker tab): pick a saved record and see the options this picker would offer it — the cascade filters and option filter worked out as the record form works them out (the draft you are editing included), then the picker exclusions — with the count left after each step and the first 50 options. When the target collection has a picker filter, the count it would leave is shown too: the record form's picker does not apply it; enforced API writes do.",
        "Placements that point at nothing (overview): placements whose column was dropped, whose widget was deleted, whose grid's table or link column is gone (relations are a claim: the table and column must exist) or whose section no longer exists. Remove it / Remove N takes them off that layout in one save, with a version kept like any other edit."
      ]
    },

    { type: 'h2', id: 'layout-editor-ai', text: 'Commands and AI' },
    { type: 'h3', id: 'layout-editor-commands', text: 'Type a change (⌘K)' },
    {
      type: 'p',
      text: 'AI → Type a change… (⌘K or Ctrl+K) takes a change in plain words. Enter shows every change it will make, in sentences; nothing changes until Apply, and one Apply is one undo step that waits for Save like any other change. Names match by label or key, in any case, with partial words and small typos; a name that fits two things asks you to be more specific.'
    },
    {
      type: 'ul',
      items: [
        'move Shipping Location to Materials · move Notes after Zone · move section Details after Extras · move Notes to ungrouped',
        'make Zone required · make Notes optional · make Zone read-only / editable · hide Notes · show Notes',
        'rename Notes to "Comments" · rename section Details to Basics',
        'set width Zone 6 · set Zone width to half · make Zone a third',
        'add Region to Location (a field not on the form yet) · add step Review after Details · add section Extras',
        'remove Notes (the data is kept) · collapse Extras · expand Extras',
        'Several commands in one go: separate them with ";" — they apply as one change.'
      ]
    },
    {
      type: 'p',
      text: 'Required is set per form, not per role: "make Zone required for Finance" makes it required on this form and says so when the form is not limited to Finance (give Finance its own form to require it only there). Text the palette cannot read can go to the AI (admins, when AI is set up): it answers in the same commands, shown in the same preview before anything changes. Without AI the typed commands still work.'
    },
    { type: 'h3', id: 'layout-editor-ai-assists', text: 'AI assists (admins)' },
    {
      type: 'p',
      text: 'When AI is set up, administrators get five helpers. Each one only proposes: a change lands through the draft as one undo step, and nothing is applied without Apply. The AI reads field names, labels, help text, roles and the workflow — never record values.'
    },
    {
      type: 'ul',
      items: [
        'AI review (Save ▾ → AI review): after a Save the AI reads what changed next to the roles and the workflow and warns about likely mistakes, such as hiding Amount from Finance, who must fill it before Approve. It never blocks or delays the save; warnings open beside the Save menu (their count shows on its arrow) and Undo reverses a saved change. Picking AI review asks before saving. A change that only renames, rewrites help text or reorders inside a section is not sent.',
        'Help text that contradicts the form (Form settings → Tools → Review this layout): help text that says "optional" while a workflow move needs the field, or names a role that cannot edit it, is flagged with a rewrite. Use the rewrite changes only the help text on this form.',
        'Fields that mean the same thing (same review): two fields with different labels that hold the same information, such as Vendor and Supplier. Identical labels are a separate finding.',
        'Natural entry order: an order inside each section that follows how people fill the form in (who, what, when, cost), with fields that filter or show other fields first. Apply one section or Apply all — one undo step either way.',
        "Personal and financial fields: fields that look personal or financial and are seen on this form by a broad role (one holding a fifth of active people, or roles that together hold half). The suggestion hides the field's section from those roles, leaving out roles that edit the field or need it for a workflow move, and says which other fields go with it. This is advice, not a security control: the API still returns a field to every role whose permissions read it."
      ]
    },
    { type: 'h3', id: 'layout-editor-ai-tools', text: 'AI tools' },
    {
      type: 'p',
      text: 'The AI menu in the top bar (administrators) holds three reviews: Test as a role, Review the look and Tune from autofill. None of them changes the form by itself: every fix is shown in sentences first, and one Apply is one undo step that waits for Save like any other change. Findings appear as tags on the canvas; click one in the list to select that field or section, and Clear marks removes the tags.'
    },
    {
      type: 'ul',
      items: [
        "Test as a role: pick a role (and, if you like, what that person is trying to do). The AI plays someone in that role filling in a new record, step by step, and says where they would hesitate — a confusing step, label or field — with a suggestion; a clearer label can be applied with one click. Built-in checks run even without AI: a required field the role cannot see or change (the record could not be saved), a step with nothing for them to fill in, a label that reads like a database name, two fields with the same label. Only labels, help text, choices and the form's structure are sent, never stored data. Nothing is saved.",
        "Review the look: the AI reviews how the form looks — density, the order and nesting of sections, alignment of widths — and pins each comment to its section. It gets a picture of the canvas (typed values hidden) when the AI provider can read pictures; with a preview record on the canvas, or with a provider that cannot read pictures, it gets the sections' structure and measured sizes instead, and says so. Built-in checks flag long full-width stacks, ragged rows and one-field sections.",
        'Tune from autofill: for collections that use "Fill from document", the fields people most often change after the AI proposed a value (last 90 days, counts only). Fields changed in at least a quarter of their proposals start ticked. "Highlight after autofill" rings those fields with a Check this tag only when the form was filled from a document; "Add Check these section" moves them into a section at the top of the form (on a steps or tabs form, a first step).'
      ]
    },
    {
      type: 'p',
      text: "AI fill per field: in the inspector's Look tab, a text field can get its own AI fill button with a prompt. Write {{field_name}} in the prompt (or pick from Insert a field) to use another field's current value; nothing else from the record is sent. A field's own setting wins over the form-wide \"AI generate buttons\" switch (turned off, it hides the button on that field). Anyone who may change the field on that record can use the button — not only administrators — and fields they cannot read stay empty in the prompt. The value goes into the form like typing; it is saved with the record."
    },
    { type: 'h3', id: 'layout-editor-ai-rules', text: 'Write rules with AI' },
    {
      type: 'p',
      text: "Admins with AI set up can describe a rule in words beside the setting it changes. The AI answers in the form's own rule format; names it cannot match are left out and listed. It sees field names, labels, choices and the layout — never stored values."
    },
    {
      type: 'ul',
      items: [
        'A step\'s "Only when" and a field\'s "Read-only when" → Write with AI. "Hide this step when Is Sparing is yes or Warehouse is 3" becomes conditions the step checks. Before Apply you see how many of the newest 500 records it shows on (or locks on), next to today\'s count. Apply is one undo step and saves with the form.',
        "Steps can show and hide by a field's value; single fields cannot. A field locks by pipeline state or by role, not by another field's value. The AI says so instead of guessing.",
        'Picker tab → Narrow the options → Write with AI: "only regions of the record\'s zone" becomes a cascade filter or an option filter. Pick a record to see its options today and with the change, side by side. Use this adds it to the field\'s every-form change, which you confirm.',
        'Rules tab → Default for new records → Write a rule with AI: "Default Zone from the project\'s zone" becomes a field rule, tried on five records (now, after the rule, and what a new record gets). It is saved only when you confirm, and then runs on every form and API write.',
        'Rules tab → Checks → Suggest checks: patterns, ranges and lengths learned from the values stored today, each with how many existing values it would refuse. Nothing is applied until you pick a check and confirm the every-form change. Without AI the pattern-based checks still appear.'
      ]
    },
    { type: 'h3', id: 'layout-editor-ai-wording', text: 'AI wording' },
    {
      type: 'p',
      text: 'Form settings → Tools → AI wording (administrators) checks the words on the form. Each tool lists its changes as sentences with a checkbox; Apply sends the ticked ones through the editor as one undo step, and nothing is saved until Save. A change whose text was edited since you asked is greyed out — run the tool again.'
    },
    {
      type: 'ul',
      items: [
        "Glossary terms — every label, help text and section name that uses another word for a term in the AI knowledge glossary (CAR for PUB'd), listed with where it shows, and rewritten to the term on this form.",
        "Section intros — a one- or two-sentence note at the top of each step or section saying what to fill in and why. It is the section's Intro in the inspector, shown as a note or a warning.",
        'Placeholders — example text for empty inputs from the shape of stored values (PO-######, typical amounts). Values never reach the AI, and an example that equals or contains a stored value is refused.',
        "Choice labels — readable labels for coded choices such as $t:pending_approval or IN_PROGRESS. Per row, put them on this form only or on the field, which changes every form that uses the field's own list straight away (that one is not part of Undo).",
        'Plain language — a plain-language score from 0 to 100 for every label, help text and intro, worst first, with a simpler rewrite that must score higher. Glossary terms do not count as unexplained abbreviations.',
        'Translations — label and help drafts for a language set under Settings → Localization. Drafts are marked as drafts until someone approves them (Approve or Approve all); approved translations are never redrafted.'
      ]
    },
    {
      type: 'p',
      text: 'Without AI, Glossary terms, Placeholders, Choice labels and Plain language still work from rules; Section intros and Translations need AI.'
    },
    { type: 'h3', id: 'layout-editor-ai-forms', text: 'Build a form with AI' },
    {
      type: 'p',
      text: 'Admins, when AI is set up. New form → Start with AI makes a new form; AI → Rebuild or lighter version in the editor rebuilds the open one (the same AI menu holds the reviews above). Every proposal is listed in plain sentences first. Nothing is written until Apply (or Create form), it lands as one undo step, and it still waits for Save.'
    },
    {
      type: 'ul',
      items: [
        'Describe it: "a returns form with a manager approval step". The steps or sections are built from the fields this collection already has. Any name the AI makes up is left out and listed.',
        'From a picture or PDF: a screenshot, scan, PDF or spreadsheet of an old form (up to 10 MB). Its labels are matched to fields, and its order and grouping are kept. Labels with no field are listed as candidate new fields. They are never created for you.',
        'From a process document: one step per stage, with the passage each step came from. You also get suggested read-only fields per pipeline state (ticked) and required fields (unticked: Required counts for every state).',
        'Lighter version for a role: pick a role. You see the fields its people changed in the last 180 days, and the fields it would hide. Create lighter version makes a new form that inherits from this one, is shown only to that role, and hides the unused fields.',
        'Sections by meaning: at the top of the Add panel (and under AI). Each field not on the form gets a suggested section, based on what the field means. This helps on a new collection that has no usage history yet.'
      ]
    },
    {
      type: 'note',
      text: 'The AI gets field names, labels, descriptions and the form layout. It never gets record values. An uploaded file is read once and never stored. The lighter version reads only which fields were changed, never the values. If the AI rebuild leaves a step or section still holding fields, it is kept and named.'
    },
    { type: 'h3', id: 'layout-editor-ask', text: 'Ask about this form' },
    {
      type: 'p',
      text: 'AI → Ask… opens a panel on the right for questions such as "Why can\'t Finance see Zone on record 284212?" or "Which form does record 284212 get?". The AI answers with the same engines the editor shows: which form a record gets for a role (Test a record), the role\'s field permissions, where the field sits, the section rules (hidden or read-only for roles, shows when) and the checks. It reads your unsaved draft, changes nothing, and never sees record values: a section rule comes back as matched or not. Each answer lists the fields, records and forms it looked at; click one to select the field, preview the record or open the form. Administrators only; it needs AI to be set up.'
    },
    { type: 'h3', id: 'layout-editor-find-setting', text: 'Find a setting by asking' },
    {
      type: 'p',
      text: 'Ask "Where do I turn off comments?" in the Ask panel and it lists the matching controls, each with where it lives (Form settings section or inspector tab) and a Show me button. Show me opens that panel, selects a field or section the control applies to when it is an inspector control, switches to its tab and highlights the control. The words of the question are matched first; only when they do not place it does the AI pick from the same list. Without AI the closest word matches are shown. In Form settings, a search typed as a question, or one nothing matches, offers Look everywhere, which asks the same way.'
    },
    { type: 'h3', id: 'layout-editor-proposals', text: 'Suggested changes from assistants' },
    {
      type: 'p',
      text: 'A connected assistant (Claude or ChatGPT over the MCP connector, or Claude Code) can propose changes to a form with the propose_layout_ops tool. A suggested change never changes the form: AI → Suggested changes (the count shows on AI) lists them, who sent each one and through which app, the note, and every change in plain words. Try on canvas applies it to your draft as one undo step (nothing is saved until Save, unless Autosave is on); Keep marks it applied, Take back undoes it, and Reject closes it. A suggested change that no longer fits the form says why and cannot be tried.'
    },

    { type: 'h2', id: 'layout-editor-across-forms', text: 'Across forms' },
    {
      type: 'p',
      text: 'The overview looks across all the forms of a collection as well as at each one. Each form carries a small sketch: its sections as blocks, its fields as bars as wide as they are on the form, steps and tabs as a strip, page cards (pipeline, comments) as thin bars. The sketch is drawn from the saved layout and changes the next time the overview loads after a save.'
    },
    {
      type: 'ul',
      items: [
        'Fields labelled differently: a field that reads "Vendor" on one form and "Supplier" on another is listed with every label and the forms that use it. Pick the label to keep and every form gets it at once (one change per form, each in that form\'s History). The field\'s own label clears the label set on each form. A label hidden on purpose is left alone.',
        'Near copies: two forms of the same kind that are 90% or more the same (the same fields in the same sections with the same width, label and visibility) are listed with what differs. Compare side by side opens both; Make … the parent links the copy to the other form so fields added there later appear on it too. The copy keeps every field it has: remove the ones it repeats unchanged in its editor to let changes flow through.',
        'Analyze → Compare forms… puts two forms side by side, read only, each drawn as people see it. "Only here" marks fields and sections the other form lacks and "Differs" marks fields set up differently (its tip says how: section, width, label, visibility, other settings). Click a field to select it on both. List the differences gives the same as a table. Pick either side from its menu, or Swap.',
        'Find a field (on every form) searches every collection by field name or label and lists each form, summary, detail, PDF or grid that places the field, with its section and width there and its label when the form changes it, including forms that inherit it from a parent. Click one to open it in the editor.'
      ]
    },
    { type: 'h3', id: 'layout-editor-every-form', text: 'Every form at once' },
    {
      type: 'p',
      text: 'Every form (Tools → Every form in the editor, ⋯ → Every form on the overview) changes all layouts of the collection in one go. Each run shows a preview first: per form, what will change, what is already like that, and which forms are skipped and why. Untick a form to leave it out. A form with unsaved changes in the editor is left out until you save or discard them.'
    },
    {
      type: 'ul',
      items: [
        'Retire a field: takes it off every form — its placements, the header, section summaries, the quick picker, its form default, row order and PDF cover title. The preview counts the records that still hold a value; the values stay in the database. Rules that still read the field are named, not changed.',
        'One change: place a field after or before another (forms without that field are skipped and listed), set its width, make it required, read-only or hidden (or the reverse), or remove it.',
        'Macros: in the editor, Every form → Macros → Record writes down every change you make until Stop; name it and keep it. Replay previews it on the collection\'s forms: fields are matched by name and sections by label, a position becomes "after this field", and a step that does not fit a form is skipped and listed. Your macros are your own.'
      ]
    },
    {
      type: 'p',
      text: 'Each changed form saves its own version first (its History shows "Before <the change>"), so any one form can be put back from History. Right after a run, Undo this bulk change puts every changed form back at once — except a form someone changed since, which you restore from its History.'
    },

    { type: 'h2', id: 'layout-editor-reuse', text: 'Reusing forms and sections' },
    {
      type: 'ul',
      items: [
        'Copy a section to another layout: drag a section from the canvas onto a form in the Forms list, or select it and use Copy to layout… in the inspector (which also reaches other collections). It lands at the end of that layout with its tabs, fields and settings. Fields already on that form stay where they are.',
        'Section library: select a section and use Save to library…. Saved sections show under Add → Section library on every collection; a click adds one after the selection as one undo step. Remove one with the × beside it — forms keep their copies.',
        'Layout templates: ⋯ → Save as template… in the editor saves the whole form (sections, panels, header, how it behaves). New form → Start with → Template makes a new form from one. Rules for who gets a form, defaults and links to other layouts stay behind.',
        "Another collection: fields with no field of the same name get their closest match (by name or label), which you can change or set to Leave out. Step conditions, skip-if-filled, field swaps, lock conditions and grid bindings are written in the other collection's terms and are left out.",
        'New form → Start with → Field list: paste names (one per line or separated by commas) or upload a CSV or text file. Names are matched to fields by name or label, with close spellings marked "?"; names with no match are left out. The form gets one section with the matched fields in that order.',
        "New form from this record: Test a record on the overview, or the editor's ⋯ while previewing a record (also from a record's Edit form), makes a form with one section holding the fields that record has filled in, in field order. New form → Start with → A record does the same."
      ]
    },

    { type: 'h2', id: 'layout-editor-usage', text: 'Usage: how a form is used' },
    {
      type: 'p',
      text: 'Turn on Show how full each field is (the Usage tab, or Tools) and each field on the canvas shows how often it is filled across the collection\'s records ("62% filled"; under 10% its tip says it is rarely filled). It is off until you turn it on, and remembered per browser. The Add panel shows the same figure under each field ("filled on 3%"). The numbers are the Table Editor\'s Field usage figures and refresh every five minutes.'
    },
    {
      type: 'p',
      text: 'The record form records one small event each time someone closes it: which form, which record, how long they spent on each step, whether they saved, and, for a new record, the step they left it on without creating it. Design mode records nothing.'
    },
    {
      type: 'ul',
      items: [
        'Edit form on a record page adds how many people used this form on how many records today (UTC day) to its banner.',
        "The editor's Usage tab shows today's opens, people and records; the last 30 days' opens, saves and new records left unfinished; the average time on each step with how many new records were left on it; and the fields changed most often within 24 hours of a record being created (last 90 days; on records opened with this form once 20 of them are known, otherwise across the collection).",
        'Suggested sections: fields people change in the same save (Jaccard over the last 90 days of revisions) that sit in different sections. Move into (the section) moves the strays next to the others in one step, which Undo reverses. Not now hides a suggestion until the editor reopens.'
      ]
    },
    {
      type: 'note',
      text: 'Usage is kept per form per day (nivaro_layout_usage_daily, nivaro_layout_usage_seen) and deleted after 180 days by the nightly layout-usage-prune job. Only counts are stored; people and records are counted, never listed.'
    },

    { type: 'h2', id: 'layout-editor-ops', text: 'Suggestions, dependencies and environments' },
    { type: 'h3', id: 'layout-editor-suggestions', text: 'Suggested changes from people' },
    {
      type: 'p',
      text: "People who are not administrators get Suggest a form change in a record's More menu. They say what should change and can name a field. The suggestion becomes a Form change support request, so they follow it under My requests and it also shows on the Support desk. The overview's subtitle shows how many suggested changes are open and, on a click, for which forms. In the editor, Form settings → Tools → Suggested changes · from people lists them; Accept marks the request done and Decline cancels it, each with an optional note the person is told about. To turn suggestions off, deactivate the Form change type under Support → Request types. One person can send 10 suggestions an hour."
    },
    { type: 'h3', id: 'layout-editor-dependencies', text: 'What relies on a layout' },
    {
      type: 'p',
      text: 'A diagram shows everything that opens a layout: other layouts, queues, grids and drill-downs, share links and public forms, generated files and extension code. Each box says whether it finds the layout by its id or its link name. Before you delete a layout, change its link name or change its kind, the diagram turns red for what that change would break. Renaming keeps every link working. Open it from the row menu (What relies on this…) or Form settings → Tools.'
    },
    {
      type: 'p',
      text: 'Extension code cannot be read for layout names, so extensions declare what they open with `ctx.layouts?.dependsOn({ collection, slug | layout_id, label })` in register(). The diagram says so when no extension declares anything, rather than claiming nothing uses the layout.'
    },
    { type: 'h3', id: 'layout-editor-promote', text: 'Compare with another environment' },
    {
      type: 'p',
      text: "Row menu → Compare with another environment (or Form settings → Tools) reads another environment's copy of this layout and lists what would change here: settings, sections and tabs, fields and order. The other copy comes from an API in the Environments registry (read by this server with that component's token), or from an uploaded file: Download this layout on the other side, or a Config Diff snapshot. The copy is matched by link name, then by name, and you can pick another. Apply here saves a version of this layout first, so History → Restore undoes it. Which layout is the default and its place in the list stay as they are here. Settings that cannot be carried (a template or layout this environment does not have, a name already taken, a value this instance refuses) are listed and left alone. Nothing is ever sent from here to the other environment."
    },

    { type: 'h2', id: 'layout-editor-help', text: 'Help, notes and the form map' },
    {
      type: 'ul',
      items: [
        "Help videos on a field or section: a field's Help tab, or the bottom of a section's inspector, attaches a published help video. The record page then shows a small play button beside that field's label or on that section's header, to the roles the video is visible to. The attachment belongs to the video (it appears in its Where list), so it shows for that field or section on every form of the collection.",
        'Notes for editors: pin a short note to a field (Help tab) or a section (bottom of its inspector), such as "Finance asked for this in Q3". A sticky-note marker shows on the canvas with the note, its author and date. Notes save, undo and version like any other layout change, and record pages never receive them.',
        "Form map (Tools → Form map): a clean printable map of the form: its steps or tabs, sections and fields in order, each field's width, required and read-only marks, and the rules that hide or lock things, in plain words. Print / Save as PDF prints it on a light page whatever the app theme.",
        'Why can\'t I edit this? On a record, pointing at a locked field names the exact rule behind it: the role or pipeline step a lock rule lists, the section locked for the role and the form it is on, or the role\'s field permissions. Admins also see a "N fields hidden by rules" note above the form that lists each hidden field and the rule that hides it (step rules, sections hidden from roles, fields turned off on the form).'
      ]
    },

    { type: 'h2', id: 'layout-editor-follow', text: 'Owner, watching and sharing a form' },
    {
      type: 'ul',
      items: [
        'Watch: ⋯ → Watch this form in the editor top bar. While it is on you get a notification (your Profile → Notification rules decide the channels, category Watch) whenever someone saves a change to the form or restores one of its versions. It says who saved, what changed in counts (for example "2 fields moved, 1 section added") and the version note, and opens the editor with History showing. You never hear about your own saves. A watch is listed with your other notification subscriptions, where you can also remove it.',
        'Owner: Share → Owner names the business owner of a form. The overview shows "Owner: …" under the form. The owner hears about every saved change even without watching, and is told first; change requests about the form go to the owner first too.',
        'Preview link: Share → Preview link makes a read-only link that lasts 7, 14, 30 or 90 days, for people who are not administrators. It shows the last saved version of the form, with only the fields you may read, and never shows record data. Anyone with the link can leave a comment on a field or on the whole form; comments appear under Share → Comments from previews (the count shows on the Share button), where Select this field finds the field on the canvas and Resolve removes the comment. Turn off ends a link for everyone.'
      ]
    },

    { type: 'h2', id: 'layout-editor-whats-new', text: "What's new on this form" },
    {
      type: 'p',
      text: 'The first time someone opens a record form after it changed, a short note at the top of the form lists what is new, what moved to another section and what is no longer on the form, with who changed it and when. It only names fields that person may read. Dismissing it hides it for that person until the next change; the person who saved the change never sees it, and nothing shows the very first time someone opens a form.'
    },

    { type: 'h2', id: 'layout-editor-flows', text: 'React to form changes in flows and webhooks' },
    {
      type: 'p',
      text: 'Every saved change fires the flow trigger Form Layout Changed (`layout.updated`), so a flow can, for example, post the change to a Teams channel. Webhooks receive it when they name the source Form layouts (saved changes): the delivery is an update event whose data carries `event: "layout.updated"`.'
    },
    {
      type: 'pre',
      code: `// layout.updated payload (flow trigger data; webhook body data)
{
  "layout_id": 12, "layout_name": "Purchase order", "collection": "orders",
  "op_summary": "2 fields moved, 1 section added", "op_count": 3,
  "note": "Group the dates",            // the version note, or null
  "user_id": "…", "user_name": "Ada Lovelace",
  "history_url": "https://…/data-model/orders?tab=groups&layout=12&history=1"
}`
    },

    { type: 'h2', id: 'layout-editor-warning', text: 'Instances whose layouts are replaced' },
    {
      type: 'p',
      text: 'Layout configuration travels one way: development → staging every night (promote:config copies the layout, section and placement tables), staging → production at go-live. An edit made on staging is therefore gone the next morning. Set `LAYOUT_EDIT_WARNING` on such an instance and every layout editing surface — the overview, the editor and record-page Edit form — shows it as an always-visible banner. Unset = no banner. The editor still works either way.'
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
      code: `# Which form a record gets, checks and health (administrators)
GET  /api/collection-layouts/overview?collection=orders
     → { data: { rows: [...], warning: string | null } }   // sectioned, in /active order
GET  /api/collection-layouts/explain?collection=orders&item=42[&role_id=<uuid>][&slug=x]
     → { data: { layout_id, reason, checked: [{ layout_id, matched, why }] } }
GET  /api/collection-layouts/lint-context?collection=orders
     → { data: { fields, roles, requirements } }   // what the Problems panel reads
GET  /api/collection-layouts/health?collection=orders
     → { data: { rows: [{ layout_id, score, costs, counts, unreachable_fields }] } }
GET  /api/collection-layouts/coverage?collection=orders[&fresh=1]
     → { data: { sampled, limit, no_form, rule_error, rows: [{ layout_id, records, rule_matches }] } }
GET  /api/collection-layouts/field-access?collection=orders
     → { data: { roles: [{ role: { id, name, admin_access }, can_read, can_update,
                           hidden_fields, readonly_fields }] } }   // every role's field permissions
GET  /api/collection-layouts/:id/dependencies
     → { layout, groups, nodes, extensions }   // what relies on the layout

# Create, read and change a layout (administrators)
POST /api/collection-layouts  { collection, name, layout_type?, slug?, seed_fields?: true | string[],
                                template_id?, field_map? }
     // seed_fields: one section "Main" holding every visible field ("Create first form"),
     // or exactly the named fields in that order; template_id: a saved form template
     // (field_map renames its fields, { source: target | null })
GET  /api/collection-layouts/:id/bundle
     → { layout, groups, placements, rev }
POST /api/collection-layouts/:id/ops  { ops: LayoutOp[], base_rev, note?, reason?, ticket? }
     → the new bundle (applied all or nothing, at most 5000 ops)
     409 { error: 'stale', bundle }       // someone saved since base_rev
     400 { error, op_index }              // an op was refused (also a rename onto a taken name)
     400 { error, code: 'CHANGE_NOTE_REQUIRED' }   // the layout's change_note asks for a reason (+ ticket)
POST /api/field-config/:collection/project  { assignments: [...] }
     // the field rows GET /field-config would return if these placements were saved
     // (read-only: the canvas renders unsaved drafts through it; flushes no cache, pushes nothing)
Socket (live operations topic): ops:join { topic: 'layout:<id>' }
     ops:signal { topic, kind: 'select', state: 'start' | 'stop', target: '<design target key>' }
     ← ops:changed { topic, viewers: [{ id, name, selected? }] }   // who has the layout open

# History and scheduled changes (administrators)
GET   /api/collection-layouts/:id/versions/:versionId/bundle   → { data: { bundle, version } }
PATCH /api/collection-layouts/:id/versions/:versionId  { name | null }   // named: kept beyond the 30
POST  /api/collection-layouts/:id/versions/name  { name }   // name the layout as saved now
GET   /api/collection-layouts/:id/section-changes
      → { data: { [section key]: { by, by_id, at } } }   // who last changed each section
GET   /api/collection-layouts/schedules?collection=orders[&layout_id=5]
      → { data: [{ id, layout_id, run_at, status, op_count, created_by_name, note, error }] }
POST  /api/collection-layouts/:id/schedules  { ops, base_rev, run_at, note? }
PATCH /api/collection-layouts/schedules/:sid  { run_at }   // pending only
DELETE /api/collection-layouts/schedules/:sid              // cancel (or dismiss a failed one)

# Test records and the new-record walkthrough (administrators; read only)
POST /api/collection-layouts/:id/test-records
     { records: [{ item, role_id? }], draft?: { record_conditions, conditions, is_active, sort, layout_type }, fields?: [...] }
     → { data: { results: [{ item, role_id, found, role, saved: { layout_id, name, why }, draft: {...},
                             values: { <field>: value }, access }] } }   // at most 10 records
POST /api/collection-layouts/:id/walkthrough-access  { role_id?, draft? }
     → { data: { role, role_may_open, can_create, create_fields, hidden_fields,
                 new_record_form: { layout_id, name, why }, column_defaults } }

# Inspector reads (administrators; read only)
GET  /api/layout-inspect/:collection/columns
     → { data: { <column>: { type, max_length, precision, scale, nullable } } }
GET  /api/layout-inspect/:collection/value-lengths?field=code
     → { data: { field, sampled, filled, p50, p95, max, capped } }   // newest 5,000 rows by id
GET  /api/layout-inspect/:collection/form-fields
     → { data: [{ layout_id, name, layout_type, fields: [...] }] }
GET  /api/layout-inspect/:collection/orphans
     → { data: [{ layout_id, name, layout_type, placements: [{ field, group_key, reason }] }] }
     // reason: column_dropped | widget_deleted | grid_missing | section_missing
GET  /api/layout-inspect/:collection/translations
     → { data: { base, locales, groups_supported, layouts: [{ layout_id, name, missing, total }] } }
POST /api/layout-inspect/picker-preview
     { collection: <target>, steps: [{ key, label, filter }], fields?, sort? }
     → { data: { total, steps: [{ key, label, count, applies }], excluded, offered,
                 picker_filter, with_picker_filter, rows } }
GET  /api/widgets-internal/:id/placements
     → { data: [{ layout_id, name, collection }] }   // every layout placing the widget

# Every form at once (administrators)
GET  /api/collection-layouts/bulk/fields?collection=orders
     → { data: [{ field, forms }] }   // every field placed on a form, with how many forms hold it
POST /api/collection-layouts/bulk/preview  { collection, action, labels?, layout_ids? }
     → { data: { label, forms: [{ layout_id, name, rev, status: 'change'|'same'|'skip',
                                  reason, changes, notes }], values } }
     // action: { kind: 'retire', field }
     //       | { kind: 'change', change: { type: 'place_after'|'place_before', field, anchor }
     //                                 | { type: 'set_width', field, width: 12|6|4|3 }
     //                                 | { type: 'set_flag', field, flag: 'required'|'readonly'|'hidden', on }
     //                                 | { type: 'remove', field } }
     //       | { kind: 'macro', name, steps }
     // values (retire only): { populated, total, note } — records that still hold a value
POST /api/collection-layouts/bulk/apply  { …same, revs: { [layout_id]: rev } }
     → { data: { label, forms: [{ layout_id, status: 'applied'|'same'|'skipped'|'failed',
                                  reason, version_id, rev }] } }
     // a form whose rev moved since the preview is skipped
POST /api/collection-layouts/bulk/undo  { collection, items: [{ layout_id, version_id, rev }] }
     // restores each form unless it changed since the bulk change
GET  /api/collection-layouts/macros              // your own macros
POST /api/collection-layouts/macros  { id?, name, collection, steps, source_layout_id? }
POST /api/collection-layouts/macros/:id/delete

# Across forms (administrators)
GET  /api/collection-layouts/crossform?collection=
     → { data: { thumbs: { <layout id>: { blocks, more } }, labels: [{ field, field_label, variants }],
                 duplicates: [{ a, b, similarity, identical, only_a, only_b, differing, parent_id, can_link }] } }
GET  /api/collection-layouts/field-search?q=&collection=   // q at least 2 characters
     → { data: { fields: [{ collection, field, label, placements: [{ layout_id, layout_name, layout_type,
                 section, width, visible, label, label_hidden, inherited_from }] }], truncated } }

# Reuse: templates, the section library, copying sections (administrators)
GET    /api/collection-layouts/templates?kind=form|section   → { data: [{ id, kind, name, fields, ... }] }
POST   /api/collection-layouts/templates  { kind, name, description?, layout_id, group_key?, bundle? }
PATCH  /api/collection-layouts/templates/:id  { name?, description? }
DELETE /api/collection-layouts/templates/:id
POST   /api/collection-layouts/blocks/plan  { source: { template_id } | { layout_id, group_key },
                                              target_collection, target_bundle, field_map?, index? }
       → { ops, already, unmapped, dropped }   // read only; the editor applies the ops
POST   /api/collection-layouts/:id/copy-section  { source_layout_id, group_key, field_map? }
       → { bundle, group_key, already, unmapped, dropped }   // applied through :id's ops

# Usage
POST /api/layout-usage/beacon  { events: [{ layout_id, collection, item, open, saved, abandoned_step, steps }] }
     → 204   // signed in; at most 20 events a call, 60 a minute per person; events for a form
             // your role cannot open, or a record you cannot read, are dropped
GET  /api/layout-usage/:layoutId/today            → { data: { ready, day, opens, people, records } }   (admin)
GET  /api/layout-usage/:layoutId/friction?days=30 → { data: { opens, saves, abandons, steps, changed_after_save } }   (admin)
GET  /api/layout-usage/co-changes/:collection     → { data: { revisions, fields, pairs: [{ a, b, together, jaccard }] } }   (admin)

# Owner, watching and preview links
GET  /api/layout-collab/:id                        // administrators
     → { data: { owner: { id, name } | null, watching, watchers: [{ id, name }] } }
PUT  /api/layout-collab/:id/watch  { on }          // administrators: watch or stop watching
PUT  /api/layout-collab/:id/owner  { user_id }     // administrators: null clears the owner;
                                                   // the owner must be active and able to read the form's records
GET  /api/layout-collab/owners                     // administrators → { data: { <layout id>: { id, name } } }
GET  /api/layout-collab/:id/whats-new              // anyone who may read the collection
     → { data: { rev, lines: string[] | null, mark, changed_at?, changed_by? } }
POST /api/layout-collab/:id/whats-new/seen  { rev } // dismiss (or remember a first open)
GET|POST /api/layout-collab/:id/preview-links  { days }   // administrators; 201 { data: { token, path, expires_at, … } }
DELETE   /api/layout-collab/preview-links/:linkId         // administrators: turn a link off
GET      /api/layout-collab/:id/preview-comments          // administrators
DELETE   /api/layout-collab/:id/preview-comments/:commentId
GET  /api/form-preview/:token                      // public page (expiring token)
POST /api/form-preview/:token/comments  { field, name, text }   // public; 20 per 10 minutes per address
// Preview links are made, listed and revoked only here: /api/share-links refuses them.
// The page sends a strict Content-Security-Policy (one inline script, by nonce).

# Other environments and suggestions from people
GET  /api/collection-layouts/promote/sources       (admin) → other environments' APIs
GET  /api/collection-layouts/:id/export            (admin) → layout file
POST /api/collection-layouts/:id/promote/preview   (admin) { component_id | file, remote_layout_id? }
POST /api/collection-layouts/:id/promote/apply     (admin) { …same, base_rev }   409 = changed since
POST /api/layout-change-requests                   { collection, item, layout_id?, field?, message }
GET  /api/layout-change-requests?collection=&status=   (admin)
POST /api/layout-change-requests/:id/resolve       (admin) { decision: 'accept' | 'decline', note? }

# On the record page (as the viewer)
GET  /api/help-videos/for-form?collection=   → { data: { fields: { <field>: [video] }, sections: { <group key>: [video] } } }
GET  /api/collection-layouts/why?collection=&item=
     → { data: { layout: { id, name, why }, role, record_lock, locks: { <field>: { kind, text } }, hidden? } }
     // 404 when they cannot read the record; \`hidden\` for administrators only
POST /api/ai/field-fill  { collection, layout_id, field, item_id?, values? }   // record editors
     → { data: { value, missing } }   // the prompt is read from the layout, never sent
     403 when the field has no AI fill on that form, the role may not open the form,
         or the person may not change the record / field (a form with record rules has
         no AI fill before the record is saved); 429 past 30 fills in 5 minutes (all servers)
     Record pages never receive the prompt: placements carry ai_generate { enabled,
     has_prompt, tokens } for anyone who is not an administrator

# AI for layouts — administrators. Proposals only: nothing here writes a layout.
# Tools that need the model answer 503 when AI is not set up; rule-based checks answer without it.
POST /api/ai-design/layouts/:id/check-changes  { before?, after }
     → { data: { status: 'skipped', reason, changes } | { status: 'checked', changes,
                 warnings: [{ message, field, field_label, section, section_label, roles }], dropped } }
POST /api/ai-design/layouts/:id/entry-order  { bundle? }   // the draft
     → { data: { change_sets: [{ title, steps, ops, group_key, why }], dropped, checked } }
POST /api/ai-design/layouts/:id/sensitive  { bundle? }
     → { data: { findings: [{ field, class, seen_by, broad, suggest, section, change_set }], note } }
POST /api/ai-design/layouts/:id/persona-test  { role_id, goal? }
     → { data: { role, walkthrough, summary, steps, findings, dropped, ai_configured } }
POST /api/ai-design/layouts/:id/visual-critique  { sections, canvas, image? }
     → { data: { summary, comments, dropped, used_image, image_skipped, ai_configured } }
GET  /api/ai-design/layouts/:id/autofill-corrections?days=90
     → { data: { days, documents, fields: [{ field, proposed, corrected, kept, share, suggest }] } }

POST /api/ai-design/layouts/compose  { collection, text }
POST /api/ai-design/layouts/compose/file  multipart: collection, mode (picture | sop), note?, file
     → { data: { form: { name, layout: 'steps' | 'sections', groups: [{ label, fields, source }],
                         locks, requirements, candidates, dropped, explanation },
                 read_as?, states? } }    // the editor turns it into ops
POST /api/ai-design/layouts/:id/slim  { role_id }
     → { data: { role, parent, days, revisions, people, plan: { keep, drop, hide_groups } | null } }
POST /api/ai-design/layouts/:id/sections-by-meaning  { groups: [{ key, label, fields }], fields }
     → { data: { suggestions: [{ field, group_key, reason }], dropped } }

POST /api/ai-design/layouts/:id/rule  { text, target?: { kind: 'step', group } | { kind: 'lock', field } }
     → { data: { proposal, ops, sentence, replaces, dropped, notes,
                 test: { checked, matched, current, roles } } }   // newest 500 records
POST /api/ai-design/layouts/:id/cascade  { field, text }
     → { data: { related, cascade_filters, option_filter, sentences, dropped } }
POST /api/ai-design/layouts/:id/field-rule  { text, field? }
     → { data: { rule, sentence, dry_run: [{ id, label, before_label, after_label, new_record_label }] } }
     // save with POST /api/field-rules { ...rule }
POST /api/ai-design/layouts/:id/validation  { field, ai?: false }
     → { data: { checked, empty, capped, current, suggestions: [{ rule, sentence, source, fails }] } }
     // newest 5,000 values; the AI sees value shapes (masks, lengths, ranges), never values

GET  /api/ai-design/layouts/:id/text/locales
POST /api/ai-design/layouts/:id/text/:tool   // tool: glossary | intros | placeholders | choices | reading | translate ({ locale })
     // translations are stored on the placement as overrides.i18n[locale] = { label, help, draft: true }
POST /api/ai-design/layouts/:id/text/choices/field  { field, choices: [{ value, text }] }
     // the one write here: relabels the field's own choices (every form), logged with the old ones

GET  /api/ai-design/layouts/:id/describe              // the form in plain terms
GET  /api/ai-design/layouts/which-form?collection=orders&item=284212&role=Finance
GET  /api/ai-design/layouts/explain-field?collection=orders&field=zone&role=Finance&item=284212
     → { data: { verdict: 'shown' | 'shown read-only' | 'hidden' | 'not on the form' | 'cannot open the record',
                 reasons: [...], layout: { id, name } } }
POST /api/ai-design/layouts/:id/ask { question, history?, draft? }  → { data: { answer, cites } }
POST /api/ai-design/layouts/find-setting { question, candidates: [{ key, label, where }] }
POST /api/ai-design/layouts/explain-diff { a: { layout_id, version? }, b: { layout_id, version? }, ai? }
     → { data: { sentences, notes, summary, points } }   // version: id | 'newest'; none = now
POST /api/ai-design/layouts/:id/proposals { ops, note }   // store a proposal (201), never applied
     400 { error, dropped, op_index }                     // unknown names are dropped and listed
GET  /api/ai-design/layouts/:id/proposals[?status=all]
POST /api/ai-design/layouts/:id/proposals/:pid/resolve { outcome: 'applied' | 'rejected' }`
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
