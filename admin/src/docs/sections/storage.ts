import type { DocSection } from '../types.js'

export const storageProviders: DocSection = {
  id: 'storage-providers',
  label: 'S3 / R2 / Azure Storage',
  content: [
    { type: 'h1', id: 'storage-providers', text: 'Storage Providers (S3 / R2 / Azure)' },
    {
      type: 'p',
      text: 'File storage is pluggable. The default remains local disk, but uploads can be stored in any S3-compatible object store (AWS S3, Cloudflare R2, MinIO) or Azure Blob Storage by setting `STORAGE_PROVIDER`. An optional CDN URL rewrites public file links.'
    },
    { type: 'h3', text: 'Environment' },
    {
      type: 'pre',
      code: `STORAGE_PROVIDER=local         # local (default) | s3 | azure

# S3 / R2 / MinIO
STORAGE_S3_BUCKET=nivaro-files
STORAGE_S3_REGION=auto
STORAGE_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # omit for AWS
STORAGE_S3_ACCESS_KEY=...
STORAGE_S3_SECRET_KEY=...

# Azure Blob
STORAGE_AZURE_CONNECTION_STRING=...
STORAGE_AZURE_CONTAINER=nivaro-files

# Optional CDN prefix for public URLs
STORAGE_CDN_URL=https://cdn.example.com`
    },
    { type: 'h3', text: 'Presigned uploads' },
    {
      type: 'p',
      text: 'For S3/Azure providers, large files can bypass the API entirely: request a presigned upload URL, PUT the file straight to the object store from the browser, then the file record is finalised.'
    },
    {
      type: 'pre',
      code: `POST /api/files/presign
{ "filename": "video.mp4", "type": "video/mp4", "folder": null }
// → { "upload_url": "https://...", "file_id": "..." }
// PUT the bytes to upload_url, then the file is available as /api/files/:file_id`
    },
    {
      type: 'note',
      text: 'Switching providers only affects new uploads — existing files stay where they were stored. Image transformations and file expiry work on every provider.'
    }
  ]
}

export const storageImageTransforms: DocSection = {
  id: 'image-transforms',
  label: 'Image Transformations',
  content: [
    { type: 'h1', id: 'image-transforms', text: 'Image Transformations' },
    {
      type: 'p',
      text: 'Any image file can be resized, cropped, re-encoded, and quality-tuned on the fly via the transform endpoint (powered by sharp). Results are cached, so repeated requests for the same variant are served without re-processing.'
    },
    {
      type: 'pre',
      code: `GET /api/files/:id/transform?w=800&h=600&fit=cover&format=webp&q=80`
    },
    {
      type: 'table',
      head: ['Param', 'Values', 'Meaning'],
      rows: [
        ['w / h', 'pixels', 'Target width / height (either or both)'],
        [
          'fit',
          'cover | contain | fill | inside | outside',
          'Resize strategy when both w and h given'
        ],
        ['format', 'webp | avif | jpeg | png', 'Output encoding (defaults to source format)'],
        ['q', '1–100', 'Quality for lossy formats (default 80)']
      ]
    },
    {
      type: 'note',
      text: 'Transforms respect file permissions — the caller must be able to read the original file. Non-image files return 400.'
    }
  ]
}

export const storageFileExpiry: DocSection = {
  id: 'file-expiry',
  label: 'File Expiry & Cleanup',
  content: [
    { type: 'h1', id: 'file-expiry', text: 'File Expiry & Cleanup' },
    {
      type: 'p',
      text: 'Files can be given an `expires_at` timestamp — useful for temporary exports, generated PDFs, and short-lived shares. An hourly cron job prunes expired files from both the database and the storage backend.'
    },
    {
      type: 'pre',
      code: `PATCH /api/files/:id
{ "expires_at": "2026-07-01T00:00:00Z" }

// Clear expiry (keep forever):
{ "expires_at": null }`
    },
    {
      type: 'ul',
      items: [
        'Expired files 404 immediately even before the cleanup pass removes the bytes.',
        'The cleanup cron runs hourly and deletes both the metadata row and the stored object (local, S3, or Azure).'
      ]
    }
  ]
}

export const storagePdfTemplates: DocSection = {
  id: 'pdf-generation',
  label: 'PDF Generation',
  content: [
    { type: 'h1', id: 'pdf-generation', text: 'PDF Generation' },
    {
      type: 'p',
      text: "Design Liquid-templated PDF documents (quotes, reports, confirmations) in the /pdf-templates admin page, then render them against any record. Templates are stored in `nivaro_pdf_templates` and rendered server-side with full access to the record's data, relations, and your Liquid filters."
    },
    {
      type: 'pre',
      code: `// Render a template against data
POST /api/pdf-templates/:id/render
{
  "collection": "orders",
  "item": "42"
}
// → application/pdf binary response

// Templates use Liquid:
<h1>Order {{ item.order_number }}</h1>
<p>Total: {{ item.total | money }}</p>
{% for line in item.lines %}<tr><td>{{ line.description }}</td></tr>{% endfor %}`
    },
    {
      type: 'ul',
      items: [
        'Manage templates (name, collection binding, Liquid body, page setup) at /pdf-templates.',
        'Render output can be returned inline or stored as a file (optionally with expires_at for temporary documents).',
        'Use from flows or extensions to attach generated PDFs to mails.'
      ]
    }
  ]
}
