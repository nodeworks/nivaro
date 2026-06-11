import React, { useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import type { FieldComponentProps } from '../../types'

/**
 * Unstyled file input. On selection it uploads via client.upload() (POST /files)
 * and calls onChange with the returned file id. Renders the current id/url as text.
 */
export function FileField({ field, value, onChange, disabled, readOnly }: FieldComponentProps) {
  const client = useOptionalNivaroClient()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentId =
    value != null && typeof value === 'object'
      ? String((value as { id?: unknown }).id ?? '')
      : value == null
        ? ''
        : String(value)

  return (
    <div>
      <input
        type="file"
        id={field.field}
        name={field.field}
        disabled={disabled || readOnly || uploading || !client}
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file || !client) return
          setUploading(true)
          setError(null)
          try {
            const result = await client.upload(file, { title: file.name })
            onChange(result.id)
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Upload failed')
          } finally {
            setUploading(false)
          }
        }}
      />
      {uploading ? <span aria-live="polite">Uploading…</span> : null}
      {currentId && client ? (
        <a href={client.fileUrl(currentId)} target="_blank" rel="noreferrer">
          {currentId}
        </a>
      ) : currentId ? (
        <span>{currentId}</span>
      ) : null}
      {error ? <span role="alert">{error}</span> : null}
    </div>
  )
}
