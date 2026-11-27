import { Children, createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Crosshair, EyeOff, Image as ImageIcon, RotateCcw, Scan } from 'lucide-react';
import { MAX_GRADIENT_STOPS, MIN_GRADIENT_STOPS, MAX_VISUAL_EFFECTS, MAX_STYLE_PRESETS, MAX_STYLE_PRESET_NAME, METAL_GRADIENTS, fillType, getImageFill, gradientPoints, gradientStopIds, roundGradientOffset, hasFill, hasStroke, type FillType } from './layerAppearance';
import { CroppedImage } from './CropEditor';
import { cropForImageReplacement } from './render';
import { readImage } from './io';
import { IMAGE_ADJUSTMENT_KEYS, PATTERN_TILE_SCALE, uid, type ArtworkStylePreset, type CardNode, type GradientPoint, type ImageAdjustments, type ImageFill, type LayerGradient, type VisualEffect } from './model';
import { PATTERN_PRESETS } from './patternPresets';
import { isOpenVector } from './vectorPaths';
import FigmaIcon from './FigmaIcon';
import InspectorMenu from './InspectorMenu';
import './layer-styles.css';
import './fill-popover.css';

type EditingProps = { onEditStart: () => void; onChange: (patch: Partial<CardNode>) => void };
type ProjectPresets = {
  stylePresets?: ArtworkStylePreset[];
  onStylePresetsChange?: (presets: ArtworkStylePreset[]) => void;
};
type PresetPayload = { kind: 'gradient'; gradient: LayerGradient } | { kind: 'effects'; effects: VisualEffect[] };
const tidy = (value: number) => Number(value.toFixed(3));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const CanvasColorSamplingContext = createContext<((apply: (color: string) => void) => void) | null>(null);
export const CanvasColorSamplingActiveContext = createContext(false);

export function StyleSection({ title, children, actions, className = '' }: {
  title: string; children?: ReactNode; actions?: ReactNode; className?: string;
}) {
  const populated = Children.toArray(children).length > 0;
  return <section className={`style-section${populated ? '' : ' style-section-empty'}${className ? ' ' + className : ''}`}>
    <div className="style-section-heading">
      <h3>{title}</h3>
      {actions && <div className="style-section-actions">{actions}</div>}
    </div>
    {populated && <div className="style-section-body">{children}</div>}
  </section>;
}

export function ScrubField({ label, mark, unit, value, min = -10000, max = 10000, step = .1, disabled, onChange, onEditStart }: {
  label: string; mark?: ReactNode; unit?: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean;
  onChange: (value: number) => void; onEditStart: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<{ x: number; value: number } | null>(null);
  const apply = (next: number) => {
    const number = tidy(clamp(next, min, max));
    if (number !== tidy(value)) onChange(number);
  };
  return <label className="style-number">
    {mark && <span className="style-scrub" title={label + ' · 拖动调整'} aria-hidden="true"
      onPointerDown={event => {
        if (disabled || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, value };
        onEditStart();
      }}
      onPointerMove={event => {
        if (!drag.current) return;
        const offset = Math.round((event.clientX - drag.current.x) / (event.altKey ? 10 : 2));
        apply(drag.current.value + offset * step);
      }}
      onLostPointerCapture={() => { drag.current = null; }}>{mark}</span>}
    <input type="number" aria-label={label} value={draft ?? tidy(value)} min={min} max={max} step={step}
      disabled={disabled} data-undo-draft={draft !== null || undefined} onChange={event => {
        const next = event.target.value;
        setDraft(next === String(tidy(value)) ? null : next);
      }}
      onBlur={() => {
        if (draft?.trim() && Number.isFinite(Number(draft))) { onEditStart(); apply(Number(draft)); }
        setDraft(null);
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); }
      }}/>
    {unit && <span className="style-unit" aria-hidden="true">{unit}</span>}
  </label>;
}

export function LayerGeometry({ node, onChange, onEditStart, children, managedPosition }: EditingProps & {
  node: CardNode;
  children: ReactNode;
  managedPosition?: boolean;
}) {
  const fields = [['x','X','水平位置'],['y','Y','垂直位置'],['width','宽','宽度'],['height','高','高度']] as const;
  const geometryFields = fields.map(([key, mark, label]) => <ScrubField key={key} label={label + '（毫米）'}
    mark={mark} value={node[key] / 10}
    min={key === 'width' || key === 'height' ? .1 : -10000}
    disabled={node.locked} onEditStart={onEditStart}
    onChange={value => onChange({ [key]: value * 10 })}/>);
  const rotate = (degrees: number) => {
    const angle = (degrees + 360) % 360;
    onEditStart(); onChange({ rotation: angle > 180 ? angle - 360 : angle });
  };
  return <>
    <StyleSection title="位置" className="style-geometry-position">
      {!managedPosition && <div className="style-property"><span className="style-caption">对齐</span>{children}</div>}
      <div className="style-property"><span className="style-caption">位置</span>
        <div className="style-fields style-coordinates">{geometryFields.slice(0, 2)}</div>
      </div>
      <div className="style-property"><span className="style-caption">旋转</span>
        <div className="style-fields style-rotation">
          <ScrubField label="旋转" mark="∠" unit="°" value={node.rotation} min={-360} max={360} step={1}
            disabled={node.locked} onEditStart={onEditStart} onChange={rotation => onChange({ rotation })}/>
          <div className="style-segmented" aria-label="旋转快捷操作">
            <StyleAction label="逆时针旋转 90°" disabled={node.locked} onClick={() => rotate(node.rotation - 90)}><FigmaIcon name="rotate-left"/></StyleAction>
            <StyleAction label="水平翻转" pressed={!!node.flipX} disabled={node.locked} onClick={() => {
              onEditStart(); onChange({ flipX: !node.flipX });
            }}><FigmaIcon name="flip-horizontal"/></StyleAction>
            <StyleAction label="垂直翻转" pressed={!!node.flipY} disabled={node.locked} onClick={() => {
              onEditStart(); onChange({ flipY: !node.flipY });
            }}><FigmaIcon name="flip-vertical" className="figma-rotate-90"/></StyleAction>
          </div>
        </div>
      </div>
    </StyleSection>
    <StyleSection title="布局" className="style-geometry-size">
      <div className="style-property"><span className="style-caption">大小</span>
        <div className="style-fields">{geometryFields.slice(2)}</div>
      </div>
    </StyleSection>
  </>;
}

function toHex(value: string) {
  const hex = /^#?([a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.exec(value.trim())?.[1];
  if (hex) return '#' + (hex.length <= 4 ? [...hex].map(char => char + char).join('') : hex).toUpperCase();
  return undefined;
}

function readHex(value: string) {
  if (value === 'transparent') return '#00000000';
  const hex = toHex(value);
  if (hex) return hex;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return '#000000';
  context.fillStyle = value;
  const normal = context.fillStyle;
  const channels = normal.match(/^rgba?\(([^)]+)\)$/)?.[1].split(',').map(Number);
  if (!channels || channels.some(channel => !Number.isFinite(channel))) return toHex(normal) ?? '#000000';
  const pieces = channels.slice(0, 3).map(channel => Math.round(channel).toString(16).padStart(2, '0'));
  if (channels.length === 4 && channels[3] < 1) pieces.push(Math.round(channels[3] * 255).toString(16).padStart(2, '0'));
  return '#' + pieces.join('').toUpperCase();
}

