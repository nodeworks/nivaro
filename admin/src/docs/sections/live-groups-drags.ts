import type { DocSection } from '../types.js'

export const collabLiveGroupsDrags: DocSection = {
  id: 'live-groups-drags',
  label: 'Grouped Lists, Drags and Urgent Sound',
  content: [
    { type: 'h1', id: 'live-groups-drags', text: 'Grouped Lists, Drags and Urgent Sound' },
    {
      type: 'p',
      text: 'Three more places that keep up with other people without you reloading: grouped lists, calendar and Gantt drags, and an optional sound for urgent work.'
    },
    { type: 'h3', id: 'live-groups', text: 'Grouped lists' },
    {
      type: 'p',
      text: 'When a collection list or a queue table is grouped ("Group: State", "Group: Priority"…), each group header counts its rows live. When someone changes the field a list is grouped by, the record glides from its old group to its new one.'
    },
    {
      type: 'ul',
      items: [
        'Nothing moves under your pointer or keyboard focus. While you point at or tab through the list, a record bound for another group stays where it is with a small arrow mark — hover it for "Now in Closed — it moves there when you move the pointer away". It moves as soon as the pointer leaves the list, or after 10 seconds.',
        'A record that no longer belongs in the list fades and leaves the same way.',
        'In Calm or with reduced motion, records simply appear in their new group without gliding. With Live updates Off, the list waits for the refresh button.',
        'A grouped queue table re-reads once per burst of changes, as you, so its counts are always the ones you are allowed to see.'
      ]
    },
    { type: 'h3', id: 'live-drags', text: 'Calendar and Gantt drags' },
    {
      type: 'p',
      text: "On a collection's Calendar view you can drag an entry to another day; on the Gantt view you can drag a bar along the timeline (both dates move by the same number of days). Created and updated stamps never move."
    },
    {
      type: 'ul',
      items: [
        "Others looking at the same calendar or Gantt (same date fields) see a dashed outline of the entry moving, with your first name, while you drag — only if they can open that record. Nothing but the record id and the day travels; each person sees the entry's name from their own read.",
        'If someone else moved the same entry while you were dragging it, your drop does not silently win or vanish. The view says "Beth just moved Pump check to Dec 4. You dropped it on Dec 6." with Keep Beth\'s and Use yours. Escape keeps theirs.',
        'Press Escape while dragging to put it back. Dragging uses the same permissions as editing the record; a refused move is explained and the entry returns.',
        'Ghosts are a "who else is here" signal: they are hidden in Calm and Off.'
      ]
    },
    { type: 'h3', id: 'live-urgent-sound', text: 'Sound for urgent items' },
    {
      type: 'p',
      text: 'Profile → Notifications → "Play a sound for urgent items" (off until you turn it on) plays one short two-note chime when urgent work lands on you. "Hear it" plays a sample.'
    },
    {
      type: 'table',
      head: ['Counts as urgent', 'Example'],
      rows: [
        ['A critical notification', 'An SLA escalation, a monitor failing'],
        ['A missed deadline waiting on your acknowledgement', 'An SLA breach on a record you own'],
        ['An urgent task assigned to you', 'A task with priority Urgent'],
        [
          'A record whose collection marks it urgent',
          'Data Model → Settings → Collection Browser → Urgent flag names a yes/no field; a record with it on that lands on you'
        ]
      ]
    },
    {
      type: 'p',
      text: 'It never plays while Live updates are Off, inside your quiet hours, with do not disturb or focus mode on, while a huddle is holding your notifications, or before you have clicked anywhere in the app (browsers block sound until then). With several tabs open, only the one you used last plays it, and it replaces the ordinary notification sound for that arrival, so you never hear two.'
    },
    { type: 'h3', id: 'live-groups-dev', text: 'For developers' },
    {
      type: 'ul',
      items: [
        '`useSteadyGroups` / `planGroupHold` / `useRowGlide` (shared lib/live-groups.ts) — grouped rows that hold under the pointer and glide (FLIP) otherwise; rows carry `data-row-key`, headers `data-group-key`.',
        "`useLiveDrag`, `saveDrop`, `DragClashNotice` (shared lib/live-drag.ts) — ghosts over the `record:drag` socket event (api services/drag-relay.ts: passed on to the record's row-watch room only, the dragger must watch the row and may update the collection); drops carry `_base_revision`, so a newer save answers 409 MIDAIR_COLLISION.",
        '`notification:new` carries `urgent: true` (and `quiet: true` inside quiet hours) for urgent rows (api services/notification-urgent.ts). Extensions mark their own with `notifyUser(…, { urgent: true })`. Collection setting: `browser_config.urgent_field`. Person setting: `preferences.urgent_sound`.'
      ]
    }
  ]
}
