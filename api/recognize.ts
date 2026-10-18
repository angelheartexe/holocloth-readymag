import Anthropic from '@anthropic-ai/sdk';
import { cleanWord, isValidImage, json, rateLimited } from './_lib/store.js';

const client = new Anthropic();

const PROMPT = `This image is a drawing made with a mouse or finger on a website. The visitor was asked to write ONE word describing a designer's portfolio.

Transcribe the handwritten word exactly as written (fix obvious letter-shape ambiguity, but don't substitute a different word). Reply with only the word, nothing else. If there is no legible word, reply with a single question mark.`;

// POST /api/recognize  { image: "data:image/png;base64,..." }  →  { word }
export async function POST(request: Request): Promise<Response> {
  if (await rateLimited(request, 'recognize', 15)) {
    return json({ error: 'Too many attempts — try again in a minute.' }, 429);
  }

  const body = (await request.json().catch(() => null)) as { image?: unknown } | null;
  if (!isValidImage(body?.image)) return json({ error: 'Invalid drawing.' }, 400);
  const data = body.image.slice('data:image/png;base64,'.length);

  try {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      return json({ error: "Couldn't read that — try writing it again." }, 422);
    }

    const text = response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    const word = cleanWord(text);
    if (!word) return json({ error: "Couldn't read that — try writing a bit bigger." }, 422);

    return json({ word });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return json({ error: 'Busy right now — try again in a moment.' }, 503);
    }
    console.error('recognize failed', error);
    return json({ error: 'Something went wrong reading your word.' }, 500);
  }
}
