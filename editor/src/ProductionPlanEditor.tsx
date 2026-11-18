import { useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, LocateFixed, Plus, Scissors, Trash2 } from 'lucide-react';
import { getStockReflection, STOCK_REFLECTIONS, uid, type Project } from './model';
import { DIE_SHAPES, EMPTY_PLAN, FACE_LABELS, MANUAL_OPERATIONS, PLATE_LABELS, dieBounds, productionSteps, reflectionCount,
  type DieShape, type ManualOperation, type ProductionFace, type ProductionPlan, type ProductionStep } from './production';
import './production-plan.css';

export function DiePreview({ project, shape }: { project: Project; shape: DieShape }) {
  const { width, height, radius } = dieBounds(project, shape);
  const inset = project.bleedMm;
  const margin = Math.max(width, height) * .095;
  return <svg className="die-preview" viewBox={`${-inset - margin} ${-inset - margin} ${width + (inset + margin) * 2} ${height + (inset + margin) * 2}`}
    role="img" aria-label={`刀模预览，${DIE_SHAPES[shape]}`}>
    {inset > 0 && <rect className="die-preview-bleed" x={-inset} y={-inset} width={width + 2 * inset} height={height + 2 * inset} />}
    {shape === 'ellipse' ? <ellipse className="die-preview-cut" cx={width / 2} cy={height / 2} rx={width / 2} ry={height / 2} />
      : <rect className="die-preview-cut" width={width} height={height} rx={radius} />}
  </svg>;
}

