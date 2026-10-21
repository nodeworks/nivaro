import { formatFileSize, formatRelative } from '@/lib/utils'
import {
  DataTable,
  Empty,
  Flags,
  InventoryTab,
  Pill,
  Stat,
  StatStrip,
  Td,
  Th
} from './inventory-ui'

interface Vol {
  name: string
  kind: 'volume' | 'bind'
  driver: string | null
  anonymous: boolean
  size_bytes: number | null
  owner: string | null
  containers: string[]
  orphaned: boolean
  last_write: number | null
  backup: 'label' | 'env' | 'none'
  flags: Array<{ code: string; text: string }>
}
interface Inv {
  volumes: Vol[]
  reclaimable_bytes: number
  orphan_count: number
  last_write_known: boolean
}

/** Named volumes and bind mounts: size, owner, users, orphans, backup coverage (#2832). */
export function VolumesTab() {
  return (
    <InventoryTab<Inv>
      area='volumes'
      intro='Named volumes and bind mounts. A volume counts as backed up when its name matches INFRA_BACKED_UP_VOLUMES or it carries the label nivaro.backup=true.'
    >
      {(inv) => (
        <div className='space-y-3'>
          <StatStrip>
            <Stat label='Volumes and mounts' value={inv.volumes.length} />
            <Stat label='Orphaned' value={inv.orphan_count} />
            <Stat label='Reclaimable from orphans' value={formatFileSize(inv.reclaimable_bytes)} />
            <Stat
              label='Not backed up, in use'
              value={
                inv.volumes.filter((v) => v.flags.some((f) => f.code === 'unbacked-in-use')).length
              }
            />
          </StatStrip>
          {!inv.last_write_known && (
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              Host facts not collected, so last write times are not shown.
            </p>
          )}
          {inv.volumes.length === 0 ? (
            <Empty>No volumes on this host.</Empty>
          ) : (
            <DataTable
              head={
                <>
                  <Th>Volume</Th>
                  <Th>Size</Th>
                  <Th>Owner</Th>
                  <Th>Used by</Th>
                  <Th>Last write</Th>
                  <Th>Backup</Th>
                </>
              }
            >
              {inv.volumes.map((v) => (
                <tr key={`${v.kind}:${v.name}`}>
                  <Td className='max-w-[320px]'>
                    <div className='flex items-center gap-1.5'>
                      <span className='truncate font-medium' title={v.name}>
                        {v.anonymous ? `${v.name.slice(0, 12)}…` : v.name}
                      </span>
                      {v.kind === 'bind' && <Pill>bind</Pill>}
                      {v.anonymous && <Pill>anonymous</Pill>}
                      {v.orphaned && <Pill tone='amber'>orphaned</Pill>}
                    </div>
                    <Flags flags={v.flags} />
                  </Td>
                  <Td className='tabular-nums'>
                    {v.size_bytes != null ? formatFileSize(v.size_bytes) : '—'}
                  </Td>
                  <Td>{v.owner ?? '—'}</Td>
                  <Td className='max-w-[240px]'>
                    {v.containers.length ? v.containers.join(', ') : 'nothing'}
                  </Td>
                  <Td>{v.last_write ? formatRelative(new Date(v.last_write * 1000)) : '—'}</Td>
                  <Td>
                    {v.backup === 'none' ? (
                      <Pill tone={v.orphaned ? 'slate' : 'amber'}>Not covered</Pill>
                    ) : (
                      <Pill tone='green'>{v.backup === 'label' ? 'Label' : 'Listed'}</Pill>
                    )}
                  </Td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      )}
    </InventoryTab>
  )
}
