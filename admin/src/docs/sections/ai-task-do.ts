import type { DocSection } from '../types.js'

export const aiTaskDoDocs: DocSection = {
  id: 'ai-task-do',
  label: 'Let AI do this (tasks & tickets)',
  content: [
    { type: 'h1', id: 'ai-task-do', text: 'Let AI do this — tasks and support tickets' },
    {
      type: 'p',
      text: 'The person a task or a support ticket is assigned to can ask AI to do it for them. The model reads — as that person, with their permissions and scopes — the task title and description, the record it sits on, the thread and the request type, and answers with one of three things: a plan, a few questions it needs answered first, or “AI can’t do this” with the reason and a manual checklist. A plan is an ordinary Ask AI plan: every step is validated and previewed as the assignee, nothing changes until they approve it, and it shows up in Plans history like any other.'
    },
    {
      type: 'note',
      text: 'Off until an administrator turns it on — Settings → AI Features → Let AI do this, separately for tasks and for support tickets. Only the assignee (or their active delegate) sees the button; an administrator sees it only on work assigned to them.'
    },
    { type: 'h2', id: 'ai-task-do-where', text: 'Where the button is' },
    {
      type: 'ul',
      items: [
        'A record’s Tasks panel and the Tasks slot on a layout — the sparkle icon on each open task of yours.',
        'My Work → My tasks — the same icon on every row.',
        'Support → Desk → a ticket’s detail — “Let AI do this” beside Pick it up.',
        'The panel opens beside the button. “Draft a plan” asks the model; it takes a few seconds and counts toward the daily cap.'
      ]
    },
    { type: 'h2', id: 'ai-task-do-review', text: 'Reviewing the plan' },
    {
      type: 'p',
      text: 'Above the steps the panel shows an estimated run time (from how long recent plans took per step kind, or a stated default rate), the hands-on time AI thinks it saves (labelled as its estimate), and a risk level — low, medium or high — from the records changed, steps that cannot be rolled back (notifications, chat posts, flows, tasks), deletes and how many collections it writes to. Steps that cannot be rolled back are called out before you approve. Under each step: the records and fields it touches (old → new where the preview has them), the people it tells, and whether it calls other systems or may email.'
    },
    {
      type: 'ul',
      items: [
        'Remove a step, or change a value where the step kind allows (the fields an update writes, a message’s subject and text, a task’s title). The step is rebuilt and previewed again as you.',
        '“Ask for a different plan…” sends a note back; the current draft is discarded and a new one drafted.',
        'Approve & run all, run step by step, or Run later (a scheduled plan is re-checked first). Progress is live; a failed step stops the plan and offers Re-check and retry.',
        'When the plan changes more records than the threshold (default 50), a second person — the task’s creator, else an administrator — must approve it first. They are notified; Approve & run opens once they have.'
      ]
    },
    { type: 'h2', id: 'ai-task-do-after', text: 'When it finishes' },
    {
      type: 'ul',
      items: [
        'One summary comment lands on the task or ticket thread as you — every step’s outcome and a link to the plan. A ticket’s requester hears about it the way they hear about any reply; nothing else is sent.',
        '“Mark task done” / “Mark ticket done” closes it; on a ticket, “Draft reply to requester” writes a reply from the outcome for you to edit and send through the normal reply box. Nothing is sent on its own.',
        '“Undo what AI did” — for seven days after it ran (administrators always, from Plans) — shows what will be restored and what cannot be (sent notifications, chat posts, flows), then restores it. A record someone edited since is shown and left alone; newer edits are never overwritten. The rollback is noted on the thread and in the task history.'
      ]
    },
    { type: 'h2', id: 'ai-task-do-settings', text: 'Settings and analytics' },
    {
      type: 'table',
      head: ['Setting', 'What it does'],
      rows: [
        ['On tasks / On support tickets', 'Each off by default.'],
        ['Roles that may use it', 'Nothing ticked = every role.'],
        ['Support request types that allow it', 'Nothing ticked = every type.'],
        [
          'Second approval above',
          'Records a plan may change before a second person must approve. 0 = never.'
        ],
        ['Drafts per person per day', 'How many times one person may ask per day. 0 = no limit.']
      ]
    },
    {
      type: 'p',
      text: 'Plans → History shows administrators a “Let AI do this” card: plans drafted from tasks and tickets in the last 90 days, how many ran, were rejected or rolled back, how many wait for a second approval, and the hours AI estimated it saved. Every model call is in the AI call log under the feature `task-do`.'
    },
    { type: 'h2', id: 'ai-task-do-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        ['GET /api/ai/task-do/me', 'anyone', 'Which kinds this person may use.'],
        ['GET /api/ai/task-do/tasks/:id', 'task’s people', 'Access verdict + this task’s plans.'],
        [
          'POST /api/ai/task-do/tasks/:id/draft',
          'assignee',
          '{answers?, note?, previous_plan_id?} → {kind: plan | questions | cannot}.'
        ],
        [
          'GET /api/ai/task-do/plans/:id',
          'owner, approver, admin',
          'The plan with review figures.'
        ],
        [
          'POST /api/ai/task-do/plans/:id/edit',
          'owner',
          '{remove_step} or {set: {step_id, field, value}}.'
        ],
        ['POST /api/ai/task-do/plans/:id/approve', 'creator / admin', 'The second approval.'],
        [
          'POST /api/ai/task-do/plans/:id/draft-reply',
          'owner',
          'Ticket: an AI-drafted reply (not sent).'
        ],
        [
          'GET / POST /api/ai/task-do/plans/:id/undo',
          'owner (7 days), admin',
          'Preview, then restore.'
        ],
        ['GET / PATCH /api/ai/task-do/settings', 'admin', 'The settings block.'],
        ['GET /api/ai/task-do/analytics', 'admin', 'The card’s figures.']
      ]
    }
  ]
}
