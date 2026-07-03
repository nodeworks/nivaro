export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

export async function selectInChunks<T, I = string | number>(
  ids: I[],
  chunkSize: number,
  queryFn: (chunk: I[]) => Promise<T[]>
): Promise<T[]> {
  if (ids.length === 0) return []
  const chunks = chunkArray(ids, chunkSize)
  const results = await Promise.all(chunks.map((chunk) => queryFn(chunk)))
  return results.flat()
}