function hexOpacity(color: string) {
  const alpha = readHex(color).slice(7);
  return alpha ? Math.round(parseInt(alpha,16) / 255 * 100) : 100;
}

function withHexOpacity(color: string, opacity: number) {
  const hex = readHex(color).slice(0,7);
  return opacity === 100 ? hex : hex + Math.round(opacity / 100 * 255).toString(16).padStart(2, '0').toUpperCase();
}

function readHsv(color: string) {
  const hex = readHex(color);
  const [r,g,b] = [1,3,5].map(index => parseInt(hex.slice(index,index+2),16) / 255);
  const value = Math.max(r,g,b), range = value - Math.min(r,g,b);
  const hue = !range ? 0 : value === r ? (g-b)/range : value === g ? (b-r)/range+2 : (r-g)/range+4;
  return { hue: (hue*60+360)%360, saturation: value ? range/value : 0, value };
}

function hsvColor(hue: number, saturation: number, value: number) {
  const chroma = saturation * value, sector = hue / 60;
  const x = chroma * (1-Math.abs(sector%2-1));
  const colors = [[chroma,x,0],[x,chroma,0],[0,chroma,x],[0,x,chroma],[x,0,chroma],[chroma,0,x]];
  const rgb = colors[Math.floor(sector)%6];
  return '#'+rgb.map(channel => Math.round((channel+value-chroma)*255).toString(16).padStart(2,'0')).join('').toUpperCase();
}

type EyeDropperWindow = Window & { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } };

const fillIconSizes = {
  close: 15, solid: 15, image: 15, eyedropper: 14, 'add-stop': 14, 'remove-stop': 14, crop: 14, 'fit-chevron': 12,
} as const;

function FillIcon({ name }: { name: keyof typeof fillIconSizes }) {
  return <img className="figma-icon" src={`/assets/editor-icons/fill-${name}.svg`}
    alt="" width={fillIconSizes[name]} height={fillIconSizes[name]} draggable={false}/>;
}

function ColorControl({ label, color, onChange, onEditStart, disabled }: {
  label: string; color: string; onChange: (color: string) => void; onEditStart: () => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const control = useRef<HTMLDivElement>(null);
  const exact = readHex(color);
  const startSampling = useContext(CanvasColorSamplingContext);
  const latest = useRef({ exact, onChange, onEditStart, disabled });
  latest.current = { exact, onChange, onEditStart, disabled };
  const applySample = (sampled: string) => {
    const { exact, onEditStart, onChange, disabled } = latest.current;
    if (!control.current || disabled) return;
    const next = sampled.toUpperCase() + exact.slice(7);
    if (next === exact) return;
    onEditStart();
    onChange(next);
  };
  const picker = (window as EyeDropperWindow).EyeDropper;
  return <div className="style-color-control" ref={control}>
    <label className="style-color-swatch" style={{ '--swatch': color } as React.CSSProperties}>
      <input type="color" aria-label={label} value={exact.slice(0,7).toLowerCase()} disabled={disabled} onInput={event => onChange(event.currentTarget.value+(exact.length===9?exact.slice(7):''))}
        onChange={event => onChange(event.target.value+(exact.length===9?exact.slice(7):''))} onFocus={onEditStart}/>
    </label>
    <input type="text" className="style-hex" aria-label={label + ' HEX'} title="HEX，支持 6 位颜色或 8 位含透明度"
      value={draft ?? exact} disabled={disabled} spellCheck={false} data-undo-draft={draft !== null || undefined}
      onChange={event => {
        const next = event.target.value;
        setDraft(next === exact ? null : next);
      }}
      onBlur={() => {
        const next = toHex(draft ?? exact);
        if (next && next !== exact) { onEditStart(); onChange(next); }
        setDraft(null);
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); }
      }}/>
    {startSampling && <button type="button" className="style-icon canvas-color-sample" title="从画布取色"
      aria-label={label + '画布取色'} disabled={disabled} onClick={() => startSampling(applySample)}><FillIcon name="eyedropper"/></button>}
    {picker && <button type="button" className="style-icon system-color-sample" title="从屏幕取色" aria-label={label + '屏幕取色'} disabled={disabled}
      onClick={async () => {
        try { const { sRGBHex } = await new picker().open(); applySample(sRGBHex); }
        catch { /* Escape cancels the browser's eyedropper. */ }
      }}>{startSampling ? <Scan size={12}/> : <FillIcon name="eyedropper"/>}</button>}
  </div>;
}

const sortedStops = (stops: LayerGradient['stops']) => [...stops].sort((left, right) => left[0] - right[0]);
const gradientPreview = (stops: LayerGradient['stops']) =>
  'linear-gradient(90deg, ' + sortedStops(stops).map(([offset,color]) => `${color} ${offset * 100}%`).join(', ') + ')';

function colorAt(stops: LayerGradient['stops'], offset: number) {
  const colors = sortedStops(stops);
  const right = colors.findIndex(([position]) => position > offset);
  if (right <= 0) return colors[right === 0 ? 0 : colors.length - 1][1];
  const [a, colorA] = colors[right - 1], [b, colorB] = colors[right];
  const t = b === a ? 1 : (offset - a) / (b - a);
  const hexA = readHex(colorA).padEnd(9,'F'), hexB = readHex(colorB).padEnd(9,'F');
  const channels = [1,3,5,7].map(index => {
    const x = parseInt(hexA.slice(index,index+2),16), y = parseInt(hexB.slice(index,index+2),16);
    return Math.round(x + (y-x) * t).toString(16).padStart(2,'0');
  });
  return '#' + channels.slice(0, channels[3] === 'ff' ? 3 : 4).join('').toUpperCase();
}

function GradientSwatch({ stops, className }: { stops: LayerGradient['stops']; className: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    const ramp = ctx.createLinearGradient(0, 0, element.width, 0);
    stops.forEach(([offset, color]) => ramp.addColorStop(offset, color));
    ctx.clearRect(0, 0, element.width, element.height);
    ctx.fillStyle = ramp;
    ctx.fillRect(0, 0, element.width, element.height);
  }, [stops]);
  return <canvas ref={canvas} width={768} height={1} className={className} aria-hidden="true"/>;
}

function StylePresets({ value, disabled, canSave, stylePresets = [], onStylePresetsChange, onApply }: ProjectPresets & {
  value: PresetPayload; disabled: boolean; canSave: boolean; onApply: (preset: ArtworkStylePreset) => void;
}) {
  const [name, setName] = useState<string>();
  const presets = stylePresets.filter(preset => preset.kind === value.kind);
  const label = value.kind === 'gradient' ? '渐变预设' : '效果预设';
  if (!onStylePresetsChange) return null;
  const trimmed = name?.trim() ?? '';
  const duplicate = presets.some(preset => preset.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  const save = () => {
    if (disabled || !canSave || !trimmed || duplicate || stylePresets.length >= MAX_STYLE_PRESETS) return;
    onStylePresetsChange([...stylePresets, { id: uid(), name: trimmed, ...structuredClone(value) }]);
    setName(undefined);
  };
  return <div className="style-presets">
    <InspectorMenu ariaLabel={label} className="style-presets-menu" variant="action"
      displayValue={label} menuWidth={188} disabled={disabled} options={[
        { value: 'save', label: '保存当前' + (value.kind === 'gradient' ? '渐变' : '效果'), disabled: !canSave || stylePresets.length >= MAX_STYLE_PRESETS,
          action: () => setName('') },
        ...presets.map(preset => ({ value: preset.id, label: preset.name, group: '应用预设', action: () => onApply(preset) })),
        ...presets.map(preset => ({ value: 'remove-' + preset.id, label: '删除 ' + preset.name, group: '管理预设',
          action: () => onStylePresetsChange(stylePresets.filter(item => item.id !== preset.id)) })),
      ]}/>
    {name !== undefined && <div className="style-preset-entry">
      <input type="text" aria-label="预设名称" className="style-preset-name" maxLength={MAX_STYLE_PRESET_NAME} autoFocus
        placeholder="预设名称" value={name} onChange={event => setName(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); save(); }
          if (event.key === 'Escape') { event.stopPropagation(); setName(undefined); }
        }}/>
      <button type="button" disabled={disabled || !trimmed || duplicate || stylePresets.length >= MAX_STYLE_PRESETS}
        onClick={save}>保存</button>
      <StyleAction label="取消保存预设" onClick={() => setName(undefined)}><FillIcon name="close"/></StyleAction>
      {duplicate && <span role="alert">名称已存在</span>}
    </div>}
  </div>;
}