export default function ProductionPlanEditor({ project, material, initialTab, onChange, onArtwork, onStock, onSize, onPreflight, onLocate }:
  { project: Project; material: string; initialTab: 'spec' | 'order'; onChange: (plan: ProductionPlan, key?: string) => void;
    onArtwork: () => void; onStock: () => void; onSize: () => void; onPreflight: () => void; onLocate: (step: ProductionStep) => void }) {
  const [tab, setTab] = useState(initialTab);
  const [selected, setSelected] = useState<string>();
  const [newOperation, setNewOperation] = useState<ManualOperation>('lamination');
  const plan = project.production ?? EMPTY_PLAN;
  const rows = productionSteps(project, plan);
  const row = rows.find(item => item.id === selected);
  const flashes = reflectionCount(project);
  const update = (patch: Partial<ProductionPlan>, key?: string) => onChange({ ...plan, ...patch }, key);
  const saveRows = (change: ProductionStep[], key?: string) => update({ steps: change.map(({ id, kind, face, name, layerId, method, note }) =>
    ({ id, kind, face, name, layerId, method, note })) }, key);
  const edit = (patch: Partial<ProductionStep>, field: string) => {
    if (row) saveRows(rows.map(step => step.id === row.id ? { ...step, ...patch } : step), `production:${row.id}:${field}`);
  };
  const move = (index: number, direction: -1 | 1) => {
    const next = [...rows];
    const target = index + direction;
    [next[index], next[target]] = [next[target], next[index]];
    saveRows(next);
  };
  const add = () => {
    const step: ProductionStep = { id: uid(), name: MANUAL_OPERATIONS[newOperation], kind: newOperation, face: 'both' };
    const after = selected ? rows.findIndex(item => item.id === selected) + 1 : rows.findIndex(item => item.kind === 'die');
    const next = [...rows];
    next.splice(after < 0 ? rows.length : after, 0, step);
    saveRows(next);
    setSelected(step.id);
  };
  const manual = row ? Object.hasOwn(MANUAL_OPERATIONS, row.kind) : false;
  return <>
    <nav className="production-path" aria-label="制作步骤">
      <button type="button" aria-current={tab === 'spec' ? 'step' : undefined} onClick={() => setTab('spec')}><span>1</span>规格与基材</button>
      <button type="button" onClick={onArtwork}><span>2</span>图文与蒙版</button>
      <button type="button" aria-current={tab === 'order' ? 'step' : undefined} onClick={() => setTab('order')}><span>3</span>工艺顺序</button>
      <button type="button" onClick={onPreflight}><span>4</span>印前检查</button>
    </nav>
    <div className="production-body">
      {tab === 'spec' ? <>
        <section className="production-section">
          <h3>卡牌规格</h3>
          <div className="production-spec"><div><b>{project.widthMm} × {project.heightMm} mm</b><small>出血 {project.bleedMm} mm · 圆角 {dieBounds(project, 'card').radius} mm</small></div>
            <button className="button" onClick={onSize}>调整尺寸</button></div>
          <div className="production-spec"><div><b>{material}</b><small>{STOCK_REFLECTIONS[getStockReflection(project)]}</small></div>
            <button className="button" onClick={onStock}>更换基材</button></div>
          <div className="field-grid"><label className="field">印厂<input value={plan.printer ?? ''} maxLength={120} placeholder="选填" onChange={e => update({ printer: e.target.value }, 'production:printer')}/></label>
            <label className="field">实际材料或供应商料号<input value={plan.stockCode ?? ''} maxLength={120} placeholder="选填" onChange={e => update({ stockCode: e.target.value }, 'production:stock')}/></label></div>
        </section>
        <section className="production-section">
          <h3><Scissors size={15}/>独立刀模</h3>
          <div className="die-layout"><DiePreview project={project} shape={plan.dieShape}/>
            <div><label className="field">裁切轮廓<select value={plan.dieShape} onChange={e => update({ dieShape: e.target.value as DieShape })}>
              {Object.entries(DIE_SHAPES).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
            </select></label>
            <p className="micro-copy">与彩稿同尺寸、同原点。导出独立矢量 PDF 和 SVG，卡面上可用参考线查看轮廓。</p></div></div>
        </section>
      </> : <>
        <section className="production-section">
          <h3>工艺顺序 <small>{rows.length} 道工序</small></h3>
          <p className="micro-copy">彩稿和可见工艺层自动进入工艺单。首次打开按建议顺序排列，可按印厂方案调整。</p>
          <ol className="work-order-list" aria-label="工艺执行顺序">
            {rows.map((step, index) => <li key={step.id} className={selected === step.id ? 'selected' : ''}>
              <button className="work-order-step" type="button" aria-pressed={selected === step.id} onClick={() => setSelected(step.id)}>
                <span className="work-order-position">{String(index + 1).padStart(2, '0')}</span>
                <span className="work-order-name">{step.name || '未命名工艺层'}<small>{FACE_LABELS[step.face]}{step.channel ? ' · ' + PLATE_LABELS[step.channel] + '分版' : step.kind === 'artwork' ? ' · 彩稿 PDF' : step.kind === 'die' ? ' · 刀模 PDF / SVG' : ' · 工单说明'}</small></span>
              </button>
              <div className="work-order-actions">
                <button type="button" className="button icon-button" aria-label={`上移 ${FACE_LABELS[step.face]}${step.name}`} title="上移" disabled={!index} onClick={() => move(index, -1)}><ArrowUp size={14}/></button>
                <button type="button" className="button icon-button" aria-label={`下移 ${FACE_LABELS[step.face]}${step.name}`} title="下移" disabled={index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14}/></button>
              </div>
            </li>)}
          </ol>
          <div className="work-order-add"><select aria-label="补充工序类型" value={newOperation} onChange={e => setNewOperation(e.target.value as ManualOperation)}>
            {Object.entries(MANUAL_OPERATIONS).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
          </select><button className="button" disabled={rows.length >= 250} onClick={add}><Plus size={15}/>添加工序</button></div>
          {row && <div className="work-order-fields">
            <div className="work-order-detail-title"><b>{row.name || '未命名工艺层'} · {FACE_LABELS[row.face]}</b>
              {row.kind === 'layer' && <button className="button" onClick={() => onLocate(row)}><LocateFixed size={14}/>定位图层</button>}
              {manual && <button className="button icon-button" title="移除工序" aria-label="移除工序" onClick={() => { saveRows(rows.filter(step => step.id !== row.id)); setSelected(undefined); }}><Trash2 size={15}/></button>}
            </div>
            {manual && <div className="field-grid"><label className="field">工序名称<input value={row.name} maxLength={100} onChange={e => edit({ name: e.target.value }, 'name')}/></label>
              <label className="field">加工面<select value={row.face} onChange={e => edit({ face: e.target.value as ProductionFace }, 'face')}>
                {Object.entries(FACE_LABELS).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label></div>}
            <label className="field">做法或材料<input value={row.method ?? ''} maxLength={120} placeholder={row.kind === 'artwork' ? '如背面反印，镜像由印厂处理' : '如指定箔材编号、专色色号或膜材'} onChange={e => edit({ method: e.target.value }, 'method')}/></label>
            <label className="field">本工序备注<textarea rows={2} maxLength={600} value={row.note ?? ''} placeholder="补充套准、覆盖率、加工要求" onChange={e => edit({ note: e.target.value }, 'note')}/></label>
          </div>}
        </section>
        <section className="production-section">
          <label className="field">整卡交付备注<textarea rows={2} maxLength={1200} value={plan.note ?? ''} onChange={e => update({ note: e.target.value }, 'production:note')}/></label>
          {!!flashes && <p className="micro-copy">{flashes} 个局部闪光层可在导出时选为彩稿图案或仅预览。</p>}
        </section>
      </>}
    </div>
    <div className="modal-footer production-footer">
      {tab === 'order' && <button className="button" onClick={onArtwork}><ArrowLeft size={15}/>返回画布</button>}
      <button className="button primary" onClick={tab === 'spec' ? onArtwork : onPreflight}>{tab === 'spec' ? '去画布编辑' : '去印前检查'}<ArrowRight size={15}/></button>
    </div>
  </>;
}
