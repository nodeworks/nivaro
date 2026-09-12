import type { DocSection } from '../types'

export const detailSheets: DocSection = {
  id: 'detail-sheets',
  label: 'Detail Sheets & Review Widgets',
  content: [
    { type: 'h1', id: 'detail-sheets', text: 'Detail Sheets & Review Widgets' },
    {
      type: 'p',
      text: 'A layout of type "detail" drives the drill-down sheet that opens when a related record is clicked (a PO from a workflow, an invoice from a PO). With display_mode "read" it renders as a read-only presentation instead of a form: a header band, section cards as definition grids, tab groups as child tables — and any widget slots the layout carries, which is how a read-only sheet gets actions.'
    },
    { type: 'h3', text: 'Presentation settings (Data Model → Layout → settings, detail layouts)' },
    {
      type: 'table',
      head: ['Setting', 'Effect'],
      rows: [
        [
          'Sheet width',
          'Pixel width the drill sheet opens at (320–2000; default 640). A per-field drill config still wins.'
        ],
        [
          'Header band fields',
          'Identity fields lifted out of the cards into a band above them — the first is the title (large), the rest compact label/value pairs. Empty ones drop out.'
        ],
        [
          'Hide empty values',
          'Fields with no value are omitted from the cards instead of rendering as "—".'
        ]
      ]
    },
    { type: 'h3', text: 'Review-list widget' },
    {
      type: 'p',
      text: 'The review_list widget type lists child rows grouped by a key with a status decision per group (Approve / Reject / In review…), optional stamp fields and an action endpoint that owns the write. Two ways to find the rows: a relation path from the host record (workflow → purchase orders → invoices), or SIBLING mode — rows of the host\'s own collection sharing a field value (every line of this invoice, hosted on one line). An optional enrich endpoint (POST {ids}) returns per-row chips (a 3-way-match verdict) and whether the caller may decide each row; groups with an undecidable row show "View only" instead of buttons.'
    },
    {
      type: 'pre',
      code: `{
  "host_collection": "invoices", "collection": "invoices",
  "path": [], "sibling_field": "invoice_id",
  "group_by": "invoice_id", "aggregate_sum": "amount", "aggregate_sum_format": "currency",
  "line_columns": ["line_item_number", {"field": "amount", "format": "currency"},
    {"label": "Received", "format": "number",
     "lookup": {"collection": "line_items", "field": "quantity_received",
                "match": [{"local": "purchase_order", "remote": "purchase_order"},
                          {"local": "line_item_number", "remote": "line_number"}]}}],
  "status": {"field": "efp_review_status",
    "options": [{"value": "approved", "label": "Approve", "color": "green"},
                {"value": "rejected", "label": "Reject", "color": "red", "require_note": true}],
    "empty_label": "Unreviewed", "stamp_user_field": "approved_by", "stamp_date_field": "approved_on",
    "action_endpoint": "/efp/invoice-approvals/decide"},
  "enrich_endpoint": "/efp/invoice-approvals/enrich"
}

// enrich endpoint contract
POST <enrich_endpoint> { "ids": ["1", "2"] }
→ { "data": { "rows": { "1": { "chips": [{ "label": "PO match", "tone": "ok", "title": "…" }], "can_act": true } } } }`
    },
    {
      type: 'note',
      text: 'A group with exactly one entry (sibling mode) opens expanded. Without an action endpoint the widget PATCHes each row directly with the note as the change reason.'
    }
  ]
}
