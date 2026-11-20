import { useState, type ChangeEvent } from 'react';
import type { Project } from './model';
import { FACTORY_ROUTES, MPC_TRADITIONAL_POKER, createPrintJobProfile, mpcPrintJobProfile, type FactoryRoute, type PrintJobProfile } from './printProfiles';

interface Props {
  project: Project;
  profile?: PrintJobProfile;
  onChange: (profile: PrintJobProfile | undefined, key?: string) => void;
  onLoadTemplate: (profile: PrintJobProfile, printer: string) => void;
}

function NumericProfileField({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return <label className="field">{label}
    <input type="number" min={min} max={max} step={step} value={draft ?? value}
      onChange={event => setDraft(event.target.value)}
      onBlur={event => {
        const number = event.currentTarget.valueAsNumber;
        setDraft(null);
        if (Number.isFinite(number)) onChange(Math.min(max, Math.max(min, step === 1 ? Math.round(number) : number)));
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      }}
    />
  </label>;
}

export default function PrintProfileEditor({ project, profile, onChange, onLoadTemplate }: Props) {
  const [pending, setPending] = useState<FactoryRoute | 'technical' | 'mpc'>();
  const selected = profile?.route ?? 'technical';
  const chooseRoute = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.currentTarget.value as typeof pending;
    setPending(next === selected ? undefined : next);
  };
  const update = <K extends keyof PrintJobProfile>(key: K, value: PrintJobProfile[K]) => {
    if (profile) onChange({ ...profile, [key]: value }, `print-profile:${key}`);
  };
  const numberField = (key: 'widthMm' | 'heightMm' | 'bleedMm' | 'safeMm' | 'dpi' | 'minImagePpi' |
      'minPlateWidthMm' | 'plateTrimMarginMm' | 'whiteFoilGapMm', label: string, min: number, max: number, step = .1) =>
    <NumericProfileField label={label} min={min} max={max} step={step} value={profile![key]} onChange={value => update(key, value)}/>;
  return <section className="production-section print-profile-settings">
    <h3>印厂配置</h3>
    <label className="field">交稿方式<select value={pending ?? selected} onChange={chooseRoute}>
      <option value="technical">技术打样 · 未选厂规</option>
      {Object.entries(FACTORY_ROUTES).map(([route, title]) => <option key={route} value={route}>{title}</option>)}
      <option value="mpc" disabled={project.singleSided}>套用模板 · MPC 传统扑克尺寸</option>
    </select></label>
    {pending && <div className="print-profile-switch" role="status">
      {pending === 'mpc' ? <div className="print-profile-compare">
        <p><strong>当前画板</strong> {project.widthMm} × {project.heightMm} mm · 出血 {project.bleedMm} mm</p>
        <p><strong>MPC 公开模板</strong> 63.5 × 88.9 mm · 出血 3.048 mm · 双面 PNG · 822 × 1122 px</p>
        <p>确认后填写订单实际料号，并按模板调整画板。</p>
        <div className="print-profile-sources">
          <a href={MPC_TRADITIONAL_POKER.productUrl} target="_blank" rel="noreferrer">产品规格</a>
          <a href={MPC_TRADITIONAL_POKER.reference} target="_blank" rel="noreferrer">像素与出血要求</a>
        </div>
      </div> : <p>{pending === 'raster'
        ? '将按厂规导出 RGB 正背图片。涉及独立工艺版时，可切回打样路线。'
        : pending === 'specialty' ? '将提供 CMYK 彩稿、专色合版及独立技术分版。'
          : '将使用技术配置 A 或 B 输出打样包。'}</p>}
      <div className="print-profile-switch-actions"><button className="button" type="button" onClick={() => setPending(undefined)}>取消</button>
        <button className="button primary" type="button" onClick={() => {
          if (pending === 'mpc') onLoadTemplate(mpcPrintJobProfile(project), MPC_TRADITIONAL_POKER.printer);
          else onChange(pending === 'technical' ? undefined : profile ? { ...profile, route: pending } : createPrintJobProfile(project, pending));
          setPending(undefined);
        }}>{pending === 'mpc' ? '套用厂规' : '切换交稿方式'}</button></div>
    </div>}
    {profile && <>
      <div className="field-grid">
        <label className="field">产品或模板名称<input value={profile.product} maxLength={120}
          onChange={event => update('product', event.target.value)} placeholder="按厂方规格填写"/></label>
        <label className="field">厂规版本<input value={profile.version} maxLength={60}
          onChange={event => update('version', event.target.value)} placeholder="例如厂方修订号"/></label>
      </div>
      <label className="field">厂规依据<input value={profile.reference} maxLength={600}
        onChange={event => update('reference', event.target.value)} placeholder="模板地址、订单或书面规格"/></label>
      <details className="print-profile-details" open>
        <summary>成品与文件规格</summary>
        <div className="field-grid">
          {numberField('widthMm', '成品宽（mm）', 10, 500)}
          {numberField('heightMm', '成品高（mm）', 10, 500)}
          {numberField('bleedMm', '四边出血（mm）', 0, 20, .001)}
          {numberField('safeMm', '正文安全区内缩（mm）', 0, 20, .001)}
          {numberField('dpi', '输出分辨率（PPI）', 150, 1200, 1)}
          {numberField('minImagePpi', '原图最低有效 PPI', 0, 1200, 1)}
          <label className="field">交稿卡面<select value={profile.faces} onChange={event => update('faces', event.target.value as PrintJobProfile['faces'])}>
            <option value="both" disabled={project.singleSided}>正反两面</option><option value="front">仅正面</option><option value="either" disabled={project.singleSided}>任一面或两面</option>
          </select></label>
          {profile.route === 'raster' && <label className="field">主稿格式<select value={profile.rasterFormat}
            onChange={event => update('rasterFormat', event.target.value as PrintJobProfile['rasterFormat'])}>
            <option value="png">sRGB PNG</option><option value="jpeg">sRGB JPEG</option>
          </select></label>}
          <label className="field">背面方向<select value={profile.backOrientation} onChange={event => update('backOrientation', event.target.value as PrintJobProfile['backOrientation'])}>
            <option value="normal">原方向</option><option value="rotate180">旋转 180°</option><option value="mirror">水平镜像</option>
          </select></label>
          <label className="field">颜色要求<select value={profile.colorRequirement} onChange={event => update('colorRequirement', event.target.value as PrintJobProfile['colorRequirement'])}>
            <option value="standard">{profile.route === 'raster' ? 'sRGB' : '通用 CMYK 打样'}</option><option value="icc">指定 ICC 或输出条件</option>
          </select></label>
        </div>
        {profile.colorRequirement === 'icc' && <label className="field">ICC／输出条件<input maxLength={120} value={profile.iccName} onChange={event => update('iccName', event.target.value)}/></label>}
        <label className="check-field"><input type="checkbox" checked={profile.requireBleedArtwork}
          onChange={event => update('requireBleedArtwork', event.target.checked)}/>图文须覆盖四边出血</label>
        <p className="micro-copy">最低有效 PPI 填 0 时，仅提示低分辨率图片。</p>
      </details>
      {profile.route === 'specialty' && <details className="print-profile-details">
        <summary>工艺版要求</summary>
        <div className="field-grid">
          <label className="field">白墨专色名<input maxLength={64} value={profile.spotNames.white ?? ''}
            onChange={event => update('spotNames', { ...profile.spotNames, white: event.target.value })} placeholder="沿用技术配置"/></label>
          <label className="field">箔版专色名<input maxLength={64} value={profile.spotNames.foil ?? ''}
            onChange={event => update('spotNames', { ...profile.spotNames, foil: event.target.value })} placeholder="沿用技术配置"/></label>
          {numberField('minPlateWidthMm', '工艺最小线宽（mm）', 0, 10, .01)}
          {numberField('plateTrimMarginMm', '工艺版离裁切边（mm）', 0, 20, .01)}
          {numberField('whiteFoilGapMm', '白墨与箔版间距（mm）', 0, 10, .01)}
        </div>
        <label className="check-field"><input type="checkbox" checked={!profile.foilWhiteOverlap}
          onChange={event => update('foilWhiteOverlap', !event.target.checked)}/>白墨与箔版不可重叠</label>
        <label className="check-field"><input type="checkbox" checked={profile.requireVectorPlates}
          onChange={event => update('requireVectorPlates', event.target.checked)}/>厂方要求矢量工艺版</label>
      </details>}
    </>}
  </section>;
}
