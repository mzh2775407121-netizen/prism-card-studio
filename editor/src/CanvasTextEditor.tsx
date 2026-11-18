import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CardNode, SideName } from './model';
import { cardTextLayout } from './render';

let measurement: CanvasRenderingContext2D | null = null;
export function measureCanvasText(node: CardNode) {
  measurement ??= document.createElement('canvas').getContext('2d')!;
  return cardTextLayout(measurement, node);
}

export function expandedTextDraft(node: CardNode, text: string): CardNode {
  const draft = { ...node, text };
  const { contentHeight } = measureCanvasText(draft);
  const extra = Math.max(0, contentHeight - node.height);
  if (!extra) return draft;
  const angle = node.rotation * Math.PI / 180;
  // Mirroring stays around the stored box. Extra lines extend in the reflected
  // direction, without moving the original first line or changing saved geometry.
  return { ...draft, height: node.height + extra,
    x: node.x + (node.flipY ? Math.sin(angle) * extra : 0),
    y: node.y - (node.flipY ? Math.cos(angle) * extra : 0) };
}

function browserBaseline(font: string, lineHeight: number) {
  const line = document.createElement('div');
  Object.assign(line.style, { position: 'fixed', left: '-10000px', top: '0',
    visibility: 'hidden', whiteSpace: 'pre', font, lineHeight: `${lineHeight}px` });
  const marker = document.createElement('span');
  Object.assign(marker.style, { display: 'inline-block', width: '0', height: '0', verticalAlign: 'baseline' });
  line.append(document.createTextNode('Mg'), marker);
  document.body.append(line);
  const baseline = marker.getBoundingClientRect().top - line.getBoundingClientRect().top;
  line.remove();
  return baseline;
}

interface Props {
  node: CardNode;
  face: SideName;
  left: number;
  top: number;
  scale: number;
  onDraft: (text: string) => void;
  onCommit: (text: string) => void;
  onCancel: () => void;
  onWheel: (event: WheelEvent) => void;
}

/** Native input owns composition, clipboard and undo; the canvas paints the text. */
export default function CanvasTextEditor({ node, face, left, top, scale, onDraft, onCommit, onCancel, onWheel }: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const finished = useRef(false);
  const composing = useRef(false);
  const currentText = useRef(node.text || '');
  const callbacks = useRef({ onCommit, onCancel, onWheel });
  callbacks.current = { onCommit, onCancel, onWheel };
  const layout = measureCanvasText(node);
  const [baseline, setBaseline] = useState(layout.baselineOffset);
  const finish = (cancel = false) => {
    if (finished.current) return;
    finished.current = true;
    if (cancel) callbacks.current.onCancel();
    else callbacks.current.onCommit(input.current?.value ?? currentText.current);
  };

  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.setSelectionRange(0, currentText.current.length);
  }, []);
  useLayoutEffect(() => {
    let alive = true;
    const measure = () => { if (alive) setBaseline(browserBaseline(layout.font, layout.lineAdvance)); };
    measure();
    document.fonts.ready.then(measure);
    return () => { alive = false; };
  }, [layout.font, layout.lineAdvance]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || wrapper.current?.contains(target)) return;
      // Middle-button camera navigation leaves the editing session intact.
      if (event.button === 1 && target instanceof Element && target.closest('.editor-canvas')) return;
      finish();
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation(); callbacks.current.onWheel(event);
    };
    document.addEventListener('pointerdown', outside, true);
    const element = wrapper.current;
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      element?.removeEventListener('wheel', wheel);
    };
  }, []);

  const offset = layout.top + layout.baselineOffset - baseline;
  return <div ref={wrapper} className="canvas-text-editor" data-canvas-text-editor
    data-text-face={face} data-text-id={node.id}
    style={{ left, top, width: node.width, height: node.height,
      transform: `scale(${scale}) rotate(${node.rotation}deg)`,
      boxShadow: `0 0 0 ${1 / scale}px var(--prism-focus, #69b5f6)` }}>
    <div className="canvas-text-editor-reflection" style={{ width: node.width, height: node.height,
      transform: `translate(${node.flipX ? node.width : 0}px, ${node.flipY ? node.height : 0}px) scale(${node.flipX ? -1 : 1}, ${node.flipY ? -1 : 1})` }}>
      <textarea ref={input} aria-label="编辑画布文字" data-undo-draft
        maxLength={50000}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        value={node.text || ''} wrap="soft"
        style={{ top: offset, width: node.width,
          height: Math.max(node.height - offset, layout.lines.length * layout.lineAdvance + layout.lineAdvance),
          paddingLeft: layout.inset, paddingRight: layout.inset,
          font: layout.font, lineHeight: `${layout.lineAdvance}px`, letterSpacing: `${node.letterSpacing || 0}px`,
          textAlign: node.align === 'center' ? 'center' : node.align === 'right' ? 'right' : 'left' }}
        onChange={event => { currentText.current = event.target.value; onDraft(event.target.value); }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={event => { composing.current = false; currentText.current = event.currentTarget.value; onDraft(event.currentTarget.value); }}
        onKeyDown={event => {
          event.stopPropagation();
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === 'Escape') { event.preventDefault(); finish(true); }
          else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finish(); }
        }}
        onKeyUp={event => event.stopPropagation()}
        onPointerDown={event => { if (event.button !== 1) event.stopPropagation(); }}
        onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
        onBlur={() => finish()}/>
    </div>
  </div>;
}
