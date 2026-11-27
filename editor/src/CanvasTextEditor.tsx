import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CardNode, SideName } from './model';
import { cardTextLayout } from './render';
import { artworkFontBold, artworkFontCss, artworkFontReady, ensureArtworkTextFonts, useFontRevision } from './artworkFonts';
import { INLINE_SYMBOLS, MAX_TEXT_LENGTH, remapTextDraft, replaceTextRange, styleTextRange, textSpans,
  type InlineTextStyle, type TextDraft } from './textStyles';

let measurement: CanvasRenderingContext2D | null = null;
export function measureCanvasText(node: CardNode) {
  measurement ??= document.createElement('canvas').getContext('2d')!;
  return cardTextLayout(measurement, node);
}

export function expandedTextDraft(node: CardNode, content: TextDraft): CardNode {
  const draft = { ...node, ...content };
  if (!artworkFontReady(node)) return draft;
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

type TextSelection = { start: number; end: number };
type DraftSnapshot = { draft: TextDraft; selection: TextSelection };

function editableSelection(element: HTMLElement): TextSelection | undefined {
  const selection = getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
  const prefix = document.createRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  return { start, end: start + range.toString().length };
}

function selectEditable(element: HTMLElement, { start, end }: TextSelection) {
  const range = document.createRange();
  range.selectNodeContents(element);
  if (!(element.textContent ?? '').length) {
    range.collapse(true);
  } else {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let hasStart = false;
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const length = (text.nodeValue ?? '').length;
      if (!hasStart && start <= offset + length) {
        range.setStart(text, Math.max(0, start - offset));
        hasStart = true;
      }
      if (end <= offset + length) {
        range.setEnd(text, Math.max(0, end - offset));
        break;
      }
      offset += length;
    }
  }
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function drawEditable(element: HTMLElement, draft: TextDraft, node: CardNode) {
  const fragment = document.createDocumentFragment();
  for (const part of textSpans(draft)) {
    const value = draft.text.slice(part.start, part.end);
    const span = document.createElement('span');
    span.style.font = artworkFontCss(node, node.fontSize || 24, draft.textStyles?.length ? part : undefined);
    span.style.lineHeight = 'inherit';
    span.textContent = value;
    fragment.append(span);
  }
  if (!draft.text || draft.text.endsWith('\n')) fragment.append(document.createElement('br'));
  element.replaceChildren(fragment);
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
  showOutline?: boolean;
  onDraft: (draft: TextDraft) => void;
  onCommit: (draft: TextDraft) => void;
  onCancel: () => void;
}

export default function CanvasTextEditor({ node, face, left, top, scale, showOutline = true, onDraft, onCommit, onCancel }: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const styledInput = useRef<HTMLDivElement>(null);
  const finished = useRef(false);
  const composing = useRef(false);
  const draft = useRef<TextDraft>({ text: node.text || '', textStyles: node.textStyles });
  const initialSelection = { start: 0, end: draft.current.text.length };
  const [rich, setRich] = useState(Boolean(node.textStyles?.length));
  const [selection, setSelection] = useState(initialSelection);
  const selectedRef = useRef(initialSelection);
  const beforeInput = useRef(initialSelection);
  const history = useRef<{ undo: DraftSnapshot[]; redo: DraftSnapshot[] }>({ undo: [], redo: [] });
  const callbacks = useRef({ onCommit, onCancel });
  callbacks.current = { onCommit, onCancel };
  const layout = measureCanvasText(node);
  const fontRevision = useFontRevision();
  const [baseline, setBaseline] = useState(layout.baselineOffset);
  const [toolbarOffset, setToolbarOffset] = useState({ x: 0, y: -44 });
  const finish = (cancel = false) => {
    if (finished.current) return;
    finished.current = true;
    if (cancel) callbacks.current.onCancel();
    else if (composing.current && styledInput.current) {
      // A pointer can leave the canvas before the browser dispatches compositionend.
      callbacks.current.onCommit(remapTextDraft(draft.current, styledInput.current.textContent ?? '', beforeInput.current.start));
    } else callbacks.current.onCommit(draft.current);
  };

  const rememberSelection = (next: TextSelection) => {
    selectedRef.current = next;
    setSelection(previous => previous.start === next.start && previous.end === next.end ? previous : next);
  };
  const readSelection = () => {
    if (styledInput.current) return editableSelection(styledInput.current) ?? selectedRef.current;
    if (input.current) return { start: input.current.selectionStart, end: input.current.selectionEnd };
    return selectedRef.current;
  };
  const restoreEditor = (next: TextDraft, range: TextSelection, focus: boolean) => {
    const element = styledInput.current;
    if (!element || composing.current) return;
    drawEditable(element, next, node);
    if (focus) {
      element.focus({ preventScroll: true });
      selectEditable(element, range);
    }
  };
  const update = (next: TextDraft, range: TextSelection, restore = true, record = true) => {
    if (finished.current) return;
    if (record && (draft.current.text !== next.text || draft.current.textStyles !== next.textStyles)) {
      const undo = history.current.undo;
      undo.push({ draft: draft.current, selection: selectedRef.current });
      if (undo.length > 100) undo.shift();
      history.current.redo = [];
    }
    draft.current = next;
    rememberSelection(range);
    if (restore) restoreEditor(next, range, true);
    onDraft(next);
  };
  const replay = (forward: boolean) => {
    const current = history.current;
    const from = forward ? current.redo : current.undo;
    const snapshot = from.pop();
    if (!snapshot) return;
    (forward ? current.undo : current.redo).push({ draft: draft.current, selection: readSelection() });
    update(snapshot.draft, snapshot.selection, true, false);
  };
  const acceptStyledInput = () => {
    const element = styledInput.current;
    if (!element) return;
    const value = element.textContent ?? '';
    const range = editableSelection(element) ?? selectedRef.current;
    const next = remapTextDraft(draft.current, value, Math.min(beforeInput.current.start, range.start));
    if (composing.current) { onDraft(next); return; }
    if (next === draft.current) { rememberSelection(range); return; }
    const bounded = { start: Math.min(range.start, next.text.length), end: Math.min(range.end, next.text.length) };
    update(next, bounded);
  };
  const applyStyle = (patch: InlineTextStyle) => {
    const range = selectedRef.current;
    if (range.start === range.end) return;
    setRich(true);
    update(styleTextRange(draft.current, range.start, range.end, patch), range);
  };
  const insert = (value: string, symbol = false) => {
    const selection = selectedRef.current;
    const { start, end } = selection;
    const next = replaceTextRange(draft.current, start, end, value, symbol ? { symbol: true } : undefined);
    const caret = next.text.length - (draft.current.text.length - end);
    if (symbol) setRich(true);
    update(next, { start: caret, end: caret });
  };

  useLayoutEffect(() => {
    if (rich) {
      const element = styledInput.current;
      const focus = !!element && (document.activeElement === element || !element.childNodes.length);
      restoreEditor(draft.current, selectedRef.current, focus);
    } else {
      input.current?.focus({ preventScroll: true });
      input.current?.setSelectionRange(selectedRef.current.start, selectedRef.current.end);
    }
  }, [rich, layout.font]);
  useLayoutEffect(() => {
    const element = toolbar.current;
    const canvas = wrapper.current?.closest('.editor-canvas');
    if (!element || !canvas) return;
    const position = () => {
      const bounds = canvas.getBoundingClientRect();
      const y = top + bounds.top;
      const x = left + bounds.left;
      const margin = 8;
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const lower = y + node.height * scale + margin;
      const upper = y - height - margin;
      const clampedX = Math.max(bounds.left + margin, Math.min(x, bounds.right - width - margin));
      const requestedY = upper >= bounds.top + margin ? upper : lower;
      const clampedY = Math.max(bounds.top + margin, Math.min(requestedY, bounds.bottom - height - margin));
      setToolbarOffset(previous => previous.x === clampedX - x && previous.y === clampedY - y
        ? previous : { x: clampedX - x, y: clampedY - y });
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [left, top, node.height, scale]);
  useLayoutEffect(() => {
    let alive = true;
    const measure = () => { if (alive) setBaseline(browserBaseline(layout.font, layout.lineAdvance)); };
    measure();
    ensureArtworkTextFonts(node).then(measure);
    return () => { alive = false; };
  }, [layout.font, layout.lineAdvance, node.fontRef, rich, fontRevision]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || wrapper.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-canvas-view-toggle]')) return;
      // Camera navigation leaves the text editor active.
      if ((event.button === 1 || event.button === 2) && target instanceof Element && target.closest('.editor-canvas')) return;
      finish();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, []);
  useEffect(() => {
    const selected = () => {
      if (styledInput.current && document.activeElement === styledInput.current && !composing.current) {
        const range = editableSelection(styledInput.current);
        if (range) rememberSelection(range);
      }
    };
    document.addEventListener('selectionchange', selected);
    return () => document.removeEventListener('selectionchange', selected);
  }, []);
  const handleKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const shortcut = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') { event.preventDefault(); finish(true); }
    else if (event.key === 'Enter' && shortcut) { event.preventDefault(); finish(); }
    else if (shortcut && key === 'b') {
      event.preventDefault();
      const range = readSelection();
      rememberSelection(range);
      applyStyle({ bold: !selectionIsBold(range) });
    } else if (rich && shortcut && (key === 'z' || key === 'y')) {
      event.preventDefault();
      replay(key === 'y' || event.shiftKey);
    } else if (rich && event.key === 'Enter') {
      event.preventDefault();
      rememberSelection(readSelection());
      insert('\n');
    }
  };
  const selectionIsBold = (range: TextSelection) => range.start !== range.end && textSpans(draft.current)
    .filter(span => span.start < range.end && span.end > range.start)
    .every(span => span.bold ?? (span.symbol ? false : artworkFontBold(node)));
  const selectionColor = draft.current.textStyles?.find(span => span.start <= selection.start && span.end > selection.start)?.color
    ?? (/^#[\da-f]{6}$/i.test(node.fill) ? node.fill : '#ffffff');
  const handleBlur = (event: React.FocusEvent) => {
    if (event.relatedTarget instanceof Node && !wrapper.current?.contains(event.relatedTarget)) finish();
  };

  const offset = layout.top + layout.baselineOffset - baseline;
  const fieldStyle = { top: offset, width: node.width,
    height: Math.max(node.height - offset, layout.lines.length * layout.lineAdvance + layout.lineAdvance),
    paddingLeft: layout.inset, paddingRight: layout.inset, font: layout.font,
    lineHeight: `${layout.lineAdvance}px`, letterSpacing: `${node.letterSpacing || 0}px`,
    textAlign: (node.align === 'center' ? 'center' : node.align === 'right' ? 'right' : 'left') as CanvasTextAlign };
  return <div ref={wrapper} className="canvas-text-editor" data-canvas-text-editor
    data-text-face={face} data-text-id={node.id}
    style={{ left, top, width: node.width, height: node.height,
      transform: `scale(${scale}) rotate(${node.rotation}deg)`,
      boxShadow: showOutline ? `0 0 0 ${1 / scale}px var(--prism-focus, #69b5f6)` : undefined }}>
    <div ref={toolbar} className="canvas-text-format" role="group" aria-label="段内文字样式"
      style={{ transform: `rotate(${-node.rotation}deg) scale(${1 / scale}) translate(${toolbarOffset.x}px, ${toolbarOffset.y}px)` }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); finish(true); }
      }}
      onPointerDown={event => { event.stopPropagation(); rememberSelection(readSelection()); }}>
      <button type="button" title="加粗选中文字" aria-label="加粗选中文字" aria-pressed={selectionIsBold(selection)}
        disabled={selection.start === selection.end} onPointerDown={event => event.preventDefault()}
        onClick={() => applyStyle({ bold: !selectionIsBold(selectedRef.current) })}>B</button>
      <label title="选中文字颜色">
        <input type="color" aria-label="选中文字颜色" value={selectionColor} disabled={selection.start === selection.end}
          onChange={event => applyStyle({ color: event.currentTarget.value })}/>
      </label>
      <select aria-label="插入行内符号" value="" onChange={event => {
        if (event.currentTarget.value) insert(event.currentTarget.value, true);
      }}>
        <option value="" disabled>符号</option>
        {INLINE_SYMBOLS.map(item => <option key={item.text} value={item.text}>{item.text} {item.label}</option>)}
      </select>
      <button type="button" title="清除选中文字样式" aria-label="清除选中文字样式"
        disabled={selection.start === selection.end || !draft.current.textStyles?.some(span =>
          span.start < selection.end && span.end > selection.start && (span.bold !== undefined || span.color))}
        onPointerDown={event => event.preventDefault()}
        onClick={() => applyStyle({ bold: undefined, color: undefined })}>清除</button>
    </div>
    <div className="canvas-text-editor-reflection" style={{ width: node.width, height: node.height,
      transform: `translate(${node.flipX ? node.width : 0}px, ${node.flipY ? node.height : 0}px) scale(${node.flipX ? -1 : 1}, ${node.flipY ? -1 : 1})` }}>
      {rich ? <div ref={styledInput} className="canvas-styled-text-input" contentEditable="plaintext-only"
        role="textbox" aria-label="编辑画布文字" aria-multiline="true" data-undo-draft spellCheck={false}
        style={fieldStyle}
        onBeforeInput={() => { if (!composing.current) beforeInput.current = readSelection(); }}
        onInput={acceptStyledInput}
        onCompositionStart={() => { beforeInput.current = readSelection(); composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; acceptStyledInput(); }}
        onPaste={event => {
          event.preventDefault(); event.stopPropagation();
          const value = event.clipboardData.getData('text/plain');
          if (value) { rememberSelection(readSelection()); insert(value.replace(/\r\n?/g, '\n')); }
        }}
        onKeyDown={handleKeyDown} onKeyUp={event => event.stopPropagation()}
        onPointerDown={event => { if (event.button !== 1) event.stopPropagation(); }}
        onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
        onBlur={handleBlur}/>
      : <textarea ref={input} aria-label="编辑画布文字" data-undo-draft
        maxLength={MAX_TEXT_LENGTH}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        value={node.text || ''} wrap="soft"
        style={fieldStyle}
        onSelect={() => rememberSelection(readSelection())}
        onChange={event => update({ text: event.target.value }, readSelection(), false)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={event => {
          composing.current = false;
          update({ text: event.currentTarget.value }, readSelection(), false);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={event => event.stopPropagation()}
        onPointerDown={event => { if (event.button !== 1) event.stopPropagation(); }}
        onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
        onBlur={handleBlur}/>}
    </div>
  </div>;
}
