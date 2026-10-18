import { randomUUID } from 'node:crypto';
import {
  COUNTS_KEY,
  ENTRIES_KEY,
  MAX_ENTRIES,
  cleanWord,
  isAdmin,
  isValidImage,
  json,
  rateLimited,
  redis,
  type Entry,
} from './_lib/store.js';

// POST /api/words  { word, image }  — a visitor submits their (confirmed) word.
export async function POST(request: Request): Promise<Response> {
  if (!redis) return json({ error: 'Storage is not configured.' }, 500);
  if (await rateLimited(request, 'submit', 5)) {
    return json({ error: 'Too many submissions — try again in a minute.' }, 429);
  }

  const body = (await request.json().catch(() => null)) as { word?: unknown; image?: unknown } | null;
  const word = typeof body?.word === 'string' ? cleanWord(body.word) : '';
  if (!word) return json({ error: 'Missing word.' }, 400);
  if (!isValidImage(body?.image)) return json({ error: 'Invalid drawing.' }, 400);

  const entry: Entry = {
    id: randomUUID(),
    word,
    image: body.image,
    createdAt: new Date().toISOString(),
  };

  await redis
    .pipeline()
    .lpush(ENTRIES_KEY, JSON.stringify(entry))
    .ltrim(ENTRIES_KEY, 0, MAX_ENTRIES - 1)
    .zincrby(COUNTS_KEY, 1, word)
    .exec();

  return json({ ok: true, word });
}

// GET /api/words  (Authorization: Bearer <ADMIN_PASSWORD>)  — read everything back.
export async function GET(request: Request): Promise<Response> {
  if (!redis) return json({ error: 'Storage is not configured.' }, 500);
  if (!isAdmin(request)) return json({ error: 'Unauthorized.' }, 401);

  const [rawEntries, rawCounts] = await Promise.all([
    redis.lrange<Entry | string>(ENTRIES_KEY, 0, -1),
    redis.zrange<(string | number)[]>(COUNTS_KEY, 0, -1, { rev: true, withScores: true }),
  ]);

  // @upstash/redis auto-parses JSON values; handle either shape.
  const entries = rawEntries.map((e) => (typeof e === 'string' ? (JSON.parse(e) as Entry) : e));
  const counts: { word: string; count: number }[] = [];
  for (let i = 0; i < rawCounts.length; i += 2) {
    counts.push({ word: String(rawCounts[i]), count: Number(rawCounts[i + 1]) });
  }

  return json({ total: entries.length, counts, entries });
}

// DELETE /api/words?id=<entry id>  (admin) — remove a single entry (e.g. spam).
export async function DELETE(request: Request): Promise<Response> {
  if (!redis) return json({ error: 'Storage is not configured.' }, 500);
  if (!isAdmin(request)) return json({ error: 'Unauthorized.' }, 401);

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ error: 'Missing id.' }, 400);

  const rawEntries = await redis.lrange<Entry | string>(ENTRIES_KEY, 0, -1);
  for (const raw of rawEntries) {
    const entry = typeof raw === 'string' ? (JSON.parse(raw) as Entry) : raw;
    if (entry.id !== id) continue;
    await redis
      .pipeline()
      .lrem(ENTRIES_KEY, 1, typeof raw === 'string' ? raw : JSON.stringify(raw))
      .zincrby(COUNTS_KEY, -1, entry.word)
      .zremrangebyscore(COUNTS_KEY, '-inf', 0)
      .exec();
    return json({ ok: true });
  }
  return json({ error: 'Not found.' }, 404);
}
