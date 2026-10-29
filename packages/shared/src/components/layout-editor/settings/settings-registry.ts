/**
 * Form settings — every control the Form settings panel offers, with the section it
 * lives in, the layout types it applies to and the one sentence that says what it
 * does. The panel renders from this list and the search box filters it, so a
 * control and its search text can never disagree.
 *
 * Keys are the parity checklist's keys (parity-keys.json, home 'form_settings');
 * the panel stamps each control with `data-setting="<key>"`. Retired settings
 * (summary_show_all, allow_clone, addendum_lock_fields, …) are deliberately absent.
 */

export type LayoutKind = 'grouped' | 'table' | 'file' | 'addendum' | 'detail' | 'summary'

export type SectionId =
  | 'who'
  | 'layout'
  | 'buttons'
  | 'read'
  | 'pdf'
  | 'addendum'
  | 'defaults'
  | 'entry'
  | 'inheritance'
  | 'tools'

export interface SectionDef {
  id: SectionId
  title: string
}

export interface SettingDef {
  key: string
  section: SectionId
  label: string
  /** One plain sentence: what changes for the people using the form. */
  effect: string
  types: LayoutKind[]
  /** Extra words the search box matches (controls inside the row the label does not name). */
  keywords?: string
}

/** In the order an admin thinks about a form (spec §7.2). */
export const SECTIONS: SectionDef[] = [
  { id: 'who', title: 'Who gets this form' },
  { id: 'layout', title: "How it's laid out" },
  { id: 'buttons', title: 'Buttons & panels' },
  { id: 'read', title: 'Read view & summary' },
  { id: 'pdf', title: 'PDF' },
  { id: 'addendum', title: 'Addendum' },
  { id: 'defaults', title: 'Defaults for new records' },
  { id: 'entry', title: 'Entering data' },
  { id: 'inheritance', title: 'Inheritance' },
  { id: 'tools', title: 'AI review, previews, version history' }
]

const ALL: LayoutKind[] = ['grouped', 'table', 'file', 'addendum', 'detail', 'summary']
/** Layouts people open a record with. A PDF (file) layout only renders the PDF:
 *  its buttons, panels, folding and new-record defaults never show. */
const ON_SCREEN: LayoutKind[] = ['grouped', 'table', 'detail', 'summary']
const ON_SCREEN_RECORD: LayoutKind[] = ['grouped', 'detail', 'summary']
/** Only grouped forms join the New menu (lib/use-new-item-layouts.ts). */
const NEW_MENU: LayoutKind[] = ['grouped']

