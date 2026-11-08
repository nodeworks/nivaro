import { db } from '../db/index.js'
import {
  channels,
  GLOBAL_ROOM,
  generalChannel,
  joinDefaultChannelsForUsers
} from '../services/chat.js'

// ─── Default chat rooms backfill (army 11) ───────────────────────────────────
//
// General (and any channel) lists default roles; people join when a role is GIVEN, when the
// default roles are saved, or on their own first request. Everyone who already held such a role
// before 0.3.93 was never joined: staging General had 30 members of ~860 people in its default
// roles, and two machine accounts. Rob: every workflow approver, admin and creator is in General.
//
//   1. JOIN — every active, human (no account_kind), non-redacted person whose role is a default
//      role of General or a channel joins that room, through the app's own join path
//      (services/chat.ts joinDefaultChannelsForUsers: records the auto-join, honours the ops-room
//      guard and the "a person who LEFT stays out" rule — someone with an auto-join row and no
//      membership left on purpose and is not put back).
//   2. REMOVE — a machine account's (account_kind set, not placeholder) membership of those SAME
//      default rooms is removed. Record rooms and direct messages are never touched. Messages stay.
//
//   npx tsx src/scripts/chat-default-rooms-backfill.ts              (dry run: counts per room)
//   npx tsx src/scripts/chat-default-rooms-backfill.ts --execute
//
// Idempotent: a second run joins nobody and removes nothing.

const execute = process.argv.includes('--execute')
const up = (v: unknown) => String(v).toUpperCase()

async function main(): Promise<void> {
  // ── 1. Who should be in which default room ────────────────────────────────
  const general = await generalChannel()
  const rooms = new Map<string, { label: string; roles: Set<string> }>()
  for (const c of [general, ...(await channels()).values()]) {
    if (c.is_archived || c.is_direct || !c.default_roles?.length) continue
    const room = c === general ? GLOBAL_ROOM : `ch:${c.key}`
    rooms.set(room, {
      label: c === general ? 'General' : String(c.name ?? c.key),
      roles: new Set(c.default_roles.map(up))
    })
  }
  const allRoles = [...new Set([...rooms.values()].flatMap((r) => [...r.roles]))]
  const people = allRoles.length
    ? ((await db('nivaro_users')
        .whereIn('role', allRoles)
        .where('status', 'active')
        .whereNull('account_kind')
        .where((q) => void q.where('is_redacted', false).orWhereNull('is_redacted'))
        .select('id', 'role')) as Array<{ id: string; role: string }>)
    : []
  console.log(`${people.length} active people hold a default role of ${rooms.size} room(s)`)
  for (const [room, r] of rooms) {
    const want = people.filter((p) => r.roles.has(up(p.role))).map((p) => up(p.id))
    const members = new Set(
      ((await db('nivaro_chat_memberships').where({ room }).pluck('user')) as string[]).map(up)
    )
    const left = new Set(
      ((await db('nivaro_chat_auto_joins').where({ room }).pluck('user')) as string[]).map(up)
    )
    const missing = want.filter((id) => !members.has(id))
    const leftOnPurpose = missing.filter((id) => left.has(id)).length
    console.log(
      `  ${r.label} (${room}): ${want.length} in its roles · ${want.length - missing.length} already members · ` +
        `${missing.length - leftOnPurpose} to join · ${leftOnPurpose} left before (stay out)`
    )
  }
  if (execute && people.length) {
    let joined = 0
    for (let i = 0; i < people.length; i += 500) {
      const r = await joinDefaultChannelsForUsers(people.slice(i, i + 500).map((p) => p.id))
      joined += r.joined
    }
    console.log(`Joined ${joined} membership(s).`)
  }

  // ── 2. Machine accounts out of the DEFAULT rooms only ─────────────────────
  // Config review F7: only General and the channels with default roles. Record rooms (wf:, ir:)
  // and direct messages are never touched — an integration account may belong in a record room.
  const defaultRooms = [...rooms.keys()]
  const machines = (
    defaultRooms.length
      ? await db('nivaro_chat_memberships as m')
          .join('nivaro_users as u', 'u.id', 'm.user')
          .whereNotNull('u.account_kind')
          .whereNot('u.account_kind', 'placeholder')
          .whereIn('m.room', defaultRooms)
          .select('m.room', 'm.user', 'u.first_name', 'u.last_name', 'u.account_kind')
      : []
  ) as Array<{
    room: string
    user: string
    first_name: string | null
    last_name: string | null
    account_kind: string
  }>
  console.log(
    `${execute ? 'Removing' : 'Would remove'} ${machines.length} machine-account membership(s)`
  )
  for (const m of machines)
    console.log(
      `  ${m.room}: ${[m.first_name, m.last_name].filter(Boolean).join(' ') || '?'} (${m.account_kind})`
    )
  if (execute) {
    let removed = 0
    for (const m of machines)
      removed += Number(
        await db('nivaro_chat_memberships').where({ room: m.room, user: m.user }).del()
      )
    if (machines.length) console.log(`Removed ${removed}.`)
  }
}

main()
  .then(() => db.destroy())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err)
    await db.destroy().catch(() => {})
    process.exit(1)
  })
