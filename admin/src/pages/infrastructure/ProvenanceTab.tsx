import { ExternalLink } from 'lucide-react'
import { formatRelative } from '@/lib/utils'
import { DataTable, duration, Empty, Flags, InventoryTab, Pill, Td, Th } from './inventory-ui'
import { Chip } from './ui'

interface Row {
  container: string
  image: string
  tag: string | null
  digest: string | null
  revision: string | null
  revision_url: string | null
  version: string | null
  built: number | null
  age_s: number | null
  releases_behind: { kind: 'patch' | 'minor' | 'major'; n: number } | null
  ahead: boolean
  flags: Array<{ code: string; text: string }>
}

const behindText = (b: NonNullable<Row['releases_behind']>) =>
  `${b.n} ${b.kind}${b.kind === 'patch' ? 'es' : b.n === 1 ? '' : 's'} behind`.replace(
    'patches',
    'patch releases'
  )

/** Where each running image came from: tag, digest, git revision, build date (#2840). */
export function ProvenanceTab() {
  return (
    <InventoryTab<Row[]>
      area='provenance'
      aside={(rows) => {
        const behind = rows.filter((r) => r.releases_behind).length
        return behind ? <Chip tone='warn'>{behind} behind this API</Chip> : null
      }}
      intro='Running containers whose image carries OCI labels or matches INFRA_OWN_IMAGES. "Behind" compares the image version label with the version of this API.'
    >
      {(rows) =>
        rows.length === 0 ? (
          <Empty>
            No running container has OCI image labels, and INFRA_OWN_IMAGES lists no matching image.
          </Empty>
        ) : (
          <DataTable
            head={
              <>
                <Th>Container</Th>
                <Th>Tag and digest</Th>
                <Th>Revision</Th>
                <Th>Built</Th>
                <Th>Release</Th>
              </>
            }
          >
            {rows.map((r) => (
              <tr key={r.container}>
                <Td className='max-w-[360px]'>
                  <div
                    className='truncate font-mono font-medium text-slate-900 dark:text-foreground'
                    data-tip={r.container.length > 40 ? r.container : undefined}
                  >
                    {r.container}
                  </div>
                  <Flags flags={r.flags} />
                </Td>
                <Td className='max-w-[260px]'>
                  <div className='truncate font-mono'>{r.tag ?? 'untagged'}</div>
                  <div
                    className='truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'
                    data-tip={r.digest ?? undefined}
                  >
                    {r.digest ? r.digest.slice(0, 19) : 'no digest'}
                  </div>
                </Td>
                <Td>
                  {r.revision ? (
                    r.revision_url ? (
                      <a
                        href={r.revision_url}
                        target='_blank'
                        rel='noreferrer'
                        className='inline-flex items-center gap-1 font-mono text-nvr-navy hover:underline dark:text-nvr-cyan'
                      >
                        {r.revision.slice(0, 8)}
                        <ExternalLink className='h-3 w-3' />
                      </a>
                    ) : (
                      <span className='font-mono'>{r.revision.slice(0, 8)}</span>
                    )
                  ) : (
                    '—'
                  )}
                </Td>
                <Td className='whitespace-nowrap'>
                  {r.built ? formatRelative(new Date(r.built * 1000)) : '—'}
                  <span className='ml-1 text-slate-500 dark:text-muted-foreground'>
                    {duration(r.age_s)}
                  </span>
                </Td>
                <Td>
                  <span className='inline-flex flex-wrap items-center gap-1.5'>
                    <span className='font-mono'>{r.version ?? '—'}</span>
                    {r.releases_behind && <Pill tone='amber'>{behindText(r.releases_behind)}</Pill>}
                    {r.ahead && <Pill>ahead of this API</Pill>}
                  </span>
                </Td>
              </tr>
            ))}
          </DataTable>
        )
      }
    </InventoryTab>
  )
}