export const SETTINGS: SettingDef[] = [
  // ── Who gets this form ────────────────────────────────────────────────────
  {
    key: 'layout.layout_type',
    section: 'who',
    label: 'Kind of layout',
    effect:
      'Decides where this layout is used: the record form, read mode, a drill-down, a PDF, an addendum or grid columns.',
    types: ALL,
    keywords: 'make default fallback active'
  },
  {
    key: 'layout.record_conditions',
    section: 'who',
    label: 'Show for matching records',
    effect: 'Records that match every rule open with this form instead of the default.',
    types: ['grouped']
  },
  {
    key: 'layout.conditions.role_ids',
    section: 'who',
    label: 'Roles',
    effect: 'Only people in these roles get this layout. With no roles, everyone can.',
    types: ALL
  },
  {
    key: 'layout.slug',
    section: 'who',
    label: 'Link name',
    effect:
      'Lets links, buttons and code open this exact layout (?layout=…). Letters, digits and _ only.',
    types: ALL
  },
  {
    key: 'layout.create_label',
    section: 'who',
    label: 'New-menu label',
    effect: 'The name shown in the New menu of the collection list. Empty uses the layout name.',
    types: NEW_MENU
  },
  {
    key: 'layout.create_hidden',
    section: 'who',
    label: 'Hide from New menu',
    effect: 'Leaves this layout out of the New menu; its link name keeps working.',
    types: NEW_MENU
  },
  {
    key: 'layout.conditions.active_window',
    section: 'who',
    label: 'Active dates',
    effect:
      'The form applies only on these days, both included; outside them records open with the next form that fits.',
    types: ['grouped'],
    keywords: 'window from until year end close season schedule period'
  },
  {
    key: 'layout.conditions.phone_of',
    section: 'who',
    label: 'Phone version',
    effect:
      'A lighter copy of a form that opens instead of it on small screens; it never opens on its own.',
    types: ['grouped'],
    keywords: 'mobile small screen variant device lighter'
  },
  {
    key: 'layout.conditions.tablet_of',
    section: 'who',
    label: 'Tablet version',
    effect:
      'A copy of a form arranged for tablet-width screens that opens instead of it there (and on a phone without a phone version); it never opens on its own.',
    types: ['grouped'],
    keywords: 'ipad tablet medium screen variant device touch'
  },

  // ── How it's laid out ─────────────────────────────────────────────────────
  {
    key: 'layout.tab_mode',
    section: 'layout',
    label: 'Loose tabs show as',
    effect:
      'How tabs outside a tab container appear: side by side, or as numbered steps. Tab containers set their own.',
    types: ['grouped', 'addendum']
  },
  {
    key: 'layout.validate_before_next',
    section: 'layout',
    label: 'Check each step before Next',
    effect: "In steps, Next stays blocked until the current step's required fields are filled.",
    types: ['grouped', 'addendum']
  },
  {
    key: 'layout.accordion_mode',
    section: 'layout',
    label: 'One section open at a time',
    effect: 'Opening a section closes the others.',
    types: ON_SCREEN
  },
  {
    key: 'layout.density',
    section: 'layout',
    label: 'Density',
    effect:
      'How tightly the form is spaced for the people filling it in: comfortable, or compact to fit more on the screen.',
    types: ['grouped'],
    keywords: 'compact comfortable spacing tight dense padding row gap height'
  },
  {
    key: 'layout.row_order_field',
    section: 'layout',
    label: 'Let people reorder rows',
    effect: 'Rows get a drag handle and their order is saved into the number field you pick.',
    types: ['table']
  },

  // ── Buttons & panels ──────────────────────────────────────────────────────
  {
    key: 'layout.ai_enabled',
    section: 'buttons',
    label: 'AI buttons',
    effect: 'Shows the AI fill and summarise buttons on records opened with this layout.',
    types: ON_SCREEN
  },
  {
    key: 'layout.dossier_enabled',
    section: 'buttons',
    label: 'Dossier button',
    effect:
      "Adds a Dossier button on saved records: one PDF with values, workflow history, comments and tasks. Only the default form's switch counts.",
    types: ON_SCREEN_RECORD
  },
  {
    key: 'layout.dossier_label',
    section: 'buttons',
    label: 'Dossier button label',
    effect:
      "Text on the Dossier button. Empty shows “Dossier”. Only the default form's label counts.",
    types: ON_SCREEN_RECORD
  },
  {
    key: 'layout.disable_comments',
    section: 'buttons',
    label: 'Hide comments',
    effect: 'Removes the comments panel.',
    types: ON_SCREEN
  },
  {
    key: 'layout.disable_tasks',
    section: 'buttons',
    label: 'Hide tasks',
    effect: 'Removes the tasks panel.',
    types: ON_SCREEN
  },
  {
    key: 'layout.disable_revisions',
    section: 'buttons',
    label: 'Hide revisions',
    effect: 'Removes the revision history panel.',
    types: ON_SCREEN
  },
  {
    key: 'layout.disable_clone',
    section: 'buttons',
    label: 'Hide Clone button',
    effect: 'People cannot copy a record from here.',
    types: ON_SCREEN
  },
  {
    key: 'layout.disable_delete',
    section: 'buttons',
    label: 'Hide Delete button',
    effect: 'People cannot delete a record from here.',
    types: ON_SCREEN
  },
  {
    key: 'layout.hide_integrity_banner',
    section: 'buttons',
    label: 'Hide data-integrity banner',
    effect: 'Records with data-integrity findings no longer show the warning strip.',
    types: ON_SCREEN
  },
  {
    key: 'layout.hide_sla_banner',
    section: 'buttons',
    label: 'Hide SLA banner',
    effect: 'Records past an SLA no longer show the breach strip.',
    types: ON_SCREEN
  },
  {
    key: 'layout.changes_tray',
    section: 'buttons',
    label: 'Unsaved-changes tray',
    effect: 'Lists every unsaved field and line while editing, each with its own undo.',
    types: ON_SCREEN
  },
  {
    key: 'layout.allow_schedule',
    section: 'buttons',
    label: 'Schedule button for everyone',
    effect: 'Everyone who can edit may schedule a change for later, not only admins.',
    types: ON_SCREEN
  },
  {
    key: 'layout.allow_disable_pickers',
    section: 'buttons',
    label: 'Hide-from-pickers button for everyone',
    effect: 'Everyone who can edit may hide a record from pickers, not only admins.',
    types: ON_SCREEN
  },

  // ── Read view & summary ───────────────────────────────────────────────────
  {
    key: 'layout.summary_enabled',
    section: 'read',
    label: 'Summary side panel',
    effect: 'Shows a side panel with the summary fields beside the form.',
    types: ON_SCREEN_RECORD
  },
  {
    key: 'layout.summary_hide_empty',
    section: 'read',
    label: 'Summary: hide empty fields',
    effect: 'Fields with no value are left out of the summary panel.',
    types: ON_SCREEN_RECORD
  },
  {
    key: 'layout.display_mode',
    section: 'read',
    label: 'Drill-down opens as',
    effect: 'Whether a drill-down shows this layout as an editable form or as a read view.',
    types: ['detail']
  },
  {
    key: 'layout.sheet_width',
    section: 'read',
    label: 'Read view width',
    effect: 'Width of the read view sheet in pixels, 320 to 2000. Empty uses 640.',
    types: ['detail', 'summary']
  },
  {
    key: 'layout.header_fields',
    section: 'read',
    label: 'Header band fields',
    effect: 'Up to 8 fields shown in the band at the top of the read view. The first is the title.',
    types: ['detail', 'summary']
  },
  {
    key: 'layout.hide_empty',
    section: 'read',
    label: 'Hide empty values',
    effect: 'Fields with no value are left out of the read view.',
    types: ['detail', 'summary']
  },

  // ── PDF ───────────────────────────────────────────────────────────────────
  {
    key: 'layout.pdf_export_active',
    section: 'pdf',
    label: 'PDF button on records',
    effect: 'Records show a button that downloads this PDF. Several PDF layouts can be on at once.',
    types: ['file']
  },
  {
    key: 'layout.pdf_theme',
    section: 'pdf',
    label: 'Theme',
    effect: 'The look of the generated PDF.',
    types: ['file']
  },
  {
    key: 'layout.pdf_template_id',
    section: 'pdf',
    label: 'Custom template',
    effect: 'Builds the PDF from one of your PDF templates instead of a built-in theme.',
    types: ['file']
  },
  {
    key: 'layout.pdf_cover_enabled',
    section: 'pdf',
    label: 'Cover page',
    effect: 'Starts the PDF with a cover page.',
    types: ['file']
  },
  {
    key: 'layout.pdf_cover_title_field',
    section: 'pdf',
    label: 'Cover title',
    effect: "The field whose value becomes the cover's title.",
    types: ['file']
  },
  {
    key: 'layout.pdf_cover_subtitle',
    section: 'pdf',
    label: 'Cover subtitle',
    effect: 'Fixed text printed under the cover title.',
    types: ['file']
  },
  {
    key: 'layout.pdf_button_label',
    section: 'pdf',
    label: 'Button label',
    effect: 'Text on the download button. Empty shows “Download PDF”.',
    types: ['file']
  },
  {
    key: 'layout.pdf_show_logo',
    section: 'pdf',
    label: 'Include logo',
    effect: 'Prints the logo at the top of the PDF.',
    types: ['file']
  },
  {
    key: 'layout.pdf_page_size',
    section: 'pdf',
    label: 'Page size',
    effect: 'A4 or US Letter paper.',
    types: ['file']
  },
  {
    key: 'layout.pdf_orientation',
    section: 'pdf',
    label: 'Orientation',
    effect: 'Portrait or landscape pages.',
    types: ['file']
  },
  {
    key: 'layout.pdf_preview',
    section: 'pdf',
    label: 'Preview PDF',
    effect: 'Opens the PDF this layout makes, filled with sample values, in a new tab.',
    types: ['file']
  },

  // ── Addendum ──────────────────────────────────────────────────────────────
  {
    key: 'layout.workflow_template_id',
    section: 'addendum',
    label: 'Addendum workflow',
    effect: 'The workflow every addendum made with this form goes through.',
    types: ['addendum']
  },
  {
    key: 'layout.single_active_addendum',
    section: 'addendum',
    label: 'One addendum at a time',
    effect: 'A new addendum cannot start while another one on the record is still open.',
    types: ['addendum']
  },
  {
    key: 'layout.addendum_layout_id',
    section: 'addendum',
    label: 'Addendum form',
    effect:
      "The form people use to raise an addendum on these records. Empty uses the collection's default addendum form.",
    types: ['grouped']
  },
  {
    key: 'layout.addendum_default_view',
    section: 'addendum',
    label: "Open on the addendum's changes",
    effect: 'A record with an open addendum opens on its proposed changes first.',
    types: ['grouped']
  },

  // ── Defaults for new records ──────────────────────────────────────────────
  {
    key: 'layout.default_values',
    section: 'defaults',
    label: 'Starting values',
    effect: 'Filled in on every new record made with this form; people can still change them.',
    types: ['grouped', 'addendum']
  },
  {
    key: 'layout.quick_picker',
    section: 'defaults',
    label: 'Quick picker steps',
    effect:
      'Before a new record opens, people pick these fields one at a time, each narrowed by the ones before.',
    types: ON_SCREEN
  },
  {
    key: 'layout.quick_picker_seed',
    section: 'defaults',
    label: 'Fill steps from cascade rules',
    effect: 'Replaces the steps with the cascade chain of this collection, parents first.',
    types: ON_SCREEN
  },

  // ── Entering data ─────────────────────────────────────────────────────────
  {
    key: 'layout.focus_first',
    section: 'entry',
    label: 'Start on the first empty required field',
    effect: 'When the form opens, the cursor is already in the first required field with no value.',
    types: NEW_MENU,
    keywords: 'keyboard focus autofocus cursor'
  },
  {
    key: 'layout.enter_next',
    section: 'entry',
    label: 'Enter moves to the next field',
    effect:
      'Pressing Enter in a field goes to the next one instead of saving; Ctrl or ⌘ + Enter still saves.',
    types: NEW_MENU,
    keywords: 'keyboard submit return'
  },
  {
    key: 'layout.tab_order',
    section: 'entry',
    label: 'Tab order',
    effect:
      'The order the Tab key visits fields in. Set it by clicking fields in order on the canvas.',
    types: NEW_MENU,
    keywords: 'keyboard accessibility sequence'
  },
  {
    key: 'layout.adaptive_mode',
    section: 'entry',
    label: 'Guided steps for new people',
    effect:
      'A person making their first records sees this form as steps; after that it shows as tabs. Each person can switch.',
    types: NEW_MENU,
    keywords: 'beginner expert onboarding steps tabs'
  },
  {
    key: 'layout.adaptive_threshold',
    section: 'entry',
    label: 'Records before tabs',
    effect: 'How many records of their own a person makes before the form switches to tabs.',
    types: NEW_MENU
  },
  {
    key: 'layout.tour',
    section: 'entry',
    label: 'First-use tour',
    effect:
      'The first time someone opens this form, a short tour walks them through its sections; a Tour button brings it back.',
    types: NEW_MENU,
    keywords: 'onboarding guide walkthrough introduction help first time new people'
  },
  {
    key: 'layout.badge',
    section: 'entry',
    label: 'Form badge',
    effect:
      'A colour and short tag on the record header, so people can tell which form they are in.',
    types: NEW_MENU,
    keywords: 'identity chip tag colour label'
  },
  {
    key: 'layout.glossary',
    section: 'entry',
    label: 'Glossary tooltips in help text',
    effect: 'Glossary terms in help text get a dotted underline that shows their definition.',
    types: NEW_MENU,
    keywords: 'definition term hover'
  },
  {
    key: 'layout.presets',
    section: 'entry',
    label: 'Placement presets',
    effect:
      'Named bundles of field settings (width, required, help text) that apply to other fields in one click.',
    types: NEW_MENU,
    keywords: 'template reuse bundle'
  },

  // ── Inheritance ───────────────────────────────────────────────────────────
  {
    key: 'layout.parent_layout_id',
    section: 'inheritance',
    label: 'Inherit from',
    effect:
      'Fields this layout does not place come from the layout you pick (same collection, one level).',
    types: ALL
  },

  // ── AI review, previews, version history ──────────────────────────────────
  {
    key: 'tool.preview_record',
    section: 'tools',
    label: 'Preview with a record',
    effect: 'Opens a real record with this layout in a new tab.',
    types: ALL
  },
  {
    key: 'tool.preview_as_role',
    section: 'tools',
    label: 'Preview as role',
    effect: 'Shows which layout someone in a role gets and which fields they cannot see or edit.',
    types: ALL
  },
  {
    key: 'tool.describe',
    section: 'tools',
    label: 'Describe this layout',
    effect: 'A short plain-words description of what this layout does and who sees it.',
    types: ALL
  },
  {
    key: 'tool.ai_review',
    section: 'tools',
    label: 'Review this layout',
    effect:
      'AI looks for problems (missing required fields, odd order) and offers fixes you can undo.',
    types: ALL
  },
  {
    key: 'tool.ai_text',
    section: 'tools',
    label: 'AI wording',
    effect:
      'AI checks labels, help and choices against the glossary and plain language, and drafts section intros, placeholders and translations; you pick what to apply.',
    types: ON_SCREEN,
    keywords: 'glossary intro placeholder choices reading level plain language translation'
  },
  {
    key: 'tool.version_history',
    section: 'tools',
    label: 'Version history',
    effect: 'Every save keeps a version of the layout.',
    types: ALL
  },
  {
    key: 'tool.version_diff',
    section: 'tools',
    label: 'What changed',
    effect: 'Compares the last save, or any version, with the layout now.',
    types: ALL
  },
  {
    key: 'tool.version_restore',
    section: 'tools',
    label: 'Restore a version',
    effect: 'Puts the layout back exactly as a version was; the current one is kept as a version.',
    types: ALL
  },
  {
    key: 'layout.change_note',
    section: 'tools',
    label: 'Ask why on every save',
    effect:
      'Save asks for a short reason, and a ticket link if you choose, and keeps it with the version in History.',
    types: ALL,
    keywords: 'change note reason ticket audit required'
  },
  {
    key: 'layout.email_summary_group',
    section: 'tools',
    label: 'Section for notification emails',
    effect:
      'Notification emails summarise the record with this section’s fields, in this form’s order, cut to what each person may see. None keeps the header strip. Only the default form’s choice counts.',
    types: NEW_MENU,
    keywords: 'email mail notification summary body section'
  },
  {
    key: 'layout.conditions.freeze',
    section: 'tools',
    label: 'Freeze edits',
    effect:
      'Until the date, saves to this layout are refused with your reason; an administrator can still save by giving a note.',
    types: ALL,
    keywords: 'freeze lock go-live audit read-only block edits override'
  },
  {
    key: 'tool.cost_limit',
    section: 'tools',
    label: 'Form cost limit',
    effect:
      'Test and Check impact warn when opening a record on this form takes more requests than this.',
    types: ON_SCREEN_RECORD,
    keywords: 'requests pickers grids widgets queries slow'
  },
  {
    key: 'tool.layout_drift',
    section: 'tools',
    label: 'Layout drift',
    effect: 'Checks whether something outside the editor changed this layout since its last save.',
    types: ALL
  }
]

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]))

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key)
}

/** A stored layout_type; NULL / unknown = grouped (the legacy default). */
export function layoutKindOf(layout: object | null | undefined): LayoutKind {
  const t = (layout as { layout_type?: unknown } | null | undefined)?.layout_type
  return t === 'table' || t === 'file' || t === 'addendum' || t === 'detail' || t === 'summary'
    ? t
    : 'grouped'
}

/** Every word of the query appears in the label, the effect sentence or the key. */
export function matchesQuery(def: SettingDef, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = `${def.label} ${def.effect} ${def.key} ${def.keywords ?? ''}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

export interface VisibleSection {
  section: SectionDef
  settings: SettingDef[]
}

/** The sections (in order) and settings that apply to a layout type and match the query. */
export function visibleSections(kind: LayoutKind, query = ''): VisibleSection[] {
  const out: VisibleSection[] = []
  for (const section of SECTIONS) {
    const settings = SETTINGS.filter(
      (s) => s.section === section.id && s.types.includes(kind) && matchesQuery(s, query)
    )
    if (settings.length) out.push({ section, settings })
  }
  return out
}
