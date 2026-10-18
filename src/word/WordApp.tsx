import { useCallback, useEffect, useRef, useState } from 'react';
import { getStroke, type StrokeOptions } from 'perfect-freehand';

type Point = [x: number, y: number, pressure: number];
interface Stroke {
  points: Point[];
  pen: boolean; // real stylus pressure vs. pressure simulated from speed
  path?: Path2D; // cached once the stroke is finished
}
type Phase =
  | { name: 'draw' }
  | { name: 'reading' }
  | { name: 'confirm'; word: string; image: string }
  | { name: 'saving'; word: string; image: string }
  | { name: 'done'; word: string };

const params = new URLSearchParams(location.search);
const PROMPT = params.get('prompt') ?? 'Describe my work in one word';
const STROKE_SIZE = 9;

function strokeLength({ points }: Stroke): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return length;
}

// Ink feel: streamline trails the pointer slightly so jitter is absorbed, and
// thinning varies the width with speed (or pen pressure) like a brush pen.
function strokeOptions(stroke: Stroke, last: boolean): StrokeOptions {
  // Short marks (dots on an i, full stops) skip the tapers so they stay visible.
  const short = strokeLength(stroke) < STROKE_SIZE * 4;
  return {
    size: STROKE_SIZE,
    thinning: 0.6,
    smoothing: 0.65,
    streamline: 0.55,
    easing: (t) => Math.sin((t * Math.PI) / 2),
    simulatePressure: !stroke.pen,
    start: { taper: short ? 0 : 6, cap: true },
    end: { taper: short ? 0 : 14, cap: true },
    last,
  };
}

// Outline polygon → closed path of quadratic curves through the midpoints.
function strokePath(stroke: Stroke, last: boolean): Path2D {
  const outline = getStroke(stroke.points, strokeOptions(stroke, last));
  const path = new Path2D();
  if (outline.length < 2) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

function pathFor(stroke: Stroke, finished: boolean): Path2D {
  if (finished) return (stroke.path ??= strokePath(stroke, true));
  return strokePath(stroke, false);
}

// Crop the drawing to its bounds and render it black-on-white at a small size,
// which is both what the recogniser reads best and cheap to store.
function exportDrawing(strokes: Stroke[]): string {
  const pts = strokes.flatMap((s) => s.points);
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  const pad = STROKE_SIZE * 3;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const scale = Math.min(1, 640 / Math.max(w, h));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(pad - minX, pad - minY);
  ctx.fillStyle = '#000';
  strokes.forEach((s) => ctx.fill(pathFor(s, true)));
  return canvas.toDataURL('image/png');
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
  return data as T;
}

export default function WordApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const activeRef = useRef<Stroke | null>(null);
  const frameRef = useRef(0);
  const [strokeCount, setStrokeCount] = useState(0);
  const [phase, setPhase] = useState<Phase>({ name: 'draw' });
  const [error, setError] = useState<string | null>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = getComputedStyle(canvas).color;
    for (const stroke of strokesRef.current) {
      ctx.fill(pathFor(stroke, stroke !== activeRef.current));
    }
  }, []);

  // Coalesce pointer events into one paint per display frame.
  const scheduleRedraw = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      redraw();
    });
  }, [redraw]);

  // Keep the backing store sized to the element at device resolution.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      redraw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameRef.current);
    };
  }, [redraw]);

  const locked = phase.name !== 'draw';

  const pointFrom = (ev: PointerEvent, rect: DOMRect, pen: boolean): Point => [
    ev.clientX - rect.left,
    ev.clientY - rect.top,
    pen ? ev.pressure : 0.5,
  ];

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (locked || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pen = e.pointerType === 'pen' && e.pressure > 0;
    const stroke: Stroke = {
      points: [pointFrom(e.nativeEvent, e.currentTarget.getBoundingClientRect(), pen)],
      pen,
    };
    activeRef.current = stroke;
    strokesRef.current.push(stroke);
    setError(null);
    scheduleRedraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = activeRef.current;
    if (!stroke) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    const rect = e.currentTarget.getBoundingClientRect();
    for (const ev of events.length ? events : [e.nativeEvent]) {
      stroke.points.push(pointFrom(ev, rect, stroke.pen));
    }
    scheduleRedraw();
  };

  const onPointerUp = () => {
    if (!activeRef.current) return;
    activeRef.current = null;
    setStrokeCount(strokesRef.current.length);
    scheduleRedraw(); // repaint with the finished taper
  };

  const clear = () => {
    strokesRef.current = [];
    activeRef.current = null;
    setStrokeCount(0);
    setError(null);
    setPhase({ name: 'draw' });
    scheduleRedraw();
  };

  const undo = () => {
    strokesRef.current.pop();
    setStrokeCount(strokesRef.current.length);
    scheduleRedraw();
  };

  const read = async () => {
    if (strokesRef.current.length === 0) return;
    const image = exportDrawing(strokesRef.current);
    setPhase({ name: 'reading' });
    setError(null);
    try {
      const { word } = await post<{ word: string }>('/api/recognize', { image });
      setPhase({ name: 'confirm', word, image });
    } catch (err) {
      setError((err as Error).message);
      setPhase({ name: 'draw' });
    }
  };

  const submit = async () => {
    if (phase.name !== 'confirm') return;
    const { word, image } = phase;
    setPhase({ name: 'saving', word, image });
    setError(null);
    try {
      await post('/api/words', { word, image });
      setPhase({ name: 'done', word });
    } catch (err) {
      setError((err as Error).message);
      setPhase({ name: 'confirm', word, image });
    }
  };

  return (
    <main className="word">
      <p className="word__prompt">{PROMPT}</p>

      <div className={`word__pad${locked ? ' is-locked' : ''}${phase.name === 'done' ? ' is-done' : ''}`}>
        <canvas
          ref={canvasRef}
          className="word__canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="Drawing area — write one word"
        />
        {strokeCount === 0 && phase.name === 'draw' && (
          <span className="word__hint" aria-hidden>
            write here
          </span>
        )}
        {phase.name === 'done' && (
          <div className="word__overlay">
            <span className="word__result">{phase.word}</span>
            <span className="word__thanks">Thank you — noted.</span>
          </div>
        )}
      </div>

      <div className="word__bar" aria-live="polite">
        {phase.name === 'draw' && (
          <>
            <button type="button" className="word__btn" onClick={undo} disabled={strokeCount === 0}>
              Undo
            </button>
            <button type="button" className="word__btn" onClick={clear} disabled={strokeCount === 0}>
              Clear
            </button>
            <button
              type="button"
              className="word__btn word__btn--primary"
              onClick={read}
              disabled={strokeCount === 0}
            >
              Done
            </button>
          </>
        )}

        {phase.name === 'reading' && <span className="word__status">Reading your handwriting…</span>}

        {(phase.name === 'confirm' || phase.name === 'saving') && (
          <>
            <span className="word__status">
              Did you write <strong>“{phase.word}”</strong>?
            </span>
            <button type="button" className="word__btn" onClick={clear} disabled={phase.name === 'saving'}>
              Redraw
            </button>
            <button
              type="button"
              className="word__btn word__btn--primary"
              onClick={submit}
              disabled={phase.name === 'saving'}
            >
              {phase.name === 'saving' ? 'Sending…' : 'Yes, send'}
            </button>
          </>
        )}

        {phase.name === 'done' && (
          <button type="button" className="word__btn" onClick={clear}>
            Write another
          </button>
        )}
      </div>

      {error && <p className="word__error">{error}</p>}
    </main>
  );
}
