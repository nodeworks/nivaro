import { DataTable, duration, Empty, Flags, InventoryTab, Pill, Td, Th } from './inventory-ui'

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
  return (
    <InventoryTab<Row[]>
      area='containers'
      intro='Every container on each host, who owns it, and which ones nothing looks after. Flagged rows come first.'
    >
      {(rows) =>
        rows.length === 0 ? (
          <Empty>No containers on this host.</Empty>
        ) : (
          <DataTable
            head={
              <>
                <Th>Container</Th>
                <Th>Owner</Th>
                <Th>State</Th>
                <Th>Restart</Th>
                <Th>Age</Th>
                <Th>Image</Th>
              </>
            }
          >
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className='max-w-[360px]'>
                  <div className='truncate font-medium' title={r.name}>
                    {r.name}
                  </div>
                  <Flags flags={r.flags} />
                </Td>
                <Td>
                  {r.owner.kind === 'none' ? <Pill tone='amber'>No owner</Pill> : r.owner.label}
                </Td>
                <Td>
                  <Pill tone={tone(r.state)}>{r.state}</Pill>
                  {r.stopped_days != null && (
                    <span className='ml-1.5 text-slate-500 dark:text-muted-foreground'>
                      {r.stopped_days}d ago
                    </span>
                  )}
                </Td>
                <Td>{r.restart_policy ?? '—'}</Td>
                <Td className='tabular-nums'>{duration(r.age_s)}</Td>
                <Td className='max-w-[240px] truncate'>
                  <span title={r.image}>{r.image}</span>
                </Td>
              </tr>
            ))}
          </DataTable>
        )
      }
    </InventoryTab>
  )
}
