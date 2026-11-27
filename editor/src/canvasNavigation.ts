import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

type Point = { x: number; y: number };
export type Camera = Point & { scale: number; fitScale: number };
type CameraChange = (camera: Camera) => Camera;
type SafariGestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };
type WheelZoom = { scale: number; anchor: Point; time: number };

const MIN_FIT_ZOOM = .1;
// Screen pixels per document unit (0.1 mm), independent of how many cards fit in the viewport.
const MAX_PIXEL_SCALE = 256;
const CHROMIUM_PINCH_SCALE = 100;
const WHEEL_ZOOM_SPEED = .002;
const WHEEL_ZOOM_RESPONSE_MS = 38;
const WHEEL_ZOOM_EPSILON = .001;
const WHEEL_TICK = 120;
const WHEEL_SEQUENCE_GAP = 160;

function hasWheelTick(event: WheelEvent & { wheelDeltaY?: number }) {
  // Pixel input can still carry a legacy detent signal on some browsers.
  const tick = Math.abs(event.wheelDeltaY ?? 0);
  const hasWholeTick = (value: number) => {
    const steps = Math.round(value / WHEEL_TICK);
    return steps > 0 && Math.abs(value - steps * WHEEL_TICK) < 1;
  };
  return hasWholeTick(tick) || hasWholeTick(tick * window.devicePixelRatio);
}

function clampScale(camera: Camera, scale: number) {
  return Math.min(MAX_PIXEL_SCALE, Math.max(camera.fitScale * MIN_FIT_ZOOM, scale));
}

function zoomCamera(camera: Camera, factor: number, anchor: Point): Camera {
  const scale = clampScale(camera, camera.scale * factor);
  if (scale === camera.scale) return camera;
  const ratio = scale / camera.scale;
  return { ...camera, scale, x: anchor.x + (camera.x - anchor.x) * ratio, y: anchor.y + (camera.y - anchor.y) * ratio };
}

function ownsCanvasInput(event: Event) {
  return !(event.target instanceof Element && event.target.closest('select,[role="listbox"],[role="menu"],[role="dialog"],.path-node-actions'));
}

