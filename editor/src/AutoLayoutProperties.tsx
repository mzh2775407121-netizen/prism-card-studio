import { useState } from 'react';
import { StyleSection } from './LayerStylePanel';
import type { AutoLayout, LayoutItem, LayoutSizeMode } from './model';

function Measure({ label, value, onChange, disabled, min = 0 }: {
  label: string; value: number; onChange: (value: number) => void; disabled?: boolean; min?: number;
}) {
  const [draft, setDraft] = useState<string>();
  return <label className="field">{label}（mm）<input type="number" step=".1" min={min / 10} disabled={disabled}
    data-undo-draft={draft !== undefined || undefined}
    value={draft ?? Number((value / 10).toFixed(3))}
    onChange={event => setDraft(event.target.value)}
    onBlur={() => {
      const next = Number(draft) * 10;
      if (draft?.trim() && Number.isFinite(next) && next >= min && next <= 10000 && next !== value) onChange(next);
      setDraft(undefined);
    }}
    onKeyDown={event => {
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') { event.stopPropagation(); setDraft(undefined); }
    }}/></label>;
}

export function AutoLayoutProperties({ layout, onChange, onRemove, locked = false }: {
  layout: AutoLayout; onChange: (layout: AutoLayout) => void; onRemove: () => void; locked?: boolean;
}) {
  return <StyleSection title="自动布局" actions={<button type="button" className="text-button" onClick={onRemove}>关闭</button>}>
    <div className="field-grid">
      <label className="field">排列方向<select value={layout.direction} disabled={locked}
        onChange={e => onChange({ ...layout, direction: e.target.value as AutoLayout['direction'] })}>
        <option value="horizontal">横排</option><option value="vertical">竖排</option>
      </select></label>
      <label className="field">交叉轴对齐<select value={layout.align} disabled={locked}
        onChange={e => onChange({ ...layout, align: e.target.value as AutoLayout['align'] })}>
        <option value="start">起点</option><option value="center">居中</option><option value="end">末端</option>
      </select></label>
    </div>
    <div className="field-grid">{(['width','height'] as const).map(axis => {
      const mode = axis === 'width' ? 'widthMode' : 'heightMode';
      const label = axis === 'width' ? '宽度' : '高度';
      return <div key={axis}>
        <label className="field">组{label}规则<select value={layout[mode]} disabled={locked}
          onChange={event => onChange({ ...layout, [mode]: event.target.value as AutoLayout[typeof mode] })}>
          <option value="fixed">固定</option><option value="hug">随内容</option>
        </select></label>
        <Measure label={label} value={layout[axis]} min={1} disabled={locked || layout[mode] !== 'fixed'}
          onChange={value => onChange({ ...layout, [axis]: value })}/>
      </div>;
    })}</div>
    <Measure label="图层间距" value={layout.gap} disabled={locked} onChange={gap => onChange({ ...layout, gap })}/>
    <div className="field-grid">
      {(['top','right','bottom','left'] as const).map(edge => <Measure key={edge}
        label={{top:'上内边距',right:'右内边距',bottom:'下内边距',left:'左内边距'}[edge]}
        value={layout.padding[edge]} disabled={locked}
        onChange={value => onChange({ ...layout, padding: { ...layout.padding, [edge]: value } })}/>)}
    </div>
  </StyleSection>;
}

export function LayoutItemProperties({ item, parent, allowHug, onChange, disabled }: {
  item?: LayoutItem; parent: AutoLayout; allowHug: boolean; onChange: (item: LayoutItem) => void; disabled?: boolean;
}) {
  return <StyleSection title="自动布局尺寸"><div className="field-grid">
    {(['widthMode','heightMode'] as const).map(key => <label className="field" key={key}>
      {key === 'widthMode' ? '子图层宽度' : '子图层高度'}
      <select value={item?.[key] ?? 'fixed'} disabled={disabled}
        onChange={event => onChange({ ...item, [key]: event.target.value as LayoutSizeMode })}>
        <option value="fixed">固定</option>
        {allowHug && <option value="hug">随内容</option>}
        <option value="fill" disabled={parent[key] !== 'fixed'}>填满可用空间</option>
      </select>
    </label>)}
  </div></StyleSection>;
}
