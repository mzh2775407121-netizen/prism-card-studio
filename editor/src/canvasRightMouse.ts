import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { Camera } from './canvasNavigation';

type Point = { x: number; y: number };
type CameraControls = {
  read: () => Camera;
  capture: () => Camera | null;
  write: (camera: Camera | null) => void;
};
type TextSelection = {
  input: HTMLTextAreaElement;
  text: string;
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
};
type Gesture = {
  id: number;
  start: Point;
  last: Point;
  camera: Camera;
  previous: Camera | null;
  dragging: boolean;
  cancelled: boolean;
  selection?: TextSelection;
  detach: () => void;
};

const position = (event: { clientX: number; clientY: number }) => ({ x: event.clientX, y: event.clientY });
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const DRAG_DISTANCE = 4;

export function useCanvasRightMouse(camera: CameraControls, setPanning: (value: boolean) => void, onStartPan: () => void) {
  const active = useRef<Gesture | null>(null);
  const handled = useRef<{ start: Point; end: Point; time: number; selection?: TextSelection } | null>(null);

  useEffect(() => {
    // Some browsers dispatch contextmenu on press, others dispatch it after release.
    const suppressContextMenu = (event: MouseEvent) => {
      if (event.button !== 2) return;
      const last = handled.current;
      const point = position(event);
      if (!active.current && (!last || performance.now() - last.time > 500 ||
        Math.min(distance(last.start, point), distance(last.end, point)) > DRAG_DISTANCE)) return;
      event.preventDefault();
      event.stopPropagation();
      // WebKit can collapse an active textarea's selection before dispatching contextmenu.
      const selection = active.current?.selection ?? last?.selection;
      if (selection && document.activeElement === selection.input && selection.input.value === selection.text &&
        (selection.input.selectionStart !== selection.start || selection.input.selectionEnd !== selection.end)) {
        selection.input.setSelectionRange(selection.start, selection.end, selection.direction);
      }
    };
    const clearHandled = () => { handled.current = null; };
    window.addEventListener('contextmenu', suppressContextMenu, true);
    window.addEventListener('pointerdown', clearHandled, true);
    return () => {
      window.removeEventListener('contextmenu', suppressContextMenu, true);
      window.removeEventListener('pointerdown', clearHandled, true);
      active.current?.detach();
    };
  }, []);

  const begin = (event: ReactPointerEvent<HTMLDivElement>, openMenu: (screen: Point) => void) => {
    const element = event.currentTarget;
    const start = position(event);
    const input = document.activeElement;
    const selection = input instanceof HTMLTextAreaElement && element.contains(input) && input.closest('[data-canvas-text-editor]')
      ? { input, text: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }
      : undefined;
    const gesture: Gesture = {
      id: event.pointerId, start, last: start, camera: camera.read(), previous: camera.capture(),
      dragging: false, cancelled: false, selection,
      detach() {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', release, true);
        window.removeEventListener('pointercancel', interruptPointer, true);
        window.removeEventListener('keydown', escape, true);
        window.removeEventListener('blur', interrupt);
        document.removeEventListener('visibilitychange', onVisibility);
      },
    };
    function update(point: Point) {
      gesture.last = point;
      if (gesture.cancelled) return;
      if (!gesture.dragging) {
        if (distance(gesture.start, point) < DRAG_DISTANCE) return;
        gesture.dragging = true;
        onStartPan();
        setPanning(true);
      }
      const x = gesture.camera.x + point.x - gesture.start.x;
      const y = gesture.camera.y + point.y - gesture.start.y;
      const current = camera.read();
      if (current.x !== x || current.y !== y) camera.write({ ...gesture.camera, x, y });
    }
    function move(next: PointerEvent) {
      if (next.pointerId !== gesture.id) return;
      next.stopPropagation();
      if (next.buttons & 2) update(position(next));
      else finish();
    }
    function release(next: PointerEvent) {
      if (next.pointerId !== gesture.id || next.button !== 2) return;
      next.stopPropagation();
      update(position(next));
      finish();
      if (!gesture.dragging && !gesture.cancelled) openMenu(gesture.last);
    }
    function finish() {
      if (active.current !== gesture) return;
      active.current = null;
      handled.current = { start, end: gesture.last, time: performance.now(), selection };
      gesture.detach();
      if (element.hasPointerCapture(gesture.id)) element.releasePointerCapture(gesture.id);
      setPanning(false);
    }
    function interruptPointer(next: PointerEvent) {
      if (next.pointerId === gesture.id) finish();
    }
    function interrupt() { finish(); }
    function onVisibility() { if (document.hidden) finish(); }
    function escape(key: KeyboardEvent) {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      key.stopImmediatePropagation();
      gesture.cancelled = true;
      if (gesture.dragging) camera.write(gesture.previous);
      setPanning(false);
    }

    event.preventDefault();
    event.stopPropagation();
    active.current = gesture;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', interruptPointer, true);
    // Run before the editor's Escape handler for selection and path editing.
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', interrupt);
    document.addEventListener('visibilitychange', onVisibility);
    element.setPointerCapture(gesture.id);
  };
  return { begin, isActive: () => active.current !== null };
}
