import 'server-only';
import { z } from 'zod';
import { assertAppleEnvironment } from './environment';

const appleId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,199}$/);
const identifier = z.string().regex(/^[A-Z0-9]{10}$/);
const headerSchema = z.object({ alg: z.literal('ES256'), kid: identifier, typ: z.literal('JWT').optional() }).strict();
const claimsSchema = z.object({
  iss: identifier, sub: appleId, aud: z.literal('https://appleid.apple.com'),
  iat: z.number().int().positive(), exp: z.number().int().positive(),
}).strict();
const MAX_CLIENT_SECRET_AGE = 15_777_000;

function decodePart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid JWT encoding');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error('Noncanonical JWT encoding');
  return decoded;
}

/** Server configuration preflight, not user-token verification. Apple verifies this signed client
 * credential during exchange; NextAuth verifies the returned user's signed identity token.
 * The .p8 private key is never loaded here. Optional Apple failures must leave Google available. */
export function getAppleAuthConfig(now = new Date()): { clientId: string; clientSecret: string } | undefined {
  if (process.env.APPLE_AUTH_ENABLED !== 'true') return undefined;
  try {
    const clientId = appleId.parse(process.env.APPLE_CLIENT_ID?.trim());
    assertAppleEnvironment(clientId);
    const origin = new URL(process.env.NEXTAUTH_URL ?? '');
    if (origin.protocol !== 'https:' || origin.origin !== process.env.NEXTAUTH_URL?.trim()
      || origin.hostname === 'localhost' || origin.hostname.endsWith('.localhost') || /^\[|^[\d.]+$/.test(origin.hostname)) return undefined;
    const clientSecret = process.env.APPLE_CLIENT_SECRET?.trim();
    if (!clientSecret || clientSecret.length > 8192) return undefined;
    const parts = clientSecret.split('.');
    if (parts.length !== 3) return undefined;
    headerSchema.parse(JSON.parse(decodePart(parts[0]).toString('utf8')));
    const claims = claimsSchema.parse(JSON.parse(decodePart(parts[1]).toString('utf8')));
    // ES256 uses a 64-byte JOSE R || S signature; this only checks format, not its authenticity.
    if (decodePart(parts[2]).length !== 64) return undefined;
    const seconds = Math.floor(now.getTime() / 1000);
    if (!Number.isSafeInteger(seconds) || claims.sub !== clientId || claims.iat > seconds + 60
      || claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > MAX_CLIENT_SECRET_AGE) return undefined;
    return { clientId, clientSecret };
  } catch {
    // Never log JWTs, private keys, decoded claims, or validation error inputs.
    return undefined;
  }
}
