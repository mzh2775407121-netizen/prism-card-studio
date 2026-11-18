import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { EyeOff, Image as ImageIcon } from 'lucide-react';
import { MAX_GRADIENT_STOPS, MIN_GRADIENT_STOPS, fillType, getImageFill, gradientPoints, hasFill, hasStroke, type FillType } from './layerAppearance';
import { CroppedImage } from './CropEditor';
import { readImage } from './io';
import type { CardNode, GradientPoint, LayerGradient } from './model';
import { isOpenVector } from './vectorPaths';
import FigmaIcon from './FigmaIcon';
import InspectorMenu from './InspectorMenu';
import './layer-styles.css';
import './fill-popover.css';

type EditingProps = { onEditStart: () => void; onChange: (patch: Partial<CardNode>) => void };
const tidy = (value: number) => Number(value.toFixed(3));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

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

export function LayerGeometry({ node, onChange, onEditStart, children }: EditingProps & { node: CardNode; children: ReactNode }) {
  const fields = [['x','X','水平位置'],['y','Y','垂直位置'],['width','宽','宽度'],['height','高','高度']] as const;
  const geometryFields = fields.map(([key, mark, label]) => <ScrubField key={key} label={label + '（毫米）'}
    mark={mark} value={node[key] / 10}
    min={key === 'width' || key === 'height' ? .1 : -10000} disabled={node.locked} onEditStart={onEditStart}
    onChange={value => onChange({ [key]: value * 10 })}/>);
  const rotate = (degrees: number) => {
    const angle = (degrees + 360) % 360;
    onEditStart(); onChange({ rotation: angle > 180 ? angle - 360 : angle });
  };
  return <>
    <StyleSection title="位置" className="style-geometry-position">
      <div className="style-property"><span className="style-caption">对齐</span>{children}</div>
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
  const exact = readHex(color);
  const picker = (window as EyeDropperWindow).EyeDropper;
  return <div className="style-color-control">
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
    {picker && <button type="button" className="style-icon" title="从屏幕取色" aria-label={label + '取色'} disabled={disabled}
      onClick={async () => {
        try { const { sRGBHex } = await new picker().open(); onEditStart(); onChange(sRGBHex); }
        catch { /* Escape cancels the browser's eyedropper. */ }
      }}><FillIcon name="eyedropper"/></button>}
  </div>;
}

const sortedStops = (stops: LayerGradient['stops']) => [...stops].sort((left, right) => left[0] - right[0]);

function colorAt(stops: LayerGradient['stops'], offset: number) {
  const colors = sortedStops(stops);
  const right = colors.findIndex(([position]) => position >= offset);
  if (right <= 0) return colors[right === 0 ? 0 : colors.length - 1][1];
  const [a, colorA] = colors[right - 1], [b, colorB] = colors[right];
  const t = b === a ? 1 : (offset - a) / (b - a);
  const hexA = readHex(colorA).padEnd(9,'F'), hexB = readHex(colorB).padEnd(9,'F');
  const channels = [1,3,5,7].map(index => {
    const x = parseInt(hexA.slice(index,index+2),16), y = parseInt(hexB.slice(index,index+2),16);
    return Math.round(x + (y-x) * t).toString(16).padStart(2,'0');
  });
  return '#' + channels.join('').replace(/ff$/, 'FF');
}

