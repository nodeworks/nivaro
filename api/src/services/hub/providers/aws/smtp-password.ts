import { createHmac } from 'node:crypto'

/**
 * The SES SMTP password for an IAM access key, by AWS's documented algorithm (SigV4 signing key
 * for date 11111111, service `ses`, message `SendRawEmail`, version byte 0x04, base64). It is
 * region specific: the password for us-east-1 does not work against another region's endpoint.
 * The SMTP user name is the access key id. Pure; the secret never leaves this function except as
 * the derived password.
 */
export function sesSmtpPassword(secretAccessKey: string, region: string): string {
  const hmac = (key: Buffer | string, message: string) =>
    createHmac('sha256', key).update(message, 'utf8').digest()
  let k = hmac(`AWS4${secretAccessKey}`, '11111111')
  k = hmac(k, region)
  k = hmac(k, 'ses')
  k = hmac(k, 'aws4_request')
  k = hmac(k, 'SendRawEmail')
  return Buffer.concat([Buffer.from([0x04]), k]).toString('base64')
}

/** The SMTP endpoint of a region (STARTTLS on 587). */
export const sesSmtpHost = (region: string) => `email-smtp.${region}.amazonaws.com`
