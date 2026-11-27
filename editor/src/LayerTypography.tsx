import { useEffect, useMemo, useRef, useState } from 'react';
import FigmaIcon from './FigmaIcon';
import InspectorMenu, { type InspectorMenuOption } from './InspectorMenu';
import { ScrubField, StyleAction, StyleSection } from './LayerStylePanel';
import {
  artworkFontProblem, artworkFontReady, BUILTIN_ARTWORK_FONTS, canReadDeviceFonts, ensureArtworkFont,
  fontFamilyKey, fontReferenceName, fontReferenceWeight, fontRefKey, fontWeightOptions, getFontCatalog,
  importArtworkFont, importedFontShareable, loadFontCatalog, requestDeviceFonts, useFontRevision, type ArtworkFontReference,
} from './artworkFonts';
import { FONT_FILE_ACCEPT } from './fontOpenType';
import type { CardNode } from './model';
import { clippedText } from './render';
import './font-inspector.css';

const fonts = [
  { value: 'PingFang SC, Microsoft YaHei, sans-serif', label: '苹方' },
  { value: 'Work Sans, PingFang SC, sans-serif', label: 'Work Sans' },
  { value: 'Songti SC, Georgia, serif', label: '宋体' },
];
const weights = [
  { value: 'normal', label: 'Regular' },
  { value: 'bold', label: 'Bold' },
  { value: 'italic', label: 'Italic' },
  { value: 'italic bold', label: 'Bold Italic' },
];
const sizeOptions = [8, 10, 12, 14, 16, 18, 24, 32, 36, 48, 64, 72]
  .map(size => ({ value: String(size), label: String(size) }));
const horizontal = [
  ['left', '左对齐', 'type-align-left'],
  ['center', '水平居中', 'type-align-center'],
  ['right', '右对齐', 'type-align-right'],
] as const;
const vertical = [
  ['top', '顶部对齐', 'type-align-top'],
  ['middle', '垂直居中', 'type-align-middle'],
  ['bottom', '底部对齐', 'type-align-bottom'],
] as const;

export type FontPreviewStyle = Pick<CardNode, 'fontRef' | 'fontFamily' | 'fontStyle'>;

function fontStylePatch(ref: ArtworkFontReference): FontPreviewStyle {
  return { fontRef: ref, fontFamily: fontReferenceName(ref), fontStyle: 'normal' };
}

