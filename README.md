# Holocloth

A little browser tool for playing with holographic fabric.

You get a sheet of simulated cloth floating in space. You can grab it, throw it around, drape your own images over it, and watch them ripple like they're printed on holo foil. When it looks good — export a PNG.

![Holocloth](docs/preview.jpg)

## What it does

- **Real cloth physics** — grab the sheet and pull. It wrinkles, settles, and floats like fabric in gel. Written from scratch (Verlet integration, no physics library).
- **Holographic material** — an iridescent foil shader with rainbow diffraction, sparkle, and bump maps. Also chrome and black cloth presets.
- **Your images** — upload any image or SVG and it becomes the cloth, or a sticker on top of it. Everything bends and folds with the fabric.
- **Camera looks** — macro depth of field (click to pick a focus point), ambient occlusion in the folds, film grain, bloom.
- **Export** — one click PNG, with or without the background.
- **Versions** — save looks and switch between them while you work.

## Website version

This fork is set up to be embedded on a website (e.g. a Readymag embed/iframe):

- **No rainbow** — holo diffraction, iridescence, specular tint and the cyan/pink rim lights are all off by default, so the cloth shows the graphic in its own colors.
- **Transparent background** — the page behind the embed shows through. Turn it off with `render → transparent` to use the `background` color instead.
- **Panel hidden** — visitors just see the cloth. Add `?controls` to the URL (e.g. `https://your-site.vercel.app/?controls`) to bring the panel back for tweaking; to make a change permanent, copy the values into the defaults in `src/App.tsx`.
- **Your graphic** — the cloth image is `public/holo-bg-2.jpg`; replace that file to change it.

To publish: `npm run build`, then deploy the `dist/` folder (or import the repo into Vercel), and embed the deployed URL in an iframe.

## One-word guestbook (`/word`)

A second page in the same Vercel project: visitors **draw a word** describing your work, it's read with Claude (handwriting → text), they confirm it, and it's saved to a Redis database you can read at **`/admin`**.

| Path | What it is |
|---|---|
| `/word` | The drawing widget — embed this in Readymag (iframe) |
| `/admin` | Your private dashboard: word counts, every drawing, delete, CSV export |
| `api/recognize.ts` | Reads the drawing with Claude, returns the word |
| `api/words.ts` | Saves an entry (POST), lists them (GET, admin), deletes one (DELETE, admin) |

### Setup on Vercel

1. **Database** — in the Vercel project, *Storage → Create → Upstash (Redis)* and connect it to this project. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. (A plain Upstash database with `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` works too.)
2. **Environment variables** (*Settings → Environment Variables*):
   - `ANTHROPIC_API_KEY` — from https://platform.claude.com
   - `ADMIN_PASSWORD` — any long password; you'll type it on `/admin`
3. Redeploy.

### Embed in Readymag

Add an *Embed / Code* widget with:

```html
<iframe src="https://your-site.vercel.app/word" style="width:100%;height:100%;border:0;background:transparent" allowtransparency="true"></iframe>
```

URL options (combine with `&`): `?theme=dark`, `?ink=%23ff3366` (stroke/button colour), `?bg=%23000000` (page background, transparent by default), `?prompt=One%20word%20for%20my%20work` (the question text), `?font=Georgia`, `?smooth=0-100` (Photoshop-style brush smoothing, default 45).

### Notes

- Each recognition is one small vision request (~1–2k tokens). Requests are rate-limited per IP (15 reads and 5 submissions per minute).
- Up to 5,000 most recent entries are kept, with the drawing (a small PNG) alongside each word; the word counts are kept separately and never trimmed.
- Local development of the API needs the Vercel CLI: `npx vercel link`, `npx vercel env pull .env.local`, `npx vercel dev`.

## Controls

| Action | How |
|---|---|
| Grab the cloth | Click + drag on it |
| Orbit the camera | Drag empty space |
| Pan | Hold `Space` + drag, or right-drag |
| Zoom | Scroll |
| Move a sticker | Turn on `Edit` in the Images panel, then drag it |

## Run it

One line (needs Node 20+ and git):

```bash
git clone https://github.com/dmitrykurash/holocloth.git && cd holocloth && npm install && npm run dev
```

Then open the local URL Vite prints — usually `http://localhost:5199`.

## Tech

- [Three.js](https://threejs.org) (WebGL 2) — rendering
- [React](https://react.dev) + TypeScript + [Vite](https://vite.dev)
- Custom GLSL: the holo foil shader, a circle-of-confusion depth of field pass, film grain
- Custom cloth simulation: Verlet integration with structural, shear, and bend constraints
- [DialKit](https://github.com/joshpuckett/dialkit) by [Josh Puckett](https://x.com/joshpuckett) — the control panel UI

## Credits

Made by [Dmitry Kurash](https://x.com/DmitryKurash).

UI powered by [DialKit](https://github.com/joshpuckett/dialkit) — a lovely little library by [Josh Puckett](https://x.com/joshpuckett) for dialing in interface parameters.
