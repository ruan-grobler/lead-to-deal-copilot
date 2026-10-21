import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-signature';

/** `sha256=<hex>` HMAC of the raw request body, the format most webhook senders use. */
export const signBody = (secret: string, body: string | Uint8Array): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export const verifySignature = (secret: string, body: Uint8Array, header: string | undefined): boolean => {
  if (!header) {
    return false;
  }
  const expected = Buffer.from(signBody(secret, body));
  const received = Buffer.from(header.trim());
  return expected.length === received.length && timingSafeEqual(expected, received);
};
