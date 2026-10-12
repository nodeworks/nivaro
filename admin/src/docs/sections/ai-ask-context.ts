import type { DocSection } from '../types.js'

export const aiAskContextDocs: DocSection = {
  id: 'ai-ask-context',
  label: 'Ask AI from any page',
  content: [
    { type: 'h1', id: 'ai-ask-context', text: 'Ask AI from any page' },
    {
      type: 'p',
      text: 'Press ⌘J (Ctrl+J on Windows) on any page, or type a question in the command palette (⌘K) and choose “Ask…”, and the Ask AI panel slides in over the page. What the page shows rides along as chips under the box: the open record, the list or queue with its filters and the rows on screen, or the report with its date range and filters. “Which of these are late?” then means the rows you are looking at. Remove a chip to ask without it. The panel keeps its questions as one conversation in your Ask AI history; “Open in Ask AI” continues it on the full page.'
    },
    {
      type: 'note',
      text: 'A chip sends ids and filters only. The server reads every record, row, report and file again with your access before the model sees it, so a record you cannot open is simply left out. An answer that used page context stays yours: it is never shown to people a conversation is shared with.'
    },
    { type: 'h2', id: 'ai-ask-context-records', text: 'Drag records in' },
    {
      type: 'p',
      text: 'While the panel is open, drag rows from a collection list or a queue onto it. Each becomes a chip, and “what do these have in common” means exactly those records (up to 20).'
    },
    { type: 'h2', id: 'ai-ask-context-files', text: 'Attach a file' },
    {
      type: 'p',
      text: 'Drop a PDF, Word, Excel, CSV or text file on the panel (or use the paperclip) and ask about it together with the data: “does this quote match the PO on PO-1042?”. The file is read with the same text extractor as document autofill; only its text is kept, for a day, and only you can use it. The file itself is not stored in Files. A scanned PDF without a text layer cannot be read. Up to five files per conversation share the 60,000-character reading budget; a longer document is read from the start and the answer says it was cut short.'
    },
    {
      type: 'p',
      text: 'On a record, the files already attached to it are offered under the box (“Attachments on this record — use as sources”). Pick the ones to read; they are only offered and read when you can open the record.'
    },
    { type: 'h2', id: 'ai-ask-context-reports', text: 'Ask about a report' },
    {
      type: 'p',
      text: 'On a Report Studio report, questions like “why did March dip” or “which zone drives the overrun” are answered from the widgets’ own queries, re-run with your access and the date range and filters on screen. For one widget the answer can read its whole series, the biggest movers and the rows behind the current and previous periods.'
    },
    { type: 'h2', id: 'ai-ask-context-config', text: 'Ask about configuration (administrators)' },
    {
      type: 'ul',
      items: [
        '“Which rules, flows and layouts use workflows.amount?” — the field impact scan plus flows that name the field.',
        '“Why does this field lock?” — field settings, layout lock conditions, role-locked sections, lock rules and locking pipeline states.',
        '“Who approves inventory requests over $50k in Zone 3?” — the owner matrix for the state, matched against the values you give, with the people in the winning group and the roles each transition needs.',
        '“What fires on this collection?” — rules, flows, webhooks, SLA rules, alerts, field watches and code hooks.'
      ]
    },
    { type: 'h2', id: 'ai-ask-context-team', text: 'Ask about my team (managers)' },
    {
      type: 'p',
      text: 'A manager can ask about their own direct reports — workload per person, stuck records, who is out and who covers, overdue tasks, the last week. It follows the team pages’ rule: only people whose manager you are, and records you cannot open are counted, never named.'
    },
    { type: 'h2', id: 'ai-ask-context-keys', text: 'Keyboard' },
    {
      type: 'table',
      head: ['Key', 'What it does'],
      rows: [
        ['⌘J', 'Open or close the panel on any page'],
        ['Enter', 'Ask (Shift+Enter for a new line)'],
        ['↑ in an empty box', 'Bring back the last question to edit'],
        ['Esc', 'Stop the answer while it streams; close the panel otherwise'],
        ['⌘↵', 'Ask the last question again, fresh (skips the answer cache)']
      ]
    }
  ]
}
