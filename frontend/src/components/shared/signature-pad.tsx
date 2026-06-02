'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface SignaturePadHandle {
  /** ``null`` when nothing has been drawn (or after ``clear()``). */
  toBlob: () => Promise<Blob | null>;
  /** Wipes the canvas and clears the "has drawn" latch. */
  clear: () => void;
  /** ``true`` until the first stroke is recorded. */
  isEmpty: () => boolean;
}

interface SignaturePadProps {
  /** Legacy callback — receives a PNG data URL on pointer-up, empty string on clear. */
  onChange?: (dataUrl: string) => void;
  /** Called once after the first stroke begins. Useful for enabling submit. */
  onFirstStroke?: () => void;
  className?: string;
  /** Visual height in CSS px (canvas backing buffer scales with DPR). */
  height?: number;
}

/**
 * Lightweight canvas signature pad used by every e-sign flow.
 * Pointer events cover mouse + touch + pen without an external dep.
 *
 * Two APIs available depending on the caller's needs:
 *   * Legacy ``onChange(dataUrl)`` — fires on stroke-up with a PNG data
 *     URL (or empty string on clear). Kept for the prototype dialogs
 *     that integrate via react-hook-form.
 *   * Imperative ref ``toBlob() / clear() / isEmpty()`` — preferred for
 *     the new ``PasswordReauthDialog`` that hands the blob straight to
 *     ``uploadSignature`` without a base64 round-trip.
 *
 * Canvas backing buffer is sized to ``devicePixelRatio`` so the
 * exported PNG stays crisp on high-DPI screens.
 */
export const SignaturePad = React.forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad(
    { onChange, onFirstStroke, className, height = 140 },
    ref,
  ) {
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const drawing = React.useRef(false);
    const last = React.useRef<{ x: number; y: number } | null>(null);
    const hasDrawnRef = React.useRef(false);
    const [empty, setEmpty] = React.useState(true);

    const getCtx = React.useCallback(() => {
      const c = canvasRef.current;
      if (!c) return null;
      return c.getContext('2d');
    }, []);

    // Initialize canvas to device-pixel resolution.
    React.useEffect(() => {
      const c = canvasRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = c.getBoundingClientRect();
      c.width = rect.width * dpr;
      c.height = rect.height * dpr;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2;
      ctx.strokeStyle = getComputedStyle(c).getPropertyValue('--ink').trim() || '#0a0a0a';
    }, []);

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      drawing.current = true;
      const rect = e.currentTarget.getBoundingClientRect();
      last.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      e.currentTarget.setPointerCapture(e.pointerId);
      if (!hasDrawnRef.current) {
        hasDrawnRef.current = true;
        onFirstStroke?.();
      }
    };

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawing.current || !last.current) return;
      const ctx = getCtx();
      if (!ctx) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      ctx.beginPath();
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(x, y);
      ctx.stroke();
      last.current = { x, y };
      if (empty) setEmpty(false);
    };

    const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      drawing.current = false;
      last.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* may not have been captured (touch cancelled). */
      }
      const c = canvasRef.current;
      if (c && onChange) onChange(c.toDataURL('image/png'));
    };

    const clear = React.useCallback(() => {
      const c = canvasRef.current;
      const ctx = getCtx();
      if (!c || !ctx) return;
      // Wipe the full backing buffer regardless of DPR scaling.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.restore();
      hasDrawnRef.current = false;
      setEmpty(true);
      onChange?.('');
    }, [getCtx, onChange]);

    React.useImperativeHandle(
      ref,
      () => ({
        toBlob: async () => {
          const c = canvasRef.current;
          if (!c || !hasDrawnRef.current) return null;
          return new Promise<Blob | null>((resolve) =>
            c.toBlob((b) => resolve(b), 'image/png'),
          );
        },
        clear,
        isEmpty: () => !hasDrawnRef.current,
      }),
      [clear],
    );

    return (
      <div className={cn('w-full', className)}>
        <div className="relative overflow-hidden rounded-md border border-border-strong bg-bg-elev">
          <canvas
            ref={canvasRef}
            aria-label="Signature canvas"
            role="img"
            className="block w-full touch-none cursor-crosshair"
            style={{ height }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {empty && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-text-3"
            >
              Sign here
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-text-3">
          <span>Drawn signature is stored on the audit row alongside your password.</span>
          <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={empty}>
            Clear
          </Button>
        </div>
      </div>
    );
  },
);