function GradientEditor({ node, gradient, disabled, onChange, onEditStart, editing, onToggleEditing, stylePresets, onStylePresetsChange }: ProjectPresets & {
  node: CardNode; gradient: LayerGradient; disabled: boolean; editing: boolean; onToggleEditing: () => void;
  onChange: (gradient: LayerGradient) => void; onEditStart: () => void;
}) {
  const [selected, setSelected] = useState<string>();
  const ids = gradientStopIds(gradient);
  const active = Math.max(0, ids.indexOf(selected ?? ''));
  const ramp = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const moving = useRef<{ id: string; pointer: number } | null>(null);
  const stops = gradient.stops;
  const canAdd = !disabled && stops.length < MAX_GRADIENT_STOPS;
  const canRemove = !disabled && stops.length > MIN_GRADIENT_STOPS;
  useLayoutEffect(() => {
    const viewport = list.current;
    const row = viewport?.querySelector('.is-current');
    if (!viewport || !row) return;
    const bounds = viewport.getBoundingClientRect();
    const selectedBounds = row.getBoundingClientRect();
    if (selectedBounds.top < bounds.top) viewport.scrollTop += selectedBounds.top - bounds.top;
    if (selectedBounds.bottom > bounds.bottom) viewport.scrollTop += selectedBounds.bottom - bounds.bottom;
  }, [selected, stops[active][0]]);
  const changeStop = (index: number, stop: [number, string]) => onChange({
    ...gradient, stopIds: ids, stops: stops.map((item, i) => index === i ? stop : item),
  });
  const insertStop = (index: number, stop: [number, string]) => {
    if (!canAdd) return;
    const id = uid();
    onEditStart();
    onChange({
      ...gradient,
      stops: [...stops.slice(0, index), stop, ...stops.slice(index)],
      stopIds: [...ids.slice(0, index), id, ...ids.slice(index)],
    });
    setSelected(id);
  };
  const addStop = (position: number) => {
    const offset = roundGradientOffset(position);
    insertStop(stops.length, [offset, colorAt(stops, offset)]);
  };
  const nextPosition = () => {
    const positions = [0, ...sortedStops(stops).map(([position]) => position), 1];
    let center = .5, widest = -1;
    for (let i = 1; i < positions.length; i++) {
      const span = positions[i] - positions[i - 1];
      if (span > widest) { widest = span; center = positions[i - 1] + span / 2; }
    }
    return center;
  };
  const remove = (index: number) => {
    if (!canRemove) return;
    onEditStart();
    onChange({ ...gradient, stopIds: ids.filter((_, i) => i !== index), stops: stops.filter((_, i) => i !== index) });
    if (index === active) setSelected(ids[index + 1] ?? ids[index - 1]);
  };
  const rampOffset = (event: PointerEvent) => {
    const rect = ramp.current!.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / rect.width, 0, 1);
  };
  const setAngle = (angle: number) => {
    if (!gradient.endpoints) { onChange({ ...gradient, angle }); return; }
    const [start,end] = gradientPoints(gradient,node.width,node.height);
    const dx = (end[0] - start[0]) / 2, dy = (end[1] - start[1]) / 2;
    const distance = Math.hypot(dx,dy);
    const radians = angle * Math.PI / 180;
    const cx = start[0] + dx, cy = start[1] + dy;
    const points = [-1,1].map(sign => [
      clamp((cx + Math.cos(radians) * distance * sign) / node.width,-2,3),
      clamp((cy + Math.sin(radians) * distance * sign) / node.height,-2,3),
    ]) as [GradientPoint,GradientPoint];
    onChange({ ...gradient, angle, endpoints: points });
  };
  return <div className="gradient-editor">
    <div className="gradient-presets" aria-label="金属渐变预设">
      {METAL_GRADIENTS.map(preset => <button type="button" key={preset.label} disabled={disabled}
        onClick={() => {
          const stopIds = preset.stops.map(() => uid());
          onEditStart();
          onChange({ ...gradient, stops: structuredClone(preset.stops), stopIds });
          setSelected(stopIds[0]);
        }}><span style={{ backgroundImage: gradientPreview(preset.stops) }}/>{preset.label}</button>)}
    </div>
    <StylePresets value={{ kind: 'gradient', gradient: { ...gradient, stopIds: ids } }} stylePresets={stylePresets}
      onStylePresetsChange={onStylePresetsChange} canSave disabled={disabled} onApply={preset => {
        if (preset.kind !== 'gradient') return;
        onEditStart();
        const stopIds = preset.gradient.stops.map(() => uid());
        onChange({ ...structuredClone(preset.gradient), stopIds });
        setSelected(stopIds[0]);
      }}/>
    <div className="gradient-ramp" ref={ramp} onPointerDown={event => {
      if (event.target === event.currentTarget && event.button === 0) addStop(rampOffset(event));
    }} title="点击渐变条添加色标">
      <GradientSwatch className="gradient-spectrum" stops={stops}/>
      {stops.map(([offset, color], index) => <button type="button" key={ids[index]} role="slider" aria-label={`色标 ${index+1}`}
        aria-valuenow={tidy(offset * 100)} aria-valuemin={0} aria-valuemax={100}
        aria-valuetext={`${tidy(offset * 100)}%，${readHex(color)}`} disabled={disabled}
        className={index === active ? 'gradient-stop selected' : 'gradient-stop'}
        style={{ left: (offset * 100)+'%', '--swatch': color } as React.CSSProperties}
        onFocus={() => setSelected(ids[index])}
        onPointerDown={event => {
          if (event.button !== 0) return;
          setSelected(ids[index]); onEditStart();
          moving.current = { id: ids[index], pointer: event.pointerId };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          if (moving.current?.pointer !== event.pointerId || moving.current.id !== ids[index]) return;
          changeStop(index,[roundGradientOffset(rampOffset(event)),color]);
        }}
        onLostPointerCapture={() => { moving.current = null; }}
        onKeyDown={event => {
          const step = event.shiftKey ? .1 : event.altKey ? .0001 : .01;
          if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : clamp(offset + (event.key === 'ArrowLeft' ? -step : step),0,1);
          if (!event.repeat) onEditStart();
          changeStop(index,[roundGradientOffset(next),color]);
        }}/>)}
    </div>
    <div className="gradient-stops-heading">
      <span>色标</span>
      <div className="gradient-stops-actions">
        <StyleAction label={editing ? '结束画布调节' : '画布调节'} pressed={editing}
          disabled={disabled || !node.visible || node.fillHidden} onClick={onToggleEditing}><FillIcon name="crop"/></StyleAction>
        <StyleAction label="复制当前色标" disabled={!canAdd} onClick={() => insertStop(active + 1, stops[active])}>⧉</StyleAction>
        <StyleAction label="添加色标" disabled={!canAdd} onClick={() => addStop(nextPosition())}><FillIcon name="add-stop"/></StyleAction>
      </div>
    </div>
    <div className="gradient-stops-list" ref={list}>
      {stops.map(([offset,color],index)=>({offset,color,index})).sort((a,b)=>a.offset-b.offset).map(({offset,color,index}) => {
        const suffix = index === active ? '' : ' ' + (index + 1);
        return <div className={`gradient-stop-row${index === active ? ' is-current' : ''}`} key={ids[index]}
          onFocus={() => setSelected(ids[index])} onPointerDown={() => setSelected(ids[index])}>
          <ScrubField label={'色标位置'+suffix} value={offset*100} min={0} max={100} step={.01} unit="%"
            disabled={disabled} onEditStart={onEditStart} onChange={value => changeStop(index,[roundGradientOffset(value/100),color])}/>
          <ColorControl label={'色标颜色'+suffix} color={color} disabled={disabled} onEditStart={onEditStart}
            onChange={value => changeStop(index,[offset,value])}/>
          <ScrubField label={'色标不透明度'+suffix} value={hexOpacity(color)} min={0} max={100} step={1} unit="%"
            disabled={disabled} onEditStart={onEditStart} onChange={value => changeStop(index,[offset,withHexOpacity(color,value)])}/>
          <StyleAction label={'删除色标'+suffix} disabled={!canRemove} onClick={() => remove(index)}><FillIcon name="remove-stop"/></StyleAction>
        </div>;
      })}
    </div>
    {editing && gradient.kind !== 'radial' && <div className="gradient-direction">
      <ScrubField label="渐变角度" mark="角度" unit="°" value={gradient.angle}
        min={0} max={360} step={1} disabled={disabled} onEditStart={onEditStart} onChange={setAngle}/>
    </div>}
  </div>;
}