function localPoint(bounds: DOMRectReadOnly, clientX?: number, clientY?: number): Point | undefined {
  if (clientX === undefined || clientY === undefined || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
  const x = clientX - bounds.left, y = clientY - bounds.top;
  if (x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height) return { x, y };
}

function takeOver(event: Event) {
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
}

export function useCanvasCamera(holder: RefObject<HTMLDivElement | null>, fittedCamera: Camera,
  isBusy: () => boolean, onNavigate: () => void, initial: Camera | null = null, wheelPan = false, magicMouseZoom = false) {
  const [manualCamera, setManualCamera] = useState<Camera | null>(initial);
  const latestCamera = useRef<Camera | null>(initial);
  const pendingCamera = useRef<Camera | undefined>(undefined);
  const wheelZoom = useRef<WheelZoom | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const live = useRef({ fittedCamera, isBusy, onNavigate, wheelPan, magicMouseZoom });
  useLayoutEffect(() => { live.current = { fittedCamera, isBusy, onNavigate, wheelPan, magicMouseZoom }; });

  const read = () => latestCamera.current ?? live.current.fittedCamera;
  const commit = (camera: Camera | null) => {
    latestCamera.current = camera;
    setManualCamera(camera);
  };
  const clearPending = () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    pendingCamera.current = undefined;
    wheelZoom.current = undefined;
  };
  const write = (camera: Camera | null) => {
    clearPending();
    commit(camera);
  };
  const flush = () => {
    const next = pendingCamera.current;
    clearPending();
    if (!next || live.current.isBusy()) return false;
    live.current.onNavigate();
    commit(next);
    return true;
  };
  const queue = (change: CameraChange) => {
    if (live.current.isBusy()) return;
    if (wheelZoom.current) clearPending();
    const previous = pendingCamera.current ?? read();
    const next = change(previous);
    if (next === previous) return;
    pendingCamera.current = next;
    frame.current ??= requestAnimationFrame(() => flushSync(flush));
  };
  const zoomAt = (factor: number, anchor: Point) => {
    if (Number.isFinite(factor) && factor > 0) queue(camera => zoomCamera(camera, factor, anchor));
  };
  const stepWheelZoom = (now: number) => {
    frame.current = undefined;
    const target = wheelZoom.current;
    if (!target || live.current.isBusy()) { clearPending(); return; }
    const camera = read();
    const elapsed = Math.min(48, Math.max(0, now - target.time));
    const remaining = Math.log(target.scale / camera.scale);
    const done = Math.abs(remaining) <= WHEEL_ZOOM_EPSILON;
    const fraction = done ? 1 : 1 - Math.exp(-elapsed / WHEEL_ZOOM_RESPONSE_MS);
    const next = zoomCamera(camera, Math.exp(remaining * fraction), target.anchor);
    if (next !== camera) {
      // Keep the visible camera and the camera read by input handlers on the same frame.
      flushSync(() => {
        live.current.onNavigate();
        commit(next);
      });
    }
    if (done) { wheelZoom.current = undefined; return; }
    target.time = now;
    frame.current = requestAnimationFrame(stepWheelZoom);
  };
  const smoothZoomAt = (factor: number, anchor: Point) => {
    if (factor === 1) return;
    if (pendingCamera.current) flush();
    const camera = read();
    const target = wheelZoom.current;
    const sameDirection = target && (target.scale - camera.scale) * (factor - 1) > 0;
    const scale = clampScale(camera, (sameDirection ? target.scale : camera.scale) * factor);
    if (scale === camera.scale) { clearPending(); return; }
    wheelZoom.current = { scale, anchor, time: target?.time ?? performance.now() };
    frame.current ??= requestAnimationFrame(stepWheelZoom);
  };
  const fit = () => {
    if (live.current.isBusy()) return;
    live.current.onNavigate();
    write(null);
  };

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    let recentPointer: Point | undefined;
    let safariGesture: { scale: number; anchor: Point } | undefined;
    let wheelSequence: { last: number; stepped: boolean } | undefined;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const resetPointer = () => { recentPointer = undefined; wheelSequence = undefined; };
    const aim = (clientX?: number, clientY?: number) => {
      const bounds = element.getBoundingClientRect();
      return localPoint(bounds, clientX, clientY) ?? localPoint(bounds, recentPointer?.x, recentPointer?.y) ??
        { x: bounds.width / 2, y: bounds.height / 2 };
    };
    const remember = (event: PointerEvent) => {
      recentPointer = { x: event.clientX, y: event.clientY };
      if (wheelZoom.current) wheelZoom.current.anchor = aim(event.clientX, event.clientY);
    };
    const wheel = (event: WheelEvent) => {
      if (!ownsCanvasInput(event)) return;
      takeOver(event);
      if (safariGesture || live.current.isBusy()) return;
      const unit = event.deltaMode;
      const deltaX = event.deltaX, deltaY = event.deltaY;
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (!deltaX && !deltaY)) return;
      const pixelY = deltaY * (unit === WheelEvent.DOM_DELTA_LINE ? 16 : unit === WheelEvent.DOM_DELTA_PAGE ? element.clientHeight : 1);
      const modifierZoom = event.ctrlKey || event.metaKey;
      const vertical = Math.abs(deltaY) > 3 * Math.abs(deltaX);
      const freeWheel = !modifierZoom && !live.current.wheelPan && !event.shiftKey;
      let stepped = unit !== WheelEvent.DOM_DELTA_PIXEL;
      if (!stepped && freeWheel && !live.current.magicMouseZoom) {
        // A continuous gesture may cross a whole-tick value as it accelerates.
        const previous = wheelSequence;
        const continuing = previous !== undefined && event.timeStamp - previous.last < WHEEL_SEQUENCE_GAP;
        stepped = vertical && (continuing ? previous.stepped : hasWheelTick(event));
        wheelSequence = { last: event.timeStamp, stepped };
      } else {
        wheelSequence = undefined;
      }
      const verticalZoom = freeWheel && vertical && (stepped || live.current.magicMouseZoom);
      if (modifierZoom || verticalZoom) {
        if (!pixelY) return;
        const anchor = aim(event.clientX, event.clientY);
        if (event.ctrlKey && unit === WheelEvent.DOM_DELTA_PIXEL) {
          // Chromium encodes pinch as a logarithmic pixel delta.
          zoomAt(Math.exp(-pixelY / CHROMIUM_PINCH_SCALE), anchor);
        } else {
          const factor = Math.exp(-Math.max(-240, Math.min(240, pixelY)) * WHEEL_ZOOM_SPEED);
          if (reduceMotion.matches) zoomAt(factor, anchor);
          else smoothZoomAt(factor, anchor);
        }
        return;
      }
      const horizontalFallback = event.shiftKey && deltaX === 0;
      const pixelX = (horizontalFallback ? deltaY : deltaX) * (unit === WheelEvent.DOM_DELTA_LINE ? 16 : unit === WheelEvent.DOM_DELTA_PAGE ? element.clientWidth : 1);
      const y = horizontalFallback ? 0 : pixelY;
      if (pixelX || y) queue(camera => ({ ...camera, x: camera.x - pixelX, y: camera.y - y }));
    };
    const startGesture = (event: SafariGestureEvent) => {
      if (!ownsCanvasInput(event)) return;
      takeOver(event);
      if (wheelZoom.current) clearPending();
      safariGesture = { scale: 1, anchor: aim(event.clientX, event.clientY) };
    };
    const changeGesture = (event: SafariGestureEvent) => {
      if (!safariGesture) return;
      takeOver(event);
      const scale = event.scale;
      if (scale === undefined || !Number.isFinite(scale) || scale <= 0) return;
      zoomAt(scale / safariGesture.scale, safariGesture.anchor);
      safariGesture.scale = scale;
    };
    const endGesture = (event: Event) => {
      if (!safariGesture) return;
      takeOver(event);
      safariGesture = undefined;
    };
    const interrupt = () => {
      safariGesture = undefined;
      resetPointer();
      clearPending();
    };
    const visibilityChanged = () => { if (document.hidden) interrupt(); };
    const options = { capture: true, passive: false };
    element.addEventListener('wheel', wheel, options);
    element.addEventListener('pointermove', remember, true);
    element.addEventListener('pointerleave', resetPointer);
    element.addEventListener('gesturestart', startGesture, options);
    window.addEventListener('gesturechange', changeGesture, options);
    window.addEventListener('gestureend', endGesture, options);
    window.addEventListener('blur', interrupt);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      interrupt();
      element.removeEventListener('wheel', wheel, true);
      element.removeEventListener('pointermove', remember, true);
      element.removeEventListener('pointerleave', resetPointer);
      element.removeEventListener('gesturestart', startGesture, true);
      window.removeEventListener('gesturechange', changeGesture, true);
      window.removeEventListener('gestureend', endGesture, true);
      window.removeEventListener('blur', interrupt);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [holder]);

  return { origin: manualCamera ?? fittedCamera, zoomAt, fit, read, write, capture: () => pendingCamera.current ?? latestCamera.current,
    hasPending: () => pendingCamera.current !== undefined || wheelZoom.current !== undefined, flush };
}
