import type { DocSection } from '../types.js'

export const aiConversationsDocs: DocSection = {
  id: 'ai-conversations',
  label: 'Ask AI history & sharing',
  content: [
    { type: 'h1', id: 'ai-conversations', text: 'Ask AI history & sharing' },
    {
      type: 'p',
      text: 'Every Ask AI conversation is kept for the person who started it: each question, the answer, the tool calls behind it and any action it proposed (with that proposal’s outcome, read live). The History list beside the chat shows them newest first, pinned ones on top, and searches titles and text. Opening one resumes it — the next question goes to the model with the whole thread. The AI call log stays the administrator’s record; this history is the person’s own, and administrators get no view into it.'
    },
    { type: 'h2', id: 'ai-conversations-history', text: 'History, pins and retention' },
    {
      type: 'ul',
      items: [
        'Pin a conversation from the list or the page header; pins sort first and are never pruned.',
        'Delete removes the conversation and everything in it. Someone it was shared with can remove it from their own list instead. Deleting a single message deletes your own; the owner removing someone else’s message only empties it — it stays a withheld turn, so later answers that may repeat it stay withheld too.',
        'Settings → AI Features → Ask AI conversation history: how many days an untouched conversation is kept (blank = 180, 0 = forever). The nightly retention job prunes the rest, except conversations any participant has pinned.'
      ]
    },
    { type: 'h2', id: 'ai-conversations-opt-out', text: 'Don’t save my questions' },
    {
      type: 'p',
      text: 'Each person can turn Ask AI history off — Profile → Ask AI history, or the switch at the top of the History list on the Ask page. From then on nothing they ask is stored as a conversation: answers still work live (the thread lives in the open page only), but there is no History entry, and Share, Post to chat, Branch, export and saved plan cards are unavailable because they need a saved conversation. A saved conversation opened while history is off is read-only. Turning it on offers a separate “Also delete my saved conversations” — it deletes only the conversations that person started (with their shares to other people); conversations others shared with them stay.'
    },
    {
      type: 'table',
      head: ['Still kept while history is off', 'What and for how long'],
      rows: [
        [
          'Ask AI memory notes',
          'Only the notes the person explicitly saved; they edit or delete them on Profile.'
        ],
        [
          'Thumbs up/down',
          'Only when the person chooses to give one: the rating and any comment they type, kept in the AI feedback table.'
        ],
        [
          'AI call log (administrators)',
          'One row per model call with tokens, cost, latency and capped copies of the request and response — which include the question — pruned after 30 days. Visible to administrators in AI analytics. Unchanged by this switch.'
        ],
        [
          'Activity log',
          'An `ai-chat` entry per question with the number of tool calls — no question text.'
        ],
        [
          'Answer cache',
          'The same standalone question by the same person answers from a per-person Redis cache for the configured window (default 15 minutes), then expires.'
        ],
        [
          'Not kept',
          'The conversation itself, and the shared playbook of worked examples (a question asked with history off never becomes one).'
        ]
      ]
    },
    { type: 'h2', id: 'ai-conversations-memory', text: 'Ask AI memory' },
    {
      type: 'p',
      text: 'Say “remember that amounts are in thousands” (or “remember: I work Zone 3 inventory requests”) and Ask AI keeps the note instead of answering. Notes ride every later question as context about you. Profile → Ask AI memory lists them for editing or deleting. At most 20 notes of 300 characters; when the list is full a new note is refused — nothing is ever dropped to make room — and the answer links to Profile → Ask AI memory to remove one first. Notes are stored in your preferences and never grant access to anything. Nobody else writes them — administrators included: they are left out of user reads, lists and revisions, and an administrator’s edit of your preferences keeps your notes as they were.'
    },
    {
      type: 'p',
      text: 'Remember this? When a question shows a lasting preference (“by my zone I mean Zone 3”, “show amounts in thousands”), Ask AI may offer a note under its answer. Nothing is kept unless you click Remember; “Not now” hides the offer. Offers are only ever shown to the person who asked — never to someone a conversation is shared with — and are never offered for one-off facts, record values, other people or anything that reads as an instruction to Ask AI (“call…”, “ignore…”, “always run…”). The offer says plainly that the note is added to every future question. With Ask AI history off, offers still appear and Remember keeps only the note. At most two per answer, none once your memory is full (a click on a full list is refused the same way, with a link to Profile).'
    },
    {
      type: 'p',
      text: 'Administrators can view and clear a person’s notes for a support or compliance request: People → the person → Admin tools → Ask AI memory. The notes stay hidden until Show notes; each view and each clear (one note or all) is written to the activity log as `ai-memory-view` / `ai-memory-clear` with counts only. Administrators can remove notes but never add or reword them.'
    },
    { type: 'h2', id: 'ai-conversations-sharing', text: 'Sharing a conversation' },
    {
      type: 'p',
      text: 'The owner shares a conversation with colleagues (Share in the header). They are notified, see it in their History, can read it and can ask follow-ups in the same thread; a new question or answer appears for everyone who has it open. Each person’s questions run with their own permissions.'
    },
    {
      type: 'p',
      text: 'An answer is shown to someone other than the person it was asked for only when it is safe to: it made at least one data call, every call is a plain read (not saved SQL, not an action proposal) that did not error, re-running each one with the reader’s access returns exactly what the model saw, and every earlier answer in the thread is readable by the reader too (the model saw those answers and may repeat them). Otherwise — including an answer with no data calls, or data that has changed since — the answer is withheld from that reader with an “Ask it with my access” button. Opening a thread re-checks at most 10 calls; anything past that is withheld until asked again. A follow-up asked by the reader is built only from the turns they may read.'
    },
    {
      type: 'note',
      text: 'Live sessions: while one person’s answer streams, everyone else with the thread open follows it — each finished step, then the answer text — but only once every step so far has been re-run with their own access and returned exactly what the model saw, and every earlier answer is readable by them. Text written before any data call, a step that is not a plain read, or a result that differs for them stops the stream for that person: they see that someone is asking, then the answer when it is stored, under the rule above.'
    },
    { type: 'h2', id: 'ai-conversations-background', text: 'Ask in the background' },
    {
      type: 'p',
      text: 'The clock button next to Send asks the question in the background: a longer run with a bigger budget of data calls, shown in the Jobs tray while it works. It reads with your access, and it can only read — it cannot draft changes or plans (ask on the page for those). The answer is saved to the conversation in your Ask history and you get an inbox notification; Cancel in the tray or under the question stops it and keeps whatever had arrived. It needs your Ask history on, and at most two run at once.'
    },
    { type: 'h2', id: 'ai-conversations-branch', text: 'Branching' },
    {
      type: 'p',
      text: 'Hover an earlier question and choose Edit to ask a different version of it. The answer continues in a new conversation (a branch) that holds everything before the edited question as you could read it — an answer withheld from you is copied as an empty placeholder that still counts as withheld; the original thread stays as it was. History nests branches under their source, and the conversation page links between them.'
    },
    { type: 'h2', id: 'ai-conversations-chat', text: 'Posting to chat' },
    {
      type: 'p',
      text: 'The owner can Post to chat: it sends the conversation to a channel, direct message or record room as a card: the question, a short answer and an Open link. The card is built for each reader — the short answer appears only when the sharing rule above admits them; otherwise it says the answer was given with the poster’s access. Anyone who can read the room can open the conversation and ask follow-ups with their own access.'
    },
    { type: 'h2', id: 'ai-conversations-export', text: 'Export and formats' },
    {
      type: 'ul',
      items: [
        'An answer built from a query offers CSV and Excel. The download re-runs the query with your access today — it never copies the answer’s text — and is named after the question and the time.',
        'A table, chart or “label: value” list in an answer has a Table · Chart · List switch. The other formats are drawn from the same rows, with no new question and no model call. A chart needs a column of numbers.',
        'Add to dashboard (under a chart answer) keeps the chart on one of your dashboards, or a new one. The widget stores the query behind the chart — the grouped count or total, or the saved query — not the answer, and re-runs it with the access of whoever views the dashboard. Hover its title to see the question it came from.',
        'Copy as code (administrators, and people with an API token or key) turns the reads an answer made into an SDK call, a REST request and a curl command. Anything naming data you cannot see — a filter on a hidden field, a grouping, a saved query you may not run — is left out and counted.'
      ]
    },
    { type: 'h2', id: 'ai-conversations-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'What it does'],
      rows: [
        [
          'POST /api/ai/chat { messages, save: true }',
          'Ask and start a stored conversation. The answer carries `conversation_id`.'
        ],
        [
          'POST /api/ai/chat { messages, conversation_id }',
          'Ask inside a conversation. The server builds the history from the turns the caller may read; only the newest question in `messages` is used.'
        ],
        [
          'POST /api/ai/memory { text }',
          'Keep a note the answer offered (`memory_suggestions` on the answer) in the caller’s own memory. 409 when the memory is full.'
        ],
        [
          'GET /api/users/:id/ai-memory',
          'Administrators: a person’s notes. Logged as `ai-memory-view`.'
        ],
        [
          'DELETE /api/users/:id/ai-memory[/:noteId]',
          'Administrators: clear all notes, or one. Logged as `ai-memory-clear`.'
        ],
        ['GET /api/ai/conversations?q=&pinned=1', 'Mine and shared with me, newest first.'],
        [
          'GET /api/ai/conversations/:id',
          'The thread as the caller may read it (`visible: false` = withheld), shares (owner only), branches, parent.'
        ],
        [
          'PATCH /api/ai/conversations/:id { title?, pinned? }',
          'Rename (owner) or pin (each person their own).'
        ],
        ['DELETE /api/ai/conversations/:id', 'Owner: delete. Shared: remove from my list.'],
        [
          'DELETE /api/ai/conversations/mine',
          'Delete every conversation the caller started (with its shares). PATCH /api/users/me/preferences { ai_history_off: true | null } is the opt-out; with it on, `save` is ignored and `conversation_id` answers 409.'
        ],
        [
          'POST /api/ai/conversations/:id/shares { user_ids }',
          'Owner shares with people (notifies them).'
        ],
        ['DELETE /api/ai/conversations/:id/shares/:shareId', 'Owner stops sharing.'],
        [
          'POST /api/ai/conversations/:id/branch { message_id, question }',
          'New conversation holding the turns before that question; ask `question` in it next.'
        ],
        [
          'POST /api/ai/conversations/:id/post { room, note? }',
          'Owner only: post to a chat room they can see.'
        ],
        [
          'GET /api/ai/conversations/:id/messages/:mid/export?format=csv|xlsx&step=',
          'The rows behind an answer, re-run as the caller.'
        ],
        [
          'DELETE /api/ai/conversations/:id/messages/:mid',
          'Remove one message (owner, or your own).'
        ],
        [
          'POST /api/ai/research { question, conversation_id? }',
          'Ask in the background (202 `{run_id, conversation_id, question_message_id}`); 409 with history off, 429 past two running.'
        ],
        [
          'POST /api/ai/research/:run/cancel',
          'Stop a background question (its asker, or an admin).'
        ],
        [
          'GET /api/ai/answer-code?conversation_id=&message_id=',
          'An answer’s reads as `{snippets: [{title, sdk, rest, curl, omitted}], skipped}` for the caller; `GET /api/ai/answer-code/access` says whether they may.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Live updates: participants receive `ai:conversation` `{conversation_id, by, message_id, state: asking|answered|failed}` on their user room — ids only; the client refetches and the server filters the answer per reader. A live answer arrives as `ai:live` `{conversation_id, message_id, by: {id, name}, kind: working|step|delta|end, tool?, summary?, text?, round?}` — steps and text only for readers the checks above admit.'
    }
  ]
}