export function StyleAction({ label, children, disabled, pressed, onClick }: {
  label: string; children: ReactNode; onClick: () => void; disabled?: boolean; pressed?: boolean;
}) {
  return <button type="button" className="style-icon" aria-label={label} aria-pressed={pressed} title={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

const fillOptions: { value: FillType; label: string; icon: ReactNode }[] = [
  { value:'solid', label:'纯色', icon:<FillIcon name="solid"/> },
  { value:'linear', label:'线性渐变', icon:<span className="fill-mode-symbol linear"/> },
  { value:'radial', label:'径向渐变', icon:<span className="fill-mode-symbol radial"/> },
  { value:'image', label:'图片', icon:<FillIcon name="image"/> },
  { value:'pattern', label:'图案', icon:<span className="fill-mode-symbol pattern"/> },
];

const colorPresets = ['#FFFFFF','#161616','#E2E8F0','#68776E','#2675CE','#4650AF','#B04B9A','#C34750','#DB783C','#CFB267','#65A78E','#294F41'];

function SolidFillEditor({ node, onChange, onEditStart }: EditingProps & { node: CardNode }) {
  const [rememberedHue,setRememberedHue] = useState(()=>readHsv(node.fill).hue);
  const pointer = useRef<number | null>(null);
  const hsv = readHsv(node.fill);
  const hue = hsv.saturation && hsv.value ? hsv.hue : rememberedHue;
  const apply = (h: number, s: number, v: number) => {
    setRememberedHue(h === 360 ? 0 : h);
    onChange({ fill:hsvColor(h,s,v)+readHex(node.fill).slice(7) });
  };
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    apply(hue,clamp((event.clientX-rect.left)/rect.width,0,1),1-clamp((event.clientY-rect.top)/rect.height,0,1));
  };
  return <div className="solid-fill-editor">
    <div className="fill-color-plane" aria-hidden="true" style={{ backgroundColor:`hsl(${hue} 100% 50%)` }}
      onPointerDown={event => {
        if (event.button !== 0 || node.locked) return;
        onEditStart(); pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId); pick(event);
      }}
      onPointerMove={event => { if (pointer.current === event.pointerId) pick(event); }}
      onLostPointerCapture={() => { pointer.current = null; }}>
      <span className="fill-plane-thumb" style={{ left:hsv.saturation*100+'%',top:(1-hsv.value)*100+'%',background:node.fill }}/>
    </div>
    <input className="fill-hue" type="range" aria-label="色相滑杆" min={0} max={360} value={Math.round(hue)}
      disabled={node.locked} onPointerDown={onEditStart} onChange={event=>apply(+event.target.value,hsv.saturation,hsv.value)}/>
    <input className="fill-alpha" type="range" aria-label="颜色不透明度滑杆" min={0} max={100} value={hexOpacity(node.fill)}
      style={{'--fill-alpha-color':readHex(node.fill).slice(0,7)} as React.CSSProperties}
      disabled={node.locked} onPointerDown={onEditStart} onChange={event=>onChange({fill:withHexOpacity(node.fill,+event.target.value)})}/>
    <div className="fill-hsb">
      <ScrubField label="色相" mark="H" unit="°" value={Math.round(hue)} min={0} max={360} step={1}
        disabled={node.locked} onEditStart={onEditStart} onChange={value=>apply(value,hsv.saturation,hsv.value)}/>
      <ScrubField label="饱和度" mark="S" unit="%" value={Math.round(hsv.saturation*100)} min={0} max={100} step={1}
        disabled={node.locked} onEditStart={onEditStart} onChange={value=>apply(hue,value/100,hsv.value)}/>
      <ScrubField label="明度" mark="B" unit="%" value={Math.round(hsv.value*100)} min={0} max={100} step={1}
        disabled={node.locked} onEditStart={onEditStart} onChange={value=>apply(hue,hsv.saturation,value/100)}/>
    </div>
    <div className="fill-hex-row">
      <ColorControl label="填充颜色" color={node.fill} disabled={node.locked} onEditStart={onEditStart} onChange={fill=>onChange({fill})}/>
      <ScrubField label="填充颜色不透明度" unit="%" value={hexOpacity(node.fill)} min={0} max={100} step={1}
        disabled={node.locked} onEditStart={onEditStart} onChange={value=>onChange({fill:withHexOpacity(node.fill,value)})}/>
    </div>
    <div className="fill-palette" aria-label="常用颜色">
      {colorPresets.map(fill=><button type="button" title={fill} aria-label={'使用颜色 '+fill} key={fill} disabled={node.locked}
        style={{ background:fill }} onClick={()=>{onEditStart();onChange({fill})}}/>)}
    </div>
  </div>;
}

const pictureFitOptions = [
  { value: 'cover', label: '填充' },
  { value: 'contain', label: '适应' },
];

const adjustmentLabels: Record<keyof ImageAdjustments, string> = {
  exposure:'曝光', contrast:'对比度', saturation:'饱和度', brightness:'明度',
  temperature:'白平衡', tint:'着色', highlights:'高光', shadows:'阴影',
};
const rangeKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];

