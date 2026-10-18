import { useCallback, useEffect, useRef, useState } from 'react';

type Point = { x: number; y: number };
type Stroke = Point[];
type Phase =
  | { name: 'draw' }
  | { name: 'reading' }
  | { name: 'confirm'; word: string; image: string }
  | { name: 'saving'; word: string; image: string }
  | { name: 'done'; word: string };

const params = new URLSearchParams(location.search);
const PROMPT = params.get('prompt') ?? 'Describe my work in one word';
const STROKE_WIDTH = 6;

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  if (stroke.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(stroke[0].x, stroke[0].y);
  if (stroke.length === 1) {
    ctx.lineTo(stroke[0].x + 0.01, stroke[0].y);
  } else {
    // Smooth the line by curving through midpoints between samples.
    for (let i = 1; i < stroke.length - 1; i++) {
      const mx = (stroke[i].x + stroke[i + 1].x) / 2;
      const my = (stroke[i].y + stroke[i + 1].y) / 2;
      ctx.quadraticCurveTo(stroke[i].x, stroke[i].y, mx, my);
    }
    const last = stroke[stroke.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
}

// Crop the drawing to its bounds and render it black-on-white at a small size,
// which is both what the recogniser reads best and cheap to store.
function exportDrawing(strokes: Stroke[]): string {
  const pts = strokes.flat();
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const pad = STROKE_WIDTH * 3;
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
  ctx.strokeStyle = '#000';
  ctx.lineWidth = STROKE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokes.forEach((s) => drawStroke(ctx, s));
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
    ctx.strokeStyle = getComputedStyle(canvas).color;
    ctx.lineWidth = STROKE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokesRef.current.forEach((s) => drawStroke(ctx, s));
  }, []);

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
    return () => observer.disconnect();
  }, [redraw]);

  const locked = phase.name !== 'draw';

  const pointFrom = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (locked || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const stroke = [pointFrom(e)];
    activeRef.current = stroke;
    strokesRef.current.push(stroke);
    setError(null);
    redraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = activeRef.current;
    if (!stroke) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    const rect = e.currentTarget.getBoundingClientRect();
    for (const ev of events) stroke.push({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
    redraw();
  };

  const onPointerUp = () => {
    if (!activeRef.current) return;
    activeRef.current = null;
    setStrokeCount(strokesRef.current.length);
  };

  const clear = () => {
    strokesRef.current = [];
    activeRef.current = null;
    setStrokeCount(0);
    setError(null);
    setPhase({ name: 'draw' });
    redraw();
  };

  const undo = () => {
    strokesRef.current.pop();
    setStrokeCount(strokesRef.current.length);
    redraw();
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
