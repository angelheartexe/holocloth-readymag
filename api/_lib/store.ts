import { Redis } from '@upstash/redis';
import { timingSafeEqual } from 'node:crypto';

// Works with either the Upstash integration from the Vercel Marketplace
// (KV_REST_API_*) or a plain Upstash database (UPSTASH_REDIS_REST_*).
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis = url && token ? new Redis({ url, token }) : null;

export const ENTRIES_KEY = 'words:entries';
export const COUNTS_KEY = 'words:counts';
export const MAX_ENTRIES = 5000;

export interface Entry {
  id: string;
  word: string;
  image: string; // PNG data URL of the drawing
  createdAt: string;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

// Fixed-window limiter: `limit` requests per IP per minute for a given bucket.
// Returns true when the request should be rejected.
export async function rateLimited(request: Request, bucket: string, limit: number): Promise<boolean> {
  if (!redis) return false;
  const key = `rl:${bucket}:${clientIp(request)}:${Math.floor(Date.now() / 60_000)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count > limit;
}

export function isAdmin(request: Request): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Keep stored words tidy: lowercase letters (any script), hyphens, apostrophes.
export function cleanWord(raw: string): string {
  const first = raw.trim().split(/\s+/)[0] ?? '';
  return first
    .toLowerCase()
    .replace(/[^\p{L}'-]/gu, '')
    .replace(/^['-]+|['-]+$/g, '')
    .slice(0, 32);
}

const MAX_IMAGE_BYTES = 300_000;

export function isValidImage(image: unknown): image is string {
  return (
    typeof image === 'string' &&
    image.startsWith('data:image/png;base64,') &&
    image.length <= MAX_IMAGE_BYTES
  );
}