function ImageAdjustmentFields({ fill, disabled, onChange, onEditStart }: EditingProps & {
  fill: ImageFill; disabled: boolean;
}) {
  const hasAdjustments = IMAGE_ADJUSTMENT_KEYS.some(key => fill.adjustments?.[key]);
  return <div className="fill-adjustments" role="group" aria-label="颜色调节">
    <div className="fill-adjustments-heading">
      <span>颜色调节</span>
      <StyleAction label="重置颜色调节" disabled={disabled || !hasAdjustments} onClick={() => {
        onEditStart();
        onChange({ imageFill: { ...fill, adjustments: undefined } });
      }}><RotateCcw size={13}/></StyleAction>
    </div>
    {IMAGE_ADJUSTMENT_KEYS.map(key => {
      const value = fill.adjustments?.[key] ?? 0;
      const label = adjustmentLabels[key];
      return <label key={key} className="fill-adjustment-row">
        <span>{label}</span>
        <input type="range" min={-100} max={100} step={1} value={value} disabled={disabled}
          title={label + ' ' + (value > 0 ? '+' : '') + value}
          onPointerDown={event => { if (event.button === 0) onEditStart(); }}
          onKeyDown={event => { if (!event.repeat && rangeKeys.includes(event.key)) onEditStart(); }}
          onChange={event => {
            const next = event.currentTarget.valueAsNumber;
            if (next === value) return;
            const adjustments = { ...fill.adjustments, [key]: next };
            if (!next) delete adjustments[key];
            onChange({ imageFill: { ...fill, adjustments: Object.keys(adjustments).length ? adjustments : undefined } });
          }}/>
      </label>;
    })}
  </div>;
}

