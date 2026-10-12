import type { DocSection } from '../types.js'

export const aiDesignDocs: DocSection = {
  id: 'ai-design',
  label: 'Design Helpers',
  content: [
    { type: 'h1', id: 'ai-design', text: 'AI design helpers' },
    {
      type: 'p',
      text: 'Four admin-only helpers that propose configuration and never write it on their own: a layout review, field help text drafts, a role designed from a sentence, and saved views suggested per role. Each suggestion is applied one at a time by an admin, is logged, and can be undone.'
    },
    { type: 'h2', id: 'ai-design-layout-review', text: 'Layout review' },
    {
      type: 'p',
      text: 'Layout editor → settings rail → **Review this layout**. Rule checks run first and are counted, never guessed: a step with more than 15 fields or a section with more than 12, a required field inside a section that starts collapsed, a required field the layout hides, required or rule-bound fields with no help text, two fields with the same label, and empty sections. When AI is set up, the model adds unclear labels (with a better one) and help text for the fields that need it. Every field it names must be on the layout; anything else is dropped.'
    },
    {
      type: 'p',
      text: "Each finding names the field and, where it can, carries a fix: **Open section**, **Move field** (to the emptiest sibling step or section), **Add help text**, **Rename** or **Show field**. Help text and labels are editable before you apply them and are written as this layout's overrides, so other layouts keep theirs. A layout version is captured before every fix, so the newest fix offers **Undo** and any of them can be rolled back from Version history."
    },
    { type: 'h2', id: 'ai-design-help-text', text: 'Field help text drafts' },
    {
      type: 'p',
      text: "Collection → Settings → **Field help text** lists the visible fields with no help text. **Draft help text** asks the AI for one or two sentences per field, built from its type, choices, validation rules, field rules, cascade parents, relation and formula, plus the collection note and the data guide (Settings → AI Features). Accept, edit or skip each draft. Accepting writes the field's help text; the activity entry (`ai-help-text`) keeps the previous text."
    },
    { type: 'h2', id: 'ai-design-role', text: 'Design a role from a description' },
    {
      type: 'p',
      text: 'Roles → **Design with AI**. Describe the role ("Reads invoices in Zone 3, approves inventory requests, cannot export") and the AI proposes a name, policies with field limits and row filters, pages to switch off, and User Scopes for its members. Every collection, field, row-filter column, page and scope value is checked against this instance; a grant whose field limit or row filter cannot be kept is dropped whole rather than widened, and each drop is listed. The designer never proposes admin access.'
    },
    {
      type: 'p',
      text: "Edit the change set (remove grants, field limits or page restrictions, rename), then **Run simulator on the edits**: the simulator shows each collection's create/read/update/delete outcome and how many rows a member would see under the read filter. **Create role** is only possible while the simulation matches the proposal — the server checks the simulation's fingerprint. User Scopes belong to people, so they are listed for you to set on each member after adding them."
    },
    { type: 'h2', id: 'ai-design-role-views', text: 'Suggested views per role' },
    {
      type: 'p',
      text: "Roles → a role → **Suggested views** → **Find suggestions**. The API log of the last 14 days shows which filters people applied by hand in collection lists. A filter set counts when two or more members of the role applied it, or one member applied it on three separate days. Filter sets a shared view visible to that role already holds are left out, as are admin roles. Each suggestion shows the filters, the most used sort, and how many members applied it; the AI names it and picks columns from the collection's real fields. **Create view** writes a shared saved view scoped to the role."
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `POST /api/ai-design/layouts/:id/review        { ai?: boolean }  → { findings[], ai_used, ai_error, ai_configured }
POST /api/ai-design/layouts/:id/apply         { fix }           → { applied, undo_version_id }
GET  /api/ai-design/help-text/:collection                       → { candidates[] }
POST /api/ai-design/help-text/:collection/draft { fields? }     → { drafts[] }
POST /api/ai-design/help-text/:collection/apply { field, text } → { field, note, previous }
POST /api/ai-design/roles/design   { description, ui_routes? }  → { proposal, dropped[], simulation[], hash }
POST /api/ai-design/roles/simulate { proposal, ui_routes? }     → { proposal, dropped[], simulation[], hash }
POST /api/ai-design/roles/apply    { proposal, hash }           → 201 { id, name, policies, scopes }
POST /api/ai-design/role-views/suggest { days?, ai? }           → { suggestions[], ai_used, ai_error }
POST /api/ai-design/role-views/apply { role, collection, name, filters, sort?, columns? } → 201 { id }

All routes require an administrator. Drafting and role design answer 503 when AI is not set up;
the layout review and view suggestions still run their rule checks without it.`
    }
  ]
}
