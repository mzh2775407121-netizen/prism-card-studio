import { Fragment, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './inspector-menu.css';

export interface InspectorMenuOption {
  value: string;
  label: ReactNode;
  textValue?: string;
  disabled?: boolean;
  icon?: ReactNode;
  group?: string;
  action?: () => void;
}

export interface InspectorMenuProps {
  value?: string;
  onChange?: (value: string) => void;
  options: InspectorMenuOption[];
  ariaLabel: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  displayValue?: ReactNode;
  triggerIcon?: ReactNode;
  showChevron?: boolean;
  chevronIcon?: ReactNode;
  menuTitle?: string;
  menuWidth?: number;
  variant?: 'select' | 'action';
  align?: 'start' | 'end';
}

type MenuPosition = { left: number; top: number; width: number; maxHeight: number; side: 'top' | 'bottom' };
const optionText = (option: InspectorMenuOption) => option.textValue ??
  (typeof option.label === 'string' || typeof option.label === 'number' ? String(option.label) : option.value);

export default function InspectorMenu({ value, onChange, options, ariaLabel, id, disabled = false, className = '',
  placeholder, displayValue, triggerIcon, showChevron, chevronIcon, menuTitle, menuWidth,
  variant = 'select', align = 'start' }: InspectorMenuProps) {
  const uid = useId();
  const menuId = `${uid}-options`;
  const valueId = `${uid}-value`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<number, HTMLDivElement>());
  const search = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [keyboard, setKeyboard] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const selected = options.find(option => option.value === value && !option.action);
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
  const iconOnly = triggerIcon !== undefined && displayValue === undefined;
  const hasChevron = showChevron ?? !iconOnly;
  const display = displayValue ?? selected?.label ?? (value || placeholder || ariaLabel);
  const firstEnabled = enabled[0] ?? -1;
  const lastEnabled = enabled.at(-1) ?? -1;
  const optionId = (index: number) => `${uid}-option-${index}`;

  const close = (restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    search.current = { text: '', time: 0 };
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };

  const openMenu = (fromKeyboard = false, edge?: 'first' | 'last') => {
    if (disabled || !options.length) return;
    const current = options.findIndex(option => option.value === value && !option.disabled && !option.action);
    setActive(edge === 'first' ? firstEnabled : edge === 'last' ? lastEnabled : current >= 0 ? current : firstEnabled);
    setKeyboard(fromKeyboard);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    close(true);
    if (option.action) option.action();
    else onChange?.(option.value);
  };

  const findTypedOption = (character: string) => {
    const now = performance.now();
    const next = now - search.current.time < 650 ? search.current.text + character : character;
    search.current = { text: next, time: now };
    const query = [...next].every(letter => letter === next[0]) ? next[0] : next;
    const start = Math.max(0, enabled.indexOf(active) + 1);
    for (let offset = 0; offset < enabled.length; offset++) {
      const index = enabled[(start + offset) % enabled.length];
      if (optionText(options[index]).toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) return index;
    }
    return -1;
  };

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current;
    const menu = popup.current;
    const choices = list.current;
    if (!anchor || !menu || !choices) return;
    const viewport = window.visualViewport;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const edge = 8, gap = 6;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const right = viewportLeft + viewportWidth - edge;
      const bottom = viewportTop + viewportHeight - edge;
      const width = Math.min(menuWidth ?? Math.max(188, rect.width), Math.max(1, viewportWidth - edge * 2));
      const naturalHeight = menu.offsetHeight - choices.clientHeight + choices.scrollHeight;
      const desiredHeight = Math.min(344, naturalHeight);
      const below = Math.max(0, bottom - rect.bottom - gap);
      const above = Math.max(0, rect.top - viewportTop - edge - gap);
      const side = below >= desiredHeight || below >= above ? 'bottom' : 'top';
      const maxHeight = Math.min(344, side === 'bottom' ? below : above);
      const height = Math.min(desiredHeight, maxHeight);
      const left = Math.max(viewportLeft + edge, Math.min(align === 'end' ? rect.right - width : rect.left, right - width));
      const top = Math.max(viewportTop + edge, side === 'bottom' ? rect.bottom + gap : rect.top - gap - height);
      const next: MenuPosition = { left, top, width, maxHeight, side };
      setPosition(previous => previous && Object.keys(next).every(key =>
        previous[key as keyof MenuPosition] === next[key as keyof MenuPosition]) ? previous : next);
    };
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !anchor.contains(target) && !menu.contains(target)) close();
    };
    const focusOutside = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Node && !anchor.contains(target) && !menu.contains(target)) close();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      place();
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(anchor);
    resize.observe(menu);
    const visibility = new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) close(); });
    visibility.observe(anchor);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', focusOutside, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', scroll, true);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    return () => {
      resize.disconnect(); visibility.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', focusOutside, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', scroll, true);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
    };
  }, [open, menuWidth, align, menuTitle, options.length]);

  useLayoutEffect(() => {
    if (open && position) list.current?.focus({ preventScroll: true });
  }, [open, Boolean(position)]);

  useLayoutEffect(() => {
    if (!open) return;
    if (disabled) { close(); return; }
    if (active < 0 || !options[active] || options[active].disabled) {
      if (active !== firstEnabled) setActive(firstEnabled);
    }
    rows.current.get(active)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, options, disabled, firstEnabled]);

  const menuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setKeyboard(true);
      if (!enabled.length) return;
      const index = enabled.indexOf(active);
      setActive(enabled[(index + (event.key === 'ArrowDown' ? 1 : enabled.length - 1) + enabled.length) % enabled.length]);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); setKeyboard(true); setActive(event.key === 'Home' ? firstEnabled : lastEnabled); return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && !event.nativeEvent.isComposing) {
      event.preventDefault(); setKeyboard(true);
      const match = findTypedOption(event.key);
      if (match >= 0) setActive(match);
    }
  };

  const renderOption = (option: InspectorMenuOption, index: number) => <div key={option.value}
    ref={element => { if (element) rows.current.set(index, element); else rows.current.delete(index); }}
    id={optionId(index)} className="inspector-menu-option" role={variant === 'action' ? 'menuitem' : 'option'}
    aria-selected={variant === 'select' ? !option.action && value === option.value : undefined}
    aria-disabled={option.disabled || undefined} data-active={active === index || undefined}
    data-keyboard={keyboard && active === index || undefined} data-action={!!option.action || undefined}
    onPointerEnter={event => { if (!option.disabled && event.pointerType !== 'touch') { setActive(index); setKeyboard(false); } }}
    onPointerDown={event => { if (event.pointerType === 'mouse') event.preventDefault(); }}
    onClick={() => choose(index)}>
    {option.icon && <span className="inspector-menu-option-icon" aria-hidden="true">{option.icon}</span>}
    <span className="inspector-menu-option-label">{option.label}</span>
    <span className="inspector-menu-check" aria-hidden="true">
      {!option.action && value === option.value && <img src="/assets/editor-icons/inspector-menu-check.svg" alt=""/>}
    </span>
  </div>;

  const groups: { label?: string; entries: { option: InspectorMenuOption; index: number }[] }[] = [];
  options.forEach((option, index) => {
    if (!groups.length || groups.at(-1)!.label !== option.group) groups.push({ label: option.group, entries: [] });
    groups.at(-1)!.entries.push({ option, index });
  });

  return <>
    <button ref={trigger} id={id} type="button" className={`inspector-menu-trigger${className ? ' ' + className : ''}`}
      aria-label={ariaLabel} aria-describedby={selected && !iconOnly ? valueId : undefined}
      aria-haspopup={variant === 'action' ? 'menu' : 'listbox'} aria-expanded={open}
      aria-controls={open ? menuId : undefined} disabled={disabled || !options.length}
      data-icon-only={iconOnly || undefined} data-chevron={hasChevron || undefined} title={iconOnly ? ariaLabel : undefined}
      onClick={() => open ? close() : openMenu()}
      onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          openMenu(true, event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined);
        } else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (!iconOnly && variant === 'select' && !event.ctrlKey && !event.metaKey && !event.altKey &&
          event.key.length === 1 && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); openMenu(true);
          const match = findTypedOption(event.key);
          if (match >= 0) setActive(match);
        }
      }}>
      {triggerIcon && <span className="inspector-menu-trigger-icon" aria-hidden="true">{triggerIcon}</span>}
      {!iconOnly && <span className="inspector-menu-value">{display}</span>}
      {hasChevron && <span className="inspector-menu-chevron" aria-hidden="true">
        {chevronIcon ?? <img className="inspector-menu-default-chevron" src="/assets/editor-icons/mask-chevron.svg" alt=""/>}
      </span>}
    </button>
    {selected && !iconOnly && <span id={valueId} className="inspector-menu-sr">当前：{optionText(selected)}</span>}
    {open && createPortal(<div ref={popup} className="inspector-menu-popup" data-variant={variant}
      data-owner={trigger.current?.closest('[role="dialog"]')?.id || undefined}
      data-placement={position?.side} style={{ left: position?.left ?? 0, top: position?.top ?? 0,
        width: position?.width ?? menuWidth ?? 188, maxHeight: position?.maxHeight,
        visibility: position ? 'visible' : 'hidden' }} onClick={event => event.stopPropagation()}>
      {menuTitle && <div className="inspector-menu-title">{menuTitle}</div>}
      <div ref={list} id={menuId} className="inspector-menu-list" role={variant === 'action' ? 'menu' : 'listbox'}
        aria-label={menuTitle ?? ariaLabel} aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        tabIndex={-1} onKeyDown={menuKey}>
        {groups.map((group, index) => group.label ? <div key={index} role="group" aria-labelledby={`${uid}-group-${index}`}>
          <div id={`${uid}-group-${index}`} className="inspector-menu-group">{group.label}</div>
          {group.entries.map(({ option, index }) => renderOption(option, index))}
        </div> : <Fragment key={index}>{group.entries.map(({ option, index }) => renderOption(option, index))}</Fragment>)}
      </div>
    </div>, document.body)}
  </>;
}
