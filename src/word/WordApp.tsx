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
// Smoothing strength, 0–100 like Photoshop's slider (?smooth=60 to override).
const SMOOTHING = Math.min(100, Math.max(0, Number(params.get('smooth') ?? 45)));
const STRING_LENGTH = SMOOTHING * 0.5; // px the cursor can wander before the ink follows
const CATCH_UP = 0.25 - SMOOTHING * 0.0015; // share of the gap the ink closes each frame

function strokeLength({ points }: Stroke): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return length;
}

// Ink feel: thinning varies the width with pressure — real pen pressure, or
// one derived from hand speed (see speedPressure) — like a brush pen.
function strokeOptions(stroke: Stroke, last: boolean): StrokeOptions {
  return {
    size: STROKE_SIZE,
    thinning: 0.5,
    smoothing: 0.7,
    streamline: 0.3, // light extra smoothing; the lazy brush does the heavy lifting
    easing: (t) => Math.sin((t * Math.PI) / 2),
    simulatePressure: false,
    start: { taper: 0, cap: true },
    // Grows with the stroke so dots stay round and nothing jumps mid-stroke.
    end: { taper: Math.min(14, strokeLength(stroke) * 0.3), cap: true },
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

  // Photoshop-style "lazy brush": the ink sits at the end of a short, invisible
  // string behind the cursor. Small wobbles inside the string's reach never reach the
  // ink, and the ink eases in to catch up whenever you slow down or let go.
  const cursorRef = useRef<Point | null>(null);
  const brushRef = useRef<Point | null>(null);
  const pressureRef = useRef(0.5);
  const lastMoveRef = useRef<{ x: number; y: number; time: number } | null>(null);

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

  // Move the ink towards `target`, laying down points every couple of pixels
  // so the stroke outline stays round on long jumps.
  const moveBrushTo = (stroke: Stroke, target: Point) => {
    const brush = brushRef.current!;
    const dist = Math.hypot(target[0] - brush[0], target[1] - brush[1]);
    const steps = Math.max(1, Math.ceil(dist / 2));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      stroke.points.push([
        brush[0] + (target[0] - brush[0]) * t,
        brush[1] + (target[1] - brush[1]) * t,
        brush[2] + (target[2] - brush[2]) * t,
      ]);
    }
    brushRef.current = target;
  };

  // Each frame while drawing, ease the ink part of the way to the cursor.
  const tick = useCallback(() => {
    const stroke = activeRef.current;
    const cursor = cursorRef.current;
    const brush = brushRef.current;
    if (!stroke || !cursor || !brush) return;
    const dist = Math.hypot(cursor[0] - brush[0], cursor[1] - brush[1]);
    if (dist > 0.5) {
      moveBrushTo(stroke, [
        brush[0] + (cursor[0] - brush[0]) * CATCH_UP,
        brush[1] + (cursor[1] - brush[1]) * CATCH_UP,
        cursor[2],
      ]);
    }
    redraw();
    frameRef.current = requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Without a stylus, fake pressure from hand speed: slow = full, fast = thin,
  // eased so the width swells and thins gradually instead of flickering.
  const speedPressure = (ev: PointerEvent): number => {
    const last = lastMoveRef.current;
    lastMoveRef.current = { x: ev.clientX, y: ev.clientY, time: ev.timeStamp };
    if (!last || ev.timeStamp <= last.time) return pressureRef.current;
    const speed = Math.hypot(ev.clientX - last.x, ev.clientY - last.y) / (ev.timeStamp - last.time);
    const target = Math.min(1, Math.max(0.3, 1 - speed / 2.5));
    pressureRef.current += (target - pressureRef.current) * 0.12;
    return pressureRef.current;
  };

  const pointFrom = (ev: PointerEvent, rect: DOMRect, pen: boolean): Point => [
    ev.clientX - rect.left,
    ev.clientY - rect.top,
    pen ? ev.pressure : speedPressure(ev),
  ];

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (locked || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pen = e.pointerType === 'pen' && e.pressure > 0;
    pressureRef.current = 0.6;
    lastMoveRef.current = null;
    const start = pointFrom(e.nativeEvent, e.currentTarget.getBoundingClientRect(), pen);
    const stroke: Stroke = { points: [start], pen };
    activeRef.current = stroke;
    strokesRef.current.push(stroke);
    cursorRef.current = start;
    brushRef.current = start;
    setStrokeCount(strokesRef.current.length);
    setError(null);
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(tick);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = activeRef.current;
    if (!stroke) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const rect = e.currentTarget.getBoundingClientRect();
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const cursor = pointFrom(ev, rect, stroke.pen);
      cursorRef.current = cursor;
      // Pulled string: the ink only moves once the cursor is further away
      // than the string length, and then trails exactly that far behind.
      const brush = brushRef.current!;
      const dx = cursor[0] - brush[0];
      const dy = cursor[1] - brush[1];
      const dist = Math.hypot(dx, dy);
      if (dist > STRING_LENGTH) {
        const k = (dist - STRING_LENGTH) / dist;
        moveBrushTo(stroke, [brush[0] + dx * k, brush[1] + dy * k, cursor[2]]);
      }
    }
  };

  const onPointerUp = () => {
    const stroke = activeRef.current;
    if (!stroke) return;
    // Catch up on stroke end: glide the ink the rest of the way to the cursor.
    const cursor = cursorRef.current;
    const brush = brushRef.current;
    if (cursor && brush) {
      let b = brush;
      for (let i = 0; i < 12; i++) {
        b = [b[0] + (cursor[0] - b[0]) * 0.35, b[1] + (cursor[1] - b[1]) * 0.35, cursor[2]];
        moveBrushTo(stroke, b);
      }
      moveBrushTo(stroke, cursor);
    }
    activeRef.current = null;
    cursorRef.current = null;
    brushRef.current = null;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
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
