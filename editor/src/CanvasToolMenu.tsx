import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import FigmaIcon from './FigmaIcon';

interface CanvasToolMenuProps {
  title: string;
  children: ReactNode;
  disabled?: boolean;
}

export default function CanvasToolMenu({ title, children, disabled = false }: CanvasToolMenuProps) {
  const menu = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const element = menu.current;
      if (element?.open && event.target instanceof Node && !element.contains(event.target)) element.open = false;
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  function handleKey(event: KeyboardEvent<HTMLDetailsElement>) {
    const element = event.currentTarget;
    if (event.key === 'Escape' && element.open) {
      event.stopPropagation();
      element.open = false;
      summary.current?.focus();
      return;
    }
    const onSummary = event.target === summary.current;
    const openFromSummary = onSummary && !element.open && ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key);
    if (!openFromSummary && (!element.open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))) return;
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('.canvas-tool-options button:not(:disabled)'));
    if (!buttons.length) return;
    event.preventDefault();
    event.stopPropagation();
    element.open = true;
    const current = buttons.findIndex(button => button === document.activeElement);
    let next = 0;
    if (event.key === 'End' || (event.key === 'ArrowUp' && current < 0)) next = buttons.length - 1;
    else if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === 'ArrowDown') next = (current + 1) % buttons.length;
    buttons[next].focus();
  }

  const chevron = <FigmaIcon name="tool-chevron" className="figma-rotate-90" />;
  if (disabled) return <button type="button" className="canvas-tool-chevron" aria-label={title} title={title} disabled>{chevron}</button>;
  return <details ref={menu} className="canvas-tool-menu" onKeyDown={handleKey} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }}>
    <summary ref={summary} className="canvas-tool-chevron" title={title} aria-label={title}>{chevron}</summary>
    <div className="canvas-tool-options" onClick={event => {
      if (!menu.current || !(event.target instanceof Element) || !event.target.closest('button')) return;
      menu.current.open = false;
      summary.current?.focus();
    }}>{children}</div>
  </details>;
}