function GradientEditor({ node, gradient, disabled, onChange, onEditStart, editing, onToggleEditing }: {
  node: CardNode; gradient: LayerGradient; disabled: boolean; editing: boolean; onToggleEditing: () => void;
  onChange: (gradient: LayerGradient) => void; onEditStart: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const active = Math.min(selected, gradient.stops.length - 1);
  const ramp = useRef<HTMLDivElement>(null);
  const moving = useRef<{ index: number; pointer: number } | null>(null);
  const stops = gradient.stops;
  const canAdd = !disabled && stops.length < MAX_GRADIENT_STOPS;
  const canRemove = !disabled && stops.length > MIN_GRADIENT_STOPS;
  const changeStop = (index: number, stop: [number, string]) => onChange({
    ...gradient, stops: stops.map((item, i) => index === i ? stop : item),
  });
  const addStop = (position: number) => {
    if (!canAdd) return;
    const offset = tidy(position);
    onEditStart();
    onChange({ ...gradient, stops: [...stops, [offset, colorAt(stops, offset)]] });
    setSelected(stops.length);
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
    onChange({ ...gradient, stops: stops.filter((_, i) => i !== index) });
    setSelected(index < active || index === active && index === stops.length - 1 ? Math.max(0, active - 1) : active);
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
    <div className="gradient-ramp" ref={ramp} onPointerDown={event => {
      if (event.target === event.currentTarget && event.button === 0) addStop(rampOffset(event));
    }} title="点击渐变条添加色标">
      <div className="gradient-spectrum" style={{ backgroundImage: 'linear-gradient(90deg, '+sortedStops(stops).map(([offset,color]) => `${color} ${offset * 100}%`).join(', ')+')' }}/>
      {stops.map(([offset, color], index) => <button type="button" key={index} role="slider" aria-label={`色标 ${index+1}`}
        aria-valuenow={Math.round(offset * 100)} aria-valuemin={0} aria-valuemax={100}
        aria-valuetext={`${Math.round(offset * 100)}%，${readHex(color)}`} disabled={disabled}
        className={index === active ? 'gradient-stop selected' : 'gradient-stop'}
        style={{ left: (offset * 100)+'%', '--swatch': color } as React.CSSProperties}
        onFocus={() => setSelected(index)}
        onPointerDown={event => {
          if (event.button !== 0) return;
          setSelected(index); onEditStart();
          moving.current = { index, pointer: event.pointerId };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          if (moving.current?.pointer !== event.pointerId || moving.current.index !== index) return;
          changeStop(index,[tidy(rampOffset(event)),color]);
        }}
        onLostPointerCapture={() => { moving.current = null; }}
        onKeyDown={event => {
          const step = event.shiftKey ? .1 : .01;
          if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : clamp(offset + (event.key === 'ArrowLeft' ? -step : step),0,1);
          changeStop(index,[tidy(next),color]);
        }}/>)}
    </div>
    <div className="gradient-stops-heading">
      <span>色标</span>
      <div className="gradient-stops-actions">
        <StyleAction label={editing ? '结束画布调节' : '画布调节'} pressed={editing}
          disabled={disabled || !node.visible || node.fillHidden} onClick={onToggleEditing}><FillIcon name="crop"/></StyleAction>
        <StyleAction label="添加色标" disabled={!canAdd} onClick={() => addStop(nextPosition())}><FillIcon name="add-stop"/></StyleAction>
      </div>
    </div>
    <div className="gradient-stops-list">
      {stops.map(([offset,color],index)=>({offset,color,index})).sort((a,b)=>a.offset-b.offset).map(({offset,color,index}) => {
        const suffix = index === active ? '' : ' ' + (index + 1);
        return <div className={`gradient-stop-row${index === active ? ' is-current' : ''}`} key={index}
          onFocus={() => setSelected(index)}>
          <ScrubField label={'色标位置'+suffix} value={offset*100} min={0} max={100} step={1} unit="%"
            disabled={disabled} onEditStart={onEditStart} onChange={value => changeStop(index,[value/100,color])}/>
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
      const crop = preserveImageCrop && fill?.crop?.space === 'source' ? fill.crop : undefined;
      const imageFill = { src:image.src, fit:fill?.fit, crop };
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
  </div>;
}

function FillPopover({ anchor, node, onChange, onEditStart, onClose, editingGradient, onToggleGradient, onCrop, preserveImageCrop }: EditingProps & {
  anchor: RefObject<HTMLButtonElement | null>; node: CardNode; onClose: (restoreFocus: boolean) => void;
  editingGradient: boolean; onToggleGradient: () => void; onCrop: () => void; preserveImageCrop: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(false);
  const [position,setPosition] = useState<{ left:number; top:number }>();
  const [pending,setPending] = useState(false);
  const mode = fillType(node);
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
      event.preventDefault();event.stopPropagation();onClose(true);
    };
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',escape,true);
    return ()=>{
      document.removeEventListener('pointerdown',outside,true);
      document.removeEventListener('keydown',escape,true);
    };
  },[anchor,editingGradient,onClose]);
  const setMode = (type: FillType) => {
    if (type===mode) return;
    onEditStart();
    if (type==='image') { onChange({fillMode:'image'});return; }
    if (type==='solid') {
      onChange({fillMode:'solid', fill:node.fill==='transparent'?'#D2B87E':node.fill});
      return;
    }
    onChange({fillMode:'gradient',gradient:{kind:type,angle:node.gradient?.angle??0,
      stops:node.gradient?.stops??[[0,node.fill==='transparent'?'#D2B87E':node.fill],[1,'#FFFFFF']],
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
        onChange={gradient=>onChange({gradient})} onEditStart={onEditStart} editing={editingGradient&&hasFill(node)} onToggleEditing={onToggleGradient}/>}
      {mode==='image' && <PictureFillEditor node={node} onChange={onChange} onEditStart={onEditStart}
        onCrop={()=>{onClose(false);onCrop()}} onPending={setPending} preserveImageCrop={preserveImageCrop}/>}
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

export function LayerAppearanceEditor({ node, onChange, onEditStart, editingGradient, onToggleGradient, onCrop, preserveImageCrop, children }: EditingProps & {
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
  const fillDefined = mode === 'image' || mode === 'solid' && node.fill !== 'transparent' ||
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
  const preview = gradient ? 'linear-gradient(90deg, '+sortedStops(gradient.stops)
    .map(([pos,color])=>color+' '+pos*100+'%').join(', ')+')' : node.fill;
  const appearance = mode==='solid' ? readHex(node.fill) : fillOptions.find(option=>option.value===mode)?.label;
  const strokePlacement = node.strokeAlign ?? 'center';
  const strokeStyle = node.strokeStyle ?? 'solid';
  return <>
    <StyleSection title="外观" actions={<StyleAction label={node.visible ? '隐藏图层' : '显示图层'} disabled={disabled}
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
            {mode==='image' ? <span className="fill-summary-swatch">{getImageFill(node)?<CroppedImage node={node}/>:<ImageIcon size={13}/>}</span>
              : <span className="fill-summary-swatch" style={{'--fill-preview':preview} as React.CSSProperties}/>}
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
        onCrop={onCrop} preserveImageCrop={preserveImageCrop}/>}
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
  </>;
}