function PictureFillEditor({ node, onChange, onEditStart, onCrop, preserveImageCrop, onPending }: EditingProps & {
  node: CardNode; onCrop: () => void; preserveImageCrop: boolean; onPending: (pending: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const fill = getImageFill(node);
  useEffect(()=>{
    mounted.current = true;
    return () => { mounted.current = false; };
  },[]);
  const upload = async (file: File) => {
    onPending(true);setLoading(true);setError('');
    try {
      const image = await readImage(file);
      if (!mounted.current) return;
      const crop = preserveImageCrop ? await cropForImageReplacement(node) : undefined;
      if (!mounted.current) return;
      const imageFill = { src:image.src, fit:fill?.fit, crop, adjustments:fill?.adjustments };
      onEditStart();
      onChange({ fillMode:'image', imageFill, fillHidden:false,
        ...(node.type === 'image' ? { src:image.src,crop } : {}) });
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      if (mounted.current) { onPending(false);setLoading(false); }
    }
  };
  return <div className="fill-image-editor">
    <input hidden ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="图片填充文件"
      onChange={event=>{
        const file=event.target.files?.[0];event.target.value='';
        if(file)void upload(file);
      }}/>
    {fill && <div className="fill-image-options">
      <InspectorMenu className="fill-image-fit" ariaLabel="图片填充方式" value={fill.fit??'cover'}
        options={pictureFitOptions} menuWidth={90} chevronIcon={<FillIcon name="fit-chevron"/>} disabled={node.locked||loading}
        onChange={value=>{
          onEditStart();
          onChange({imageFill:{...fill, fit:value==='contain'?'contain':'cover'}});
        }}/>
      <StyleAction label="编辑图片裁切" disabled={node.locked||loading} onClick={onCrop}><FillIcon name="crop"/></StyleAction>
    </div>}
    <div className="fill-image-preview">
      {fill?<CroppedImage node={node}/>:<button type="button" className="fill-image-empty" disabled={node.locked||loading}
        onClick={()=>input.current?.click()}><ImageIcon size={19}/>{loading?'正在读取…':'选择图片'}</button>}
    </div>
    {fill && <button type="button" className="fill-replace" disabled={node.locked||loading}
      onClick={()=>input.current?.click()}>{loading?'正在读取…':'替换图片'}</button>}
    {error&&<p className="fill-error" role="alert">{error}</p>}
    {fill?.src && <ImageAdjustmentFields fill={fill} disabled={node.locked||loading} onChange={onChange} onEditStart={onEditStart}/>}
  </div>;
}

const patternFitOptions = [
  { value:'cover', label:'填充' },
  { value:'tile', label:'平铺' },
];

function PatternFillEditor({ node, onChange, onEditStart, onPending }: EditingProps & {
  node: CardNode; onPending: (pending: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const fill = fillType(node)==='pattern' ? getImageFill(node) : undefined;
  const fit = fill?.fit==='tile' ? 'tile' : 'cover';
  const custom = fill && !fill.presetId;
  const disabled = node.locked || loading;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; onPending(false); };
  }, [onPending]);

  const apply = (src: string, presetId?: string) => {
    const imageFill: ImageFill = { src, fit, tileScale:fill?.tileScale, presetId, adjustments:fill?.adjustments };
    onEditStart();
    onChange({ fillMode:'pattern', imageFill, fillHidden:false });
  };
  const upload = async (file: File) => {
    onPending(true);setLoading(true);setError('');
    try {
      const image = await readImage(file);
      if (mounted.current) apply(image.src);
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      if (mounted.current) { onPending(false);setLoading(false); }
    }
  };

  return <div className="fill-pattern-editor">
    <div className="fill-pattern-grid" role="group" aria-label="预设图案">
      {PATTERN_PRESETS.map(preset => {
        const selected = fill?.presetId===preset.id;
        return <button type="button" className="fill-pattern-swatch" key={preset.id} title={preset.name}
          aria-label={preset.name} aria-pressed={selected} disabled={disabled} onClick={()=>{
            if (selected && !node.fillHidden) return;
            setError('');
            apply(preset.src,preset.id);
          }}><img src={preset.src} alt="" draggable={false}/></button>;
      })}
    </div>
    <input hidden ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="图案填充文件" disabled={disabled}
      onChange={event=>{
        const file=event.target.files?.[0];event.target.value='';
        if(file)void upload(file);
      }}/>
    <button type="button" className="fill-replace fill-pattern-upload" disabled={disabled} onClick={()=>input.current?.click()}>
      {custom ? <img src={fill.src} alt="" draggable={false}/> : <FigmaIcon name="section-add"/>}
      {loading ? '正在读取…' : custom ? '替换图案' : '上传图案'}
    </button>
    {error&&<p className="fill-error" role="alert">{error}</p>}
    {fill && <div className="fill-image-options fill-pattern-options">
      <InspectorMenu className="fill-image-fit" ariaLabel="图案填充方式" value={fit} options={patternFitOptions}
        menuWidth={90} chevronIcon={<FillIcon name="fit-chevron"/>} disabled={disabled} onChange={value=>{
          if (value===fit) return;
          onEditStart();
          onChange({imageFill:{...fill,fit:value==='tile'?'tile':'cover'}});
        }}/>
      {fit==='tile'&&<ScrubField label="平铺缩放" mark="缩放" unit="%" value={(fill.tileScale??PATTERN_TILE_SCALE.default)*100}
        min={PATTERN_TILE_SCALE.min*100} max={PATTERN_TILE_SCALE.max*100} step={1} disabled={disabled} onEditStart={onEditStart}
        onChange={value=>onChange({imageFill:{...fill,tileScale:value/100}})}/>}
    </div>}
    {fill?.src && <ImageAdjustmentFields fill={fill} disabled={disabled} onChange={onChange} onEditStart={onEditStart}/>}
  </div>;
}

function FillPopover({ anchor, node, onChange, onEditStart, onClose, editingGradient, onToggleGradient, onCrop, preserveImageCrop,
  stylePresets, onStylePresetsChange }: EditingProps & ProjectPresets & {
  anchor: RefObject<HTMLButtonElement | null>; node: CardNode; onClose: (restoreFocus: boolean) => void;
  editingGradient: boolean; onToggleGradient: () => void; onCrop: () => void; preserveImageCrop: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(false);
  const [position,setPosition] = useState<{ left:number; top:number }>();
  const [pending,setPending] = useState(false);
  const [choosingPattern,setChoosingPattern] = useState(false);
  const sampling = useContext(CanvasColorSamplingActiveContext);
  const layerMode = fillType(node);
  const mode = choosingPattern ? 'pattern' : layerMode;
  useLayoutEffect(()=>{
    const element = panel.current;
    if (!element) return;
    const align = () => {
      const row = anchor.current?.closest('.paint-value-row')?.getBoundingClientRect() ?? anchor.current?.getBoundingClientRect();
      if (!row) return;
      const { width,height } = element.getBoundingClientRect();
      const edge = anchor.current?.closest('.right-panel')?.getBoundingClientRect().left ?? row.left;
      const left = edge-width-6 >= 8 ? edge-width-6 : clamp(row.right-width,8,innerWidth-width-8);
      const top = clamp(row.top-12,8,Math.max(8,innerHeight-height-8));
      setPosition(previous => previous?.left===left&&previous.top===top?previous:{left,top});
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(element);
    window.addEventListener('resize',align);
    window.addEventListener('scroll',align,true);
    return ()=>{
      observer.disconnect();
      window.removeEventListener('resize',align);
      window.removeEventListener('scroll',align,true);
    };
  },[anchor]);
  useLayoutEffect(() => {
    if (!position || initialFocus.current) return;
    initialFocus.current = true;
    panel.current?.querySelector<HTMLButtonElement>('.fill-mode-tabs [aria-pressed="true"]')?.focus({preventScroll:true});
  }, [position]);
  useEffect(()=>{
    const outside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || panel.current?.contains(target) ||
          target.closest('[aria-controls="prism-fill-popover"],.inspector-menu-popup[data-owner="prism-fill-popover"]')) return;
      if (editingGradient && target.closest('.editor-canvas')) return;
      onClose(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key!=='Escape') return;
      if (event.target instanceof Element && event.target.closest('.style-preset-name,[data-undo-draft]')) return;
      event.preventDefault();event.stopPropagation();onClose(true);
    };
    if (sampling) return;
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',escape,true);
    return ()=>{
      document.removeEventListener('pointerdown',outside,true);
      document.removeEventListener('keydown',escape,true);
    };
  },[anchor,editingGradient,onClose,sampling]);
  const setMode = (type: FillType) => {
    if (type===mode) return;
    setChoosingPattern(type==='pattern' && layerMode!=='pattern');
    if (type==='pattern' || type===layerMode) return;
    onEditStart();
    if (type==='image') {
      const fill = node.imageFill;
      onChange({fillMode:'image', ...(fill?.fit==='tile' ? {imageFill:{...fill,fit:'cover'}} : {})});
      return;
    }
    if (type==='solid') {
      onChange({fillMode:'solid', fill:node.fill==='transparent'?'#D2B87E':node.fill});
      return;
    }
    onChange({fillMode:'gradient',gradient:{kind:type,angle:node.gradient?.angle??0,
      stops:node.gradient?.stops??[[0,node.fill==='transparent'?'#D2B87E':node.fill],[1,'#FFFFFF']],
      stopIds:node.gradient ? gradientStopIds(node.gradient) : [uid(), uid()],
      ...(node.gradient && (node.gradient.kind??'linear')===type ? {endpoints:node.gradient.endpoints} : {}),
    }});
  };
  return createPortal(<div ref={panel} id="prism-fill-popover" className="fill-popover" role="dialog" aria-label="填充设置"
    style={{left:position?.left,top:position?.top,visibility:position?'visible':'hidden'}}>
    <div className="fill-popover-heading"><strong>填充设置</strong>
      <StyleAction label="关闭填充设置" onClick={()=>onClose(true)}><FillIcon name="close"/></StyleAction>
    </div>
    <div className="fill-mode-tabs" aria-label="填充类型">
      {fillOptions.map(({value,label,icon})=><button type="button" key={value} aria-pressed={mode===value}
        title={label} aria-label={label} disabled={pending||node.locked} onClick={()=>setMode(value)}>{icon}</button>)}
      <span>{fillOptions.find(option=>option.value===mode)?.label}</span>
    </div>
    <div className="fill-popover-body">
      {mode==='solid' && <SolidFillEditor node={node} onChange={onChange} onEditStart={onEditStart}/>}
      {(mode==='linear'||mode==='radial') && node.gradient && <GradientEditor node={node} gradient={node.gradient} disabled={node.locked}
        stylePresets={stylePresets} onStylePresetsChange={onStylePresetsChange} onChange={gradient=>onChange({gradient})}
        onEditStart={onEditStart} editing={editingGradient&&hasFill(node)} onToggleEditing={onToggleGradient}/>}
      {mode==='image' && <PictureFillEditor node={node} onChange={onChange} onEditStart={onEditStart}
        onCrop={()=>{onClose(false);onCrop()}} onPending={setPending} preserveImageCrop={preserveImageCrop}/>}
      {mode==='pattern' && <PatternFillEditor node={node} onEditStart={onEditStart} onPending={setPending} onChange={patch=>{
        setChoosingPattern(false);onChange(patch);
      }}/>}
    </div>
  </div>,document.body);
}

const strokePlacementOptions = [
  { value: 'center', label: '居中描边' },
  { value: 'inside', label: '内侧描边' },
  { value: 'outside', label: '外侧描边' },
];
const strokePlacementLabels = { center: '居中', inside: '内部', outside: '外部' };
const strokeStyleOptions = [
  { value: 'solid', label: '实线' },
  { value: 'dashed', label: '虚线' },
  { value: 'dotted', label: '点线' },
];

const effectNames: Record<VisualEffect['kind'], string> = {
  'drop-shadow': '投影', 'inner-shadow': '内阴影', 'gaussian-blur': '高斯模糊', 'radial-blur': '径向模糊',
};
const effectOptions = Object.entries(effectNames).map(([value, label]) => ({ value, label }));

function newVisualEffect(kind: VisualEffect['kind']): VisualEffect {
  const base = { id: uid(), enabled: true };
  if (kind === 'radial-blur') return { ...base, kind, center: [.5,.5], strength: .14 };
  if (kind === 'gaussian-blur') return { ...base, kind, radius: 3 };
  return { ...base, kind, x: 0, y: kind === 'inner-shadow' ? 2 : 3, spread: 0, radius: 4, color: '#000000', opacity: .28 };
}

type RadialEditing = { radialEditingId?: string; onToggleRadialEditing?: (id: string) => void };
type EffectPatch = Partial<VisualEffect>;

function EffectFields({ effect, disabled, radialEditingId, onToggleRadialEditing, onChange, onEditStart }: RadialEditing & {
  effect: VisualEffect; disabled: boolean; onChange: (patch: EffectPatch) => void; onEditStart: () => void;
}) {
  const millimeters = (key: 'radius' | 'x' | 'y' | 'spread', label: string, value: number, min: number, max: number) =>
    <ScrubField label={effectNames[effect.kind] + label} mark={label} unit="mm" value={value / 10}
      min={min} max={max} step={.05} disabled={disabled} onEditStart={onEditStart}
      onChange={next => onChange({ [key]: next * 10 })}/>;
  if (effect.kind === 'radial-blur') {
    const radialEditing = effect.id === radialEditingId;
    return <div className="effect-fields">
      <div className="style-fields">
        {(['X', 'Y'] as const).map((axis, index) => <ScrubField key={axis} label={'径向中心 ' + axis} mark={axis}
          unit="%" value={effect.center[index] * 100} min={0} max={100} step={1} disabled={disabled} onEditStart={onEditStart}
          onChange={value => onChange({ center: index === 0 ? [value / 100, effect.center[1]] : [effect.center[0], value / 100] })}/>)}
      </div>
      <div className="effect-position-controls">
        <ScrubField label="径向模糊强度" mark="强度" unit="%" value={effect.strength * 100}
          min={0} max={100} step={1} disabled={disabled} onEditStart={onEditStart} onChange={value => onChange({ strength: value / 100 })}/>
        {onToggleRadialEditing && <StyleAction label={radialEditing ? '结束调整模糊中心' : '在画布调整模糊中心'} pressed={radialEditing}
          disabled={disabled || !effect.enabled} onClick={() => onToggleRadialEditing(effect.id)}><Crosshair size={14}/></StyleAction>}
        <StyleAction label="重置模糊中心" disabled={disabled || effect.center.every(point => point === .5)}
          onClick={() => { onEditStart(); onChange({ center: [.5,.5] }); }}><RotateCcw size={14}/></StyleAction>
      </div>
    </div>;
  }
  if (effect.kind === 'gaussian-blur') return <div className="effect-fields">{millimeters('radius', '半径', effect.radius, 0, 50)}</div>;
  return <div className="effect-fields">
    <div className="style-fields">
      {millimeters('x', 'X', effect.x, -50, 50)}{millimeters('y', 'Y', effect.y, -50, 50)}
      {millimeters('radius', '模糊', effect.radius, 0, 50)}{millimeters('spread', '扩散', effect.spread, -10, 10)}
    </div>
    <div className="paint-value">
      <ColorControl label={effectNames[effect.kind] + '颜色'} color={effect.color} disabled={disabled} onEditStart={onEditStart}
        onChange={color => onChange({ color })}/>
      <ScrubField label={effectNames[effect.kind] + '不透明度'} unit="%" value={effect.opacity * 100}
        min={0} max={100} step={1} disabled={disabled} onEditStart={onEditStart} onChange={value => onChange({ opacity: value / 100 })}/>
    </div>
  </div>;
}

function EffectsSection({ node, onChange, onEditStart, radialEditingId, onToggleRadialEditing, stylePresets, onStylePresetsChange }:
  EditingProps & RadialEditing & ProjectPresets & { node: CardNode }) {
  const [expanded, setExpanded] = useState<string>();
  const effects = node.visualEffects ?? [];
  const commit = (list: VisualEffect[]) => {
    onEditStart();
    onChange({ visualEffects: list });
  };
  const patchEffect = (effect: VisualEffect, patch: EffectPatch) => onChange({
    visualEffects: effects.map(item => item.id === effect.id ? { ...item, ...patch } as VisualEffect : item),
  });
  const reorder = (index: number, delta: number) => {
    const next = [...effects];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    commit(next);
  };
  return <StyleSection title="效果" className="style-effects-section" actions={<InspectorMenu ariaLabel="添加图层效果"
    options={effectOptions} variant="action" menuWidth={145} className="effects-add" triggerIcon={<FigmaIcon name="section-add"/>}
    disabled={node.locked || effects.length >= MAX_VISUAL_EFFECTS} onChange={value => {
      const effect = newVisualEffect(value as VisualEffect['kind']);
      commit([...effects, effect]);
      setExpanded(effect.id);
    }}/>}>
    {effects.map((effect, index) => {
      const name = effectNames[effect.kind];
      const open = effect.id === expanded;
      const closeCanvas = () => {
        if (effect.id === radialEditingId) onToggleRadialEditing?.(effect.id);
      };
      return <div className="style-effect" key={effect.id} data-disabled={!effect.enabled}>
        <div className="style-effect-row">
          <button type="button" className="style-effect-toggle" aria-expanded={open} onClick={() => {
            if (radialEditingId) onToggleRadialEditing?.(radialEditingId);
            setExpanded(open ? undefined : effect.id);
          }}><ChevronDown size={12}/><span>{name}</span></button>
          <StyleAction label={`上移${name}`} disabled={node.locked || index === 0} onClick={() => reorder(index, -1)}><ChevronUp size={14}/></StyleAction>
          <StyleAction label={`下移${name}`} disabled={node.locked || index === effects.length - 1} onClick={() => reorder(index, 1)}><ChevronDown size={14}/></StyleAction>
          <StyleAction label={(effect.enabled ? '关闭' : '开启') + name} disabled={node.locked} onClick={() => {
            closeCanvas(); onEditStart(); patchEffect(effect, { enabled: !effect.enabled });
          }}>{effect.enabled ? <FigmaIcon name="paint-eye"/> : <EyeOff size={14}/>}</StyleAction>
          <StyleAction label={'移除' + name} disabled={node.locked} onClick={() => {
            closeCanvas(); commit(effects.filter(item => item.id !== effect.id));
          }}><FigmaIcon name="paint-remove"/></StyleAction>
        </div>
        {open && <EffectFields effect={effect} disabled={node.locked} radialEditingId={radialEditingId}
          onToggleRadialEditing={onToggleRadialEditing} onEditStart={onEditStart} onChange={patch => patchEffect(effect, patch)}/>}
      </div>;
    })}
    {(effects.length > 0 || stylePresets?.some(preset => preset.kind === 'effects')) && <StylePresets
      value={{ kind: 'effects', effects }} stylePresets={stylePresets} onStylePresetsChange={onStylePresetsChange}
      canSave={effects.length > 0} disabled={node.locked} onApply={preset => {
        if (preset.kind !== 'effects') return;
        if (radialEditingId) onToggleRadialEditing?.(radialEditingId);
        const next = structuredClone(preset.effects).map(effect => ({ ...effect, id: uid() }));
        commit(next);
        setExpanded(next[0]?.id);
      }}/>}
  </StyleSection>;
}

export function LayerAppearanceEditor({ node, onChange, onEditStart, editingGradient, onToggleGradient, onCrop, preserveImageCrop,
  radialEditingId, onToggleRadialEditing, stylePresets, onStylePresetsChange, children }: EditingProps & RadialEditing & ProjectPresets & {
  node: CardNode; editingGradient: boolean; onToggleGradient: () => void; onCrop: () => void; preserveImageCrop: boolean;
  children?: ReactNode;
}) {
  const [fillOpen,setFillOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const fillOpener = useRef<HTMLButtonElement>(null);
  const disabled = node.locked;
  const openVector = isOpenVector(node);
  const mode = fillType(node);
  const hasRadius = node.type === 'rect' || node.type === 'image';
  const fillDefined = mode === 'image' || mode === 'pattern' || mode === 'solid' && node.fill !== 'transparent' ||
    (mode === 'linear' || mode === 'radial') && Boolean(node.gradient);
  const strokeDefined = Boolean(node.stroke && node.strokeWidth);
  const setStyle = (patch: Partial<CardNode>) => { onEditStart(); onChange(patch); };
  const closeFill = (restoreFocus: boolean) => {
    setFillOpen(false);
    if (editingGradient) onToggleGradient();
    if (restoreFocus) fillOpener.current?.focus({preventScroll:true});
  };
  const toggleFill = (event: MouseEvent<HTMLButtonElement>) => {
    if (fillOpen) { closeFill(false); return; }
    fillOpener.current = event.currentTarget;
    if (!fillDefined) setStyle({fillMode:'solid',fill:'#D2B87E',fillHidden:false});
    setFillOpen(true);
  };
  const removeFill = () => {
    closeFill(false);
    setStyle({fillMode:'solid',fill:'transparent',gradient:undefined,imageFill:undefined,fillHidden:undefined,fillOpacity:undefined});
  };
  const gradient = mode==='linear'||mode==='radial' ? node.gradient : undefined;
  const appearance = mode==='solid' ? readHex(node.fill) : fillOptions.find(option=>option.value===mode)?.label;
  const strokePlacement = node.strokeAlign ?? 'center';
  const strokeStyle = node.strokeStyle ?? 'solid';
  return <>
    <StyleSection title="外观" className="style-appearance-section" actions={<StyleAction label={node.visible ? '隐藏图层' : '显示图层'} disabled={disabled}
      onClick={() => setStyle({visible: !node.visible})}>
      {node.visible ? <FigmaIcon name="appearance-eye"/> : <EyeOff size={14}/>}
    </StyleAction>}>
      <div className="style-fields">
        <div className="style-property"><span className="style-caption">不透明度</span>
          <ScrubField label="图层不透明度" mark="▣" unit="%" value={node.opacity * 100}
            min={0} max={100} step={1} disabled={disabled} onEditStart={onEditStart} onChange={value => onChange({ opacity: value / 100 })}/>
        </div>
        {hasRadius && <div className="style-property"><span className="style-caption">圆角半径</span>
          <ScrubField label="圆角" mark={<FigmaIcon name="appearance-corner"/>} unit="mm" value={(node.cornerRadius ?? 0) / 10}
            min={0} max={Math.min(node.width,node.height)/20} disabled={disabled} onEditStart={onEditStart}
            onChange={radius => onChange({ cornerRadius: radius * 10 })}/>
        </div>}
      </div>
    </StyleSection>
    {!openVector && <StyleSection title="填充" className="style-fill-section" actions={<button type="button" className="style-icon" aria-haspopup="dialog"
      aria-label={fillDefined ? '打开填充设置' : '添加填充'} title={fillDefined ? '打开填充设置' : '添加填充'}
      aria-expanded={fillOpen} aria-controls={fillOpen?'prism-fill-popover':undefined} disabled={disabled} onClick={toggleFill}>
      <FigmaIcon name="section-add"/>
    </button>}>
      {fillDefined && <div className="paint-value-row">
        <div className="paint-value">
          <button ref={trigger} type="button" className="fill-summary" title="编辑填充" aria-label="编辑填充" aria-haspopup="dialog"
            aria-expanded={fillOpen} aria-controls={fillOpen?'prism-fill-popover':undefined} disabled={disabled}
            onClick={toggleFill}>
            {mode==='image' || mode==='pattern'
              ? <span className="fill-summary-swatch">{getImageFill(node)?<CroppedImage node={node}/>:<ImageIcon size={13}/>}</span>
              : gradient ? <span className="fill-summary-swatch"><GradientSwatch className="gradient-summary" stops={gradient.stops}/></span>
              : <span className="fill-summary-swatch" style={{'--fill-preview':node.fill} as React.CSSProperties}/>}
            <span>{appearance}</span>
          </button>
          <ScrubField label="填充不透明度" unit="%" value={(node.fillOpacity ?? 1)*100}
            min={0} max={100} step={1} disabled={disabled} onEditStart={onEditStart} onChange={value => onChange({fillOpacity:value/100})}/>
        </div>
        <StyleAction label={node.fillHidden?'显示填充':'隐藏填充'} disabled={disabled} onClick={() => setStyle({fillHidden:!node.fillHidden})}>
          {node.fillHidden ? <EyeOff size={14}/> : <FigmaIcon name="paint-eye"/>}
        </StyleAction>
        <StyleAction label="移除填充" disabled={disabled} onClick={removeFill}><FigmaIcon name="paint-remove"/></StyleAction>
      </div>}
      {fillOpen && fillDefined && <FillPopover anchor={trigger} node={node} onClose={closeFill} onChange={onChange}
        onEditStart={onEditStart} editingGradient={editingGradient} onToggleGradient={onToggleGradient}
        onCrop={onCrop} preserveImageCrop={preserveImageCrop} stylePresets={stylePresets} onStylePresetsChange={onStylePresetsChange}/>}
    </StyleSection>}
    {children}
    <StyleSection title="描边" className="style-stroke-section" actions={!strokeDefined && <StyleAction label="添加描边" disabled={disabled}
      onClick={() => setStyle({ stroke:'#202020', strokeWidth:2, strokeHidden:undefined })}><FigmaIcon name="section-add"/></StyleAction>}>
      {strokeDefined && <>
        <div className="paint-value-row">
          <div className="paint-value">
            <ColorControl label="描边颜色" color={node.stroke!} disabled={disabled} onEditStart={onEditStart} onChange={stroke => onChange({ stroke })}/>
            <ScrubField label="描边不透明度" unit="%" value={(node.strokeOpacity ?? 1) * 100} min={0}
              max={100} step={1} disabled={disabled} onEditStart={onEditStart} onChange={value => onChange({ strokeOpacity: value / 100 })}/>
          </div>
          <StyleAction label={node.strokeHidden?'显示描边':'隐藏描边'} disabled={disabled} onClick={() => setStyle({ strokeHidden: !node.strokeHidden })}>
            {node.strokeHidden ? <EyeOff size={14}/> : <FigmaIcon name="paint-eye"/>}
          </StyleAction>
          <StyleAction label="移除描边" disabled={disabled} onClick={() => setStyle({ stroke: undefined, strokeWidth: undefined, strokeHidden: undefined })}><FigmaIcon name="paint-remove"/></StyleAction>
        </div>
        <div className="style-fields style-stroke-geometry">
          <ScrubField label="描边宽度" mark="宽度" unit="mm" value={(node.strokeWidth ?? 0) / 10}
            min={.01} max={100} step={.05} disabled={disabled} onEditStart={onEditStart} onChange={value => onChange({ strokeWidth: value * 10 })}/>
          {node.type !== 'text' && !openVector && <InspectorMenu className="style-stroke-placement" ariaLabel="描边位置"
            menuTitle="描边位置" menuWidth={188} disabled={disabled} value={strokePlacement} options={strokePlacementOptions}
            displayValue={strokePlacementLabels[strokePlacement]}
            onChange={value => setStyle({ strokeAlign: value as CardNode['strokeAlign'] })}/>}
        </div>
        {node.type !== 'text' && <InspectorMenu className="style-stroke-kind" ariaLabel="描边样式"
          menuTitle="描边样式" menuWidth={188} disabled={disabled} value={strokeStyle} options={strokeStyleOptions}
          displayValue={<span className="style-stroke-kind-value"><span className="style-caption">样式</span>
            {strokeStyleOptions.find(option => option.value === strokeStyle)?.label}</span>}
          onChange={value => setStyle({ strokeStyle: value as CardNode['strokeStyle'] })}/>}
      </>}
    </StyleSection>
    <EffectsSection node={node} onChange={onChange} onEditStart={onEditStart} radialEditingId={radialEditingId}
      onToggleRadialEditing={onToggleRadialEditing} stylePresets={stylePresets} onStylePresetsChange={onStylePresetsChange}/>
  </>;
}
