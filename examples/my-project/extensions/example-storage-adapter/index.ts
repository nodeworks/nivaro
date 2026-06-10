/**
 * Example S3-compatible storage adapter.
 * Install: pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
 *
 * Required env vars:
 *   S3_BUCKET, S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 */
import type { Extension, StorageAdapter } from '@nivaro/api/extensions/loader'
import type { StorageFileMeta } from '@nivaro/api/extensions/storage-adapters'

const extension: Extension = {
  id: 'example-storage-adapter',

  async register({ storage, logger }) {
    const bucket = process.env.S3_BUCKET
    const region = process.env.S3_REGION ?? 'us-east-1'

    if (!bucket) {
      logger.warn('S3_BUCKET not set — S3 storage adapter disabled')
      return
    }

    // Lazy-import so the extension won't crash if the SDK isn't installed
    const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import(
      '@aws-sdk/client-s3'
    )
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')

    const client = new S3Client({ region })

    const adapter: StorageAdapter = {
      async put(key, stream, meta: StorageFileMeta) {
        const chunks: Buffer[] = []
        for await (const chunk of stream)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: Buffer.concat(chunks),
            ContentType: meta.mimetype
          })
        )
      },

      async get(key) {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        return res.Body as NodeJS.ReadableStream
      },

      async delete(key) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      },

      async url(key) {
        const cmd = new GetObjectCommand({ Bucket: bucket, Key: key })
        return getSignedUrl(client, cmd, { expiresIn: 3600 })
      }
    }

    storage.register('s3', adapter)
    storage.setActive('s3')
    logger.info({ bucket, region }, 'S3 storage adapter active')
  }
}

export default extension