export default function LayerTypography({ node, onChange, onEditStart, onPreview }: {
  node: CardNode;
  onChange: (patch: Partial<CardNode>) => void;
  onEditStart: () => void;
  onPreview?: (patch?: FontPreviewStyle) => void;
}) {
  const revision = useFontRevision();
  const filePicker = useRef<HTMLInputElement>(null);
  const active = useRef({ node, onChange, onEditStart, onPreview });
  active.current = { node, onChange, onEditStart, onPreview };
  const mounted = useRef(false);
  const previewRequest = useRef(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [fontProblem, setFontProblem] = useState('');
  const clipping = useMemo(() => {
    const context = document.createElement('canvas').getContext('2d');
    return context && !fontProblem && node.text?.trim() ? clippedText(context, node) : undefined;
  }, [node, fontProblem, revision]);
  useEffect(() => {
    mounted.current = true;
    void loadFontCatalog();
    return () => { mounted.current = false; previewRequest.current++; };
  }, []);
  useEffect(() => { setStatus(''); }, [node.id]);
  useEffect(() => {
    if (!node.fontRef) { setFontProblem(''); return; }
    let current = true;
    void artworkFontProblem(node).then(value => { if (current) setFontProblem(value || ''); });
    return () => { current = false; };
  }, [node.fontRef, node.text, revision]);
  const size = node.fontSize || 24;
  const family = node.fontFamily || fonts[1].value;
  const familyName = family.split(',')[0].trim();
  const familyOption = fonts.find(font => font.value.startsWith(familyName + ','));
  const selectedFont = node.fontRef;
  const catalog = getFontCatalog();
  const families = new Map<string, ArtworkFontReference[]>();
  for (const ref of [...catalog.device, ...catalog.imported]) {
    const key = fontFamilyKey(ref);
    const list = families.get(key);
    if (list) list.push(ref);
    else families.set(key, [ref]);
  }
  const selectedFamily = selectedFont ? fontFamilyKey(selectedFont) : familyOption?.value ?? family;
  const availableFamilies = new Set(families.keys());
  if (selectedFont && selectedFont.kind !== 'builtin' && !families.get(selectedFamily)?.some(ref => fontRefKey(ref) === fontRefKey(selectedFont))) {
    families.set(selectedFamily, [...(families.get(selectedFamily) ?? []), selectedFont]);
  }
  const fontOptions: InspectorMenuOption[] = [
    ...Object.entries(BUILTIN_ARTWORK_FONTS).map(([id, spec]) => ({
      value: id, label: spec.family, group: spec.language,
    })),
    ...[...families].map(([value, options]) => ({
      value, label: fontReferenceName(options[0]), group: !availableFamilies.has(value)
        ? '当前字体' : options[0].kind === 'device' ? '设备字体' : '导入字体',
    })),
    ...(!selectedFont ? [{ value: selectedFamily, label: familyOption?.label ?? familyName, group: '当前字体' }] : []),
  ];
  const weight = node.fontStyle || 'normal';
  const currentWeight = selectedFont ? selectedFont.kind === 'builtin' ? String(selectedFont.weight) : fontRefKey(selectedFont) : weight;
  const weightOptions = selectedFont
    ? selectedFont.kind === 'builtin' ? fontWeightOptions(selectedFont.id)
      : (families.get(selectedFamily) ?? [selectedFont]).map(ref => ({ value: fontRefKey(ref), label: fontReferenceWeight(ref) }))
    : weights.some(option => option.value === weight) ? weights : [...weights, { value: weight, label: weight }];
  const disabled = node.locked;
  const chevron = <FigmaIcon name="type-chevron"/>;
  const commit = (patch: Partial<CardNode>) => {
    onEditStart();
    onChange(patch);
  };
  const run = async (task: () => Promise<ArtworkFontReference | void>) => {
    const layer = node.id;
    previewRequest.current++;
    onPreview?.();
    setBusy(true);
    setStatus('');
    try {
      const ref = await task();
      const next = active.current;
      if (ref && mounted.current && next.node.id === layer && !next.node.locked) {
        next.onEditStart();
        next.onChange(fontStylePatch(ref));
      }
    } catch (error) {
      if (mounted.current && active.current.node.id === layer) setStatus(error instanceof Error ? error.message : '字体加载失败。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const chooseFont = (ref: ArtworkFontReference) => {
    if (selectedFont?.kind === 'imported' && ref.kind === 'imported' && selectedFont.id === ref.id) return;
    void run(async () => {
      const { problem } = await ensureArtworkFont({ fontRef: ref });
      if (problem) throw new Error(problem);
      return ref;
    });
  };
  const familyReference = (value: string): ArtworkFontReference | undefined => {
    if (Object.hasOwn(BUILTIN_ARTWORK_FONTS, value)) {
      const id = value as keyof typeof BUILTIN_ARTWORK_FONTS;
      return { kind: 'builtin', id, weight: selectedFont?.kind === 'builtin'
        ? Math.max(BUILTIN_ARTWORK_FONTS[id].minWeight, selectedFont.weight) : weight.includes('bold') ? 700 : 400 };
    }
    const entries = families.get(value);
    return entries?.find(item => /^(regular|book|roman|normal|常规)$/i.test(fontReferenceWeight(item))) ?? entries?.[0];
  };
  const chooseFamily = (value: string) => {
    const ref = familyReference(value);
    if (ref) chooseFont(ref);
  };
  const previewFamily = async (value?: string) => {
    const request = ++previewRequest.current;
    if (!onPreview) return;
    const ref = value && !disabled && !busy ? familyReference(value) : undefined;
    const patch = ref ? fontStylePatch(ref) : undefined;
    if (patch && artworkFontReady(patch)) { onPreview(patch); return; }
    onPreview();
    if (!patch) return;
    try {
      const { problem } = await ensureArtworkFont(patch);
      const next = active.current;
      if (!problem && request === previewRequest.current && mounted.current && next.node === node && !next.node.locked) {
        next.onPreview?.(patch);
      }
    } catch { /* Keep the committed font when a preview cannot load. */ }
  };
  const chooseWeight = (value: string) => {
    if (!selectedFont) { commit({ fontStyle: value }); return; }
    if (selectedFont.kind === 'builtin') { chooseFont({ ...selectedFont, weight: Number(value) }); return; }
    const ref = families.get(selectedFamily)?.find(item => fontRefKey(item) === value);
    if (ref) chooseFont(ref);
  };
  if (canReadDeviceFonts()) fontOptions.push({
    value: 'device-permission', label: catalog.device.length ? '刷新设备字体' : '使用设备字体',
    group: '添加字体', action: () => { void run(requestDeviceFonts); },
  });
  fontOptions.push({ value: 'import-font-file', label: '导入字体文件…', group: '添加字体', action: () => filePicker.current?.click() });

  return <StyleSection title="字体排印" className="style-typography">
    <input type="file" ref={filePicker} accept={FONT_FILE_ACCEPT} hidden onChange={event => {
      const [file] = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = '';
      if (file) void run(async () => {
        const ref = await importArtworkFont(file);
        if (selectedFont?.kind === 'imported' && selectedFont.id === ref.id) return { ...ref, share: selectedFont.share };
        return ref;
      });
    }}/>
    <InspectorMenu ariaLabel="字体" className="type-menu" value={selectedFamily}
      options={fontOptions} chevronIcon={chevron} disabled={disabled || busy} onChange={chooseFamily}
      onOptionPreview={onPreview ? previewFamily : undefined}/>
    {(busy || status || fontProblem) && <div className="style-font-status" role="status">{busy ? '正在加载字体…' : status || fontProblem}</div>}
    {selectedFont?.kind === 'imported' && importedFontShareable(selectedFont) && <label className="style-font-share">
      <input type="checkbox" checked={selectedFont.share ?? false} disabled={disabled} onChange={event =>
        commit({ fontRef: { ...selectedFont, share: event.currentTarget.checked } })}/>
      允许随项目包分发和转曲
    </label>}
    <div className="style-fields">
      <InspectorMenu ariaLabel="字重" className="type-menu" value={currentWeight} options={weightOptions}
        chevronIcon={chevron} disabled={disabled || busy} onChange={chooseWeight}/>
      <div className="type-size">
        <ScrubField label="字号" value={size} min={6} max={240} step={1} disabled={disabled}
          onEditStart={onEditStart} onChange={fontSize => onChange({fontSize})}/>
        <InspectorMenu ariaLabel="字号预设" className="type-size-menu" value={String(size)}
          options={sizeOptions} triggerIcon={chevron} disabled={disabled} onChange={value => commit({fontSize: Number(value)})}/>
      </div>
    </div>
    <div className="style-fields">
      <div className="style-property">
        <span className="style-caption">行高</span>
        <ScrubField label="行高" mark={<FigmaIcon name="type-line-height"/>} value={(node.lineHeight || 1.3) * size}
          min={.8 * size} max={3 * size} step={.5} disabled={disabled} onEditStart={onEditStart}
          onChange={value => onChange({lineHeight: Math.max(.8, Math.min(3, value / size))})}/>
      </div>
      <div className="style-property">
        <span className="style-caption">字距</span>
        <ScrubField label="字距" mark={<FigmaIcon name="type-letter-spacing"/>} unit="%" value={(node.letterSpacing || 0) * 100 / size}
          min={-10000 / size} max={10000 / size} step={1} disabled={disabled} onEditStart={onEditStart}
          onChange={value => onChange({letterSpacing: Math.max(-100, Math.min(100, value * size / 100))})}/>
      </div>
    </div>
    <div className="style-property">
      <span className="style-caption">对齐</span>
      <div className="style-fields">
        <div className="style-segmented" role="group" aria-label="文字水平对齐">
          {horizontal.map(([align, label, icon]) => <StyleAction key={align} label={label} disabled={disabled}
            pressed={(node.align || 'left') === align} onClick={() => commit({align})}><FigmaIcon name={icon}/></StyleAction>)}
        </div>
        <div className="style-segmented" role="group" aria-label="文字垂直对齐">
          {vertical.map(([verticalAlign, label, icon]) => <StyleAction key={verticalAlign} label={label} disabled={disabled}
            pressed={(node.verticalAlign || 'top') === verticalAlign} onClick={() => commit({verticalAlign})}><FigmaIcon name={icon}/></StyleAction>)}
        </div>
      </div>
    </div>
    {clipping&&<button type="button" className="button wide-button" disabled={disabled}
      onClick={()=>commit({height:Math.ceil(clipping.minHeight*10),layoutItem:node.layoutItem?{...node.layoutItem,heightMode:'fixed'}:undefined})}>按内容扩高</button>}
  </StyleSection>;
}
