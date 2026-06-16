import React, { useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import type { FieldComponentProps } from '../../types'

/**
 * Unstyled file input. On selection it uploads via client.upload() (POST /files)
 * and calls onChange with the returned file id. Renders the current id/url as text.
 *
 * On upload error the file input is reset via a key increment so the browser
 * doesn't show the failed filename as if the upload succeeded.
 */
export function FileField({
  field,
  value,
  onChange,
  error,
  disabled,
  readOnly,
  inputId,
  errorId
}: FieldComponentProps) {
  const client = useOptionalNivaroClient()
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  // Incrementing this key forces the <input> to remount, clearing the
  // selected filename after a failed upload.
  const [inputKey, setInputKey] = useState(0)

  const id = inputId ?? field.field

  const currentId =
    value != null && typeof value === 'object'
      ? String((value as { id?: unknown }).id ?? '')
      : value == null
        ? ''
        : String(value)

  return (
    <div>
      <input
        key={inputKey}
        type="file"
        id={id}
        name={field.field}
        disabled={disabled || readOnly || uploading || !client}
        aria-required={field.required}
        aria-invalid={(error != null && error.length > 0) || uploadError != null}
        aria-describedby={errorId}
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file || !client) return
          setUploading(true)
          setUploadError(null)
          try {
            const result = await client.upload(file, { title: file.name })
            onChange(result.id)
          } catch (err) {
            setUploadError(err instanceof Error ? err.message : 'Upload failed')
            // Reset the file input so it doesn't show the failed filename.
            setInputKey((k) => k + 1)
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
      {uploadError ? <span role="alert">{uploadError}</span> : null}
    </div>
  )
}
