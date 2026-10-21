import { useState } from 'react'
import { DataTable, duration, Empty, Flags, InventoryTab, Pill, Td, Th } from './inventory-ui'
import { FilterChip, ImageRef, matches, SearchBox } from './swarm-ui'
import { Chip, Dash, StatStrip, useShowMore } from './ui'

interface Row {
  id: string
  name: string
  image: string
  state: string
  status: string
  owner: { kind: 'stack' | 'compose' | 'none'; label: string }
  restart_policy: string | null
  age_s: number | null
  stopped_days: number | null
  flags: Array<{ code: string; text: string }>
}

const tone = (s: string) =>
  s === 'running' ? 'green' : s === 'restarting' || s === 'paused' ? 'amber' : 'slate'

/** Every container per host with its owner, and the ones nothing manages (#2830). */
export function ContainersTab() {
  const [q, setQ] = useState('')
  const [flagged, setFlagged] = useState(false)
  return (
    <InventoryTab<Row[]>
      area='containers'
      intro='Every container on each host, who owns it, and which ones nothing looks after. Flagged rows come first.'
      toolbar={
        <div className='flex flex-wrap items-center gap-2'>
          <SearchBox value={q} onChange={setQ} placeholder='Filter containers, owners, images' />
          <FilterChip on={flagged} onToggle={() => setFlagged((v) => !v)}>
            Flagged only
          </FilterChip>
        </div>
      }
      aside={(rows) => {
        const n = rows.filter((r) => r.flags.length).length
        return (
          <>
            <span className='tabular-nums'>{rows.length} containers</span>
            {n > 0 && <Chip tone='warn'>{n} flagged</Chip>}
          </>
        )
      }}
    >
      {(rows) => <HostContainers rows={rows} q={q} flagged={flagged} />}
    </InventoryTab>
  )
}

function HostContainers({ rows, q, flagged }: { rows: Row[]; q: string; flagged: boolean }) {
  const shown = rows.filter(
    (r) =>
      (!flagged || r.flags.length > 0) &&
      matches(q, r.name, r.image, r.owner.label, r.state, r.restart_policy)
  )
  const { visible, more } = useShowMore(shown, 100)
  if (rows.length === 0) return <Empty>No containers on this host.</Empty>
  const running = rows.filter((r) => r.state === 'running').length
  const ownerless = rows.filter((r) => r.owner.kind === 'none').length
  return (
    <div className='space-y-3'>
      <StatStrip
        items={[
          { label: 'Containers', value: rows.length },
          { label: 'Running', value: running },
          { label: 'Not running', value: rows.length - running },
          { label: 'No owner', value: ownerless, tone: ownerless ? 'warn' : undefined }
        ]}
      />
      {shown.length === 0 ? (
        <Empty>Nothing on this host matches this filter.</Empty>
      ) : (
        <DataTable
          footer={more}
          head={
            <>
              <Th>Container</Th>
              <Th>Owner</Th>
              <Th>State</Th>
              <Th>Restart</Th>
              <Th className='text-right'>Age</Th>
              <Th>Image</Th>
            </>
          }
        >
          {visible.map((r) => (
            <tr key={r.id}>
              <Td className='max-w-[380px]'>
                <div
                  className='truncate font-mono font-medium text-slate-900 dark:text-foreground'
                  data-tip={r.name.length > 40 ? r.name : undefined}
                >
                  {r.name}
                </div>
                <Flags flags={r.flags} />
              </Td>
              <Td className='max-w-[220px] break-words'>
                {r.owner.kind === 'none' ? <Pill tone='amber'>No owner</Pill> : r.owner.label}
              </Td>
              <Td className='whitespace-nowrap'>
                <Pill tone={tone(r.state)}>{r.state}</Pill>
                {r.stopped_days != null && (
                  <span className='ml-1.5 text-slate-500 dark:text-muted-foreground'>
                    {r.stopped_days}d ago
                  </span>
                )}
              </Td>
              <Td className='whitespace-nowrap font-mono'>{r.restart_policy ?? <Dash />}</Td>
              <Td className='text-right tabular-nums'>{duration(r.age_s)}</Td>
              <Td>
                <div className='max-w-[260px]'>
                  <ImageRef image={r.image} />
                </div>
              </Td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  )
}
