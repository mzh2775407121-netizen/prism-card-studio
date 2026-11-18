import FigmaIcon from './FigmaIcon';
import InspectorMenu from './InspectorMenu';
import { ScrubField, StyleAction, StyleSection } from './LayerStylePanel';
import type { CardNode } from './model';

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

export default function LayerTypography({ node, onChange, onEditStart }: {
  node: CardNode;
  onChange: (patch: Partial<CardNode>) => void;
  onEditStart: () => void;
}) {
  const size = node.fontSize || 24;
  const family = node.fontFamily || fonts[1].value;
  const familyName = family.split(',')[0].trim();
  const familyOption = fonts.find(font => font.value.startsWith(familyName + ','));
  const fontOptions = familyOption ? fonts : [...fonts, { value: family, label: familyName }];
  const weight = node.fontStyle || 'normal';
  const weightOptions = weights.some(option => option.value === weight) ? weights : [...weights, { value: weight, label: weight }];
  const disabled = node.locked;
  const chevron = <FigmaIcon name="type-chevron"/>;
  const commit = (patch: Partial<CardNode>) => {
    onEditStart();
    onChange(patch);
  };

  return <StyleSection title="字体排印" className="style-typography">
    <InspectorMenu ariaLabel="字体" className="type-menu" value={familyOption?.value ?? family}
      options={fontOptions} chevronIcon={chevron} disabled={disabled} onChange={fontFamily => commit({fontFamily})}/>
    <div className="style-fields">
      <InspectorMenu ariaLabel="字重" className="type-menu" value={weight} options={weightOptions}
        chevronIcon={chevron} disabled={disabled} onChange={fontStyle => commit({fontStyle})}/>
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
  </StyleSection>;
}
