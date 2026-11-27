import { useEffect, useRef, useState } from 'react';
import { PRINT_CHANNELS, plateFor, effectInProduction, type PrintChannel, type Project, type SideName } from './model';
import { FACE_LABELS, PLATE_LABELS } from './production';
import { physicalCardFace } from './cardMembers';
import { guideColor, printGuideBounds, PrintGuideLegend, PRINT_SAFE_MARGIN_MM } from './PrintGuides';
import { makeCanvas, renderCard } from './render';
import { orientPrintCanvas, printPreflight, type PreflightIssue, type PreflightTarget } from './printPreflight';
import { printSubmissionSides, projectPrintProfile, type TechnicalPrintProfile } from './printProfiles';
import './plate-proof.css';

const plateColors: Record<PrintChannel, string> = {
  primer: '#a887b8', white: '#65b4ed', spot: '#cc7b98', foil: '#e5ae4a',
  clear: '#77bcb2', emboss: '#9a8ae0', deboss: '#da8565',
};

function maskLayer(plate: HTMLCanvasElement, color: string) {
  const mask = makeCanvas(plate.width, plate.height);
  const ctx = mask.getContext('2d')!;
  ctx.drawImage(plate, 0, 0);
  const image = ctx.getImageData(0, 0, mask.width, mask.height);
  for (let i = 0; i < image.data.length; i += 4) image.data[i+3] = 255 - image.data[i];
  ctx.putImageData(image, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, mask.width, mask.height);
  return mask;
}

export type ProofSettings = {
  side: SideName; artwork: boolean; showGuides: boolean; showOverlap: boolean; selected: PrintChannel[];
  applyFactory: boolean; technical: TechnicalPrintProfile; dpi: number; vector: boolean;
};
export function PlateProof({ project, settings, onChange, onLocate }: {
  project: Project; settings: ProofSettings; onChange: (settings: ProofSettings) => void; onLocate: (target: PreflightTarget) => void;
}) {
  const { artwork, showGuides, showOverlap, selected, applyFactory, technical, dpi, vector } = settings;
  const submissionSides = printSubmissionSides(project, applyFactory);
  const side = submissionSides.includes(settings.side) ? settings.side : submissionSides[0];
  const physicalSide = physicalCardFace(project, side);
  const update = (patch: Partial<ProofSettings>) => onChange({ ...settings, ...patch });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [issues, setIssues] = useState<PreflightIssue[]>();
  const [checkError, setCheckError] = useState(false), [attempt, setAttempt] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const printProfile = applyFactory ? projectPrintProfile(project) : undefined;
  const available = PRINT_CHANNELS.filter(channel => project[side].effects
    .some(effect => effectInProduction(effect) && plateFor(effect) === channel));
  const activeKey = selected.filter(channel => available.includes(channel)).join(',');
  const safeMm = printProfile?.safeMm ?? PRINT_SAFE_MARGIN_MM;
  const bounds = printGuideBounds(project,safeMm);
  useEffect(() => {
    const controller = new AbortController();
    setIssues(undefined); setCheckError(false);
    // Factory face requirements are for the complete submission, also when inspecting just one face.
    printPreflight(project, submissionSides, technical, dpi, controller.signal, applyFactory, vector)
      .then(items => { if (!controller.signal.aborted) setIssues(items); })
      .catch(() => { if (!controller.signal.aborted) setCheckError(true); });
    return () => controller.abort();
  }, [project, submissionSides, technical, dpi, applyFactory, vector, attempt]);

  useEffect(() => {
    let live = true;
    setStatus('loading');
    const scale = 700 / (10 * (Math.max(project.widthMm, project.heightMm) + project.bleedMm * 2));
    const channels = activeKey ? activeKey.split(',') as PrintChannel[] : [];
    const options = { scale, bleed: true, effects: false, material: false, productionOnly: true };
    const base = artwork ? renderCard(project, side, options) : Promise.resolve(makeCanvas(
      10 * (project.widthMm + project.bleedMm * 2) * scale,
      10 * (project.heightMm + project.bleedMm * 2) * scale,
    ));
    Promise.all([base, ...channels.map(plate => renderCard(project, side, { ...options, plate }))])
      .then(([image, ...plates]) => {
        const canvas = canvasRef.current;
        if (!live || !canvas) return;
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(orientPrintCanvas(image, physicalSide, printProfile), 0, 0);
        const oriented = plates.map(plate => orientPrintCanvas(plate, physicalSide, printProfile));
        if (!artwork && oriented.length === 1) ctx.drawImage(oriented[0], 0, 0);
        else {
          const layers = oriented.map((plate, index) => maskLayer(plate, plateColors[channels[index]]));
          ctx.globalAlpha = artwork ? .58 : .85;
          for (const layer of layers) ctx.drawImage(layer, 0, 0);
          ctx.globalAlpha = 1;
          if (showOverlap && layers.length > 1) {
            const common = makeCanvas(canvas.width, canvas.height);
            const overlap = common.getContext('2d')!;
            const previous = makeCanvas(canvas.width, canvas.height);
            const coverage = previous.getContext('2d')!;
            for (const layer of layers) {
              const pair = makeCanvas(canvas.width, canvas.height);
              const pairCtx = pair.getContext('2d')!;
              pairCtx.drawImage(previous, 0, 0);
              pairCtx.globalCompositeOperation = 'destination-in';
              pairCtx.drawImage(layer, 0, 0);
              overlap.drawImage(pair, 0, 0);
              coverage.drawImage(layer, 0, 0);
            }
            overlap.globalCompositeOperation = 'source-in';
            overlap.fillStyle = '#e85454';
            overlap.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(common, 0, 0);
          }
        }
        setStatus('ready');
      }).catch(() => { if (live) setStatus('error'); });
    return () => { live = false; };
  }, [project, side, physicalSide, artwork, activeKey, showOverlap, printProfile]);

  const activeCount = activeKey ? activeKey.split(',').length : 0;
  return <div className="plate-proof">
    <div className="plate-proof-preview">
      <div className="plate-proof-card" style={{width: `min(100%, ${Math.min(490, 540 * bounds.bleed.width / bounds.bleed.height)}px)`}}>
        <canvas ref={canvasRef} aria-label={FACE_LABELS[physicalSide] + '核稿预览'}
          style={{aspectRatio: `${bounds.bleed.width} / ${bounds.bleed.height}`, visibility: status === 'ready' ? 'visible' : 'hidden'}} />
        {status !== 'ready' && <span className="plate-proof-status" role="status">{status === 'loading' ? '正在生成分版' : '分版预览失败'}</span>}
        {showGuides && status === 'ready' && (['bleed','trim','safe'] as const).map(kind => {
          if (kind === 'bleed' && project.bleedMm === 0) return null;
          const guide = bounds[kind], outer = bounds.bleed;
          const pct = (value: number, total: number) => `${100 * value / total}%`;
          return <div key={kind} data-guide={kind} className="plate-proof-line" style={{color:guideColor(kind,physicalSide),
            left:pct(guide.x-outer.x,outer.width), top:pct(guide.y-outer.y,outer.height),
            width:pct(guide.width,outer.width), height:pct(guide.height,outer.height),
            borderRadius: kind !== 'bleed' && project.production?.dieShape === 'ellipse' ? '50%' :
              kind === 'trim' && project.production?.dieShape === 'rectangle' ? '0' :
              `${pct(guide.cornerRadius,guide.width)} / ${pct(guide.cornerRadius,guide.height)}`,
          }}/>;
        })}
      </div>
    </div>
    <div className="plate-proof-controls">
      <strong>{project.cardName ?? project.name}</strong>
      <span>{printProfile?.product || (technical === 'standard' ? '技术配置 A' : '技术配置 B')} · {dpi} PPI</span>
      <label className="field">核稿卡面<select value={side} onChange={event => update({side:event.target.value as SideName})}>
        {submissionSides.map(slot => <option key={slot} value={slot}>{FACE_LABELS[physicalCardFace(project, slot)]}</option>)}
      </select></label>
      {physicalSide === 'back' && printProfile && printProfile.backOrientation !== 'normal' &&
        <span className="micro-copy">交稿方向 · {printProfile.backOrientation === 'mirror' ? '水平镜像' : '旋转 180°'}</span>}
      <fieldset><legend>显示版面</legend>
        <label><input type="checkbox" checked={artwork} onChange={event => update({artwork:event.target.checked})}/>彩稿</label>
        {available.map(channel => <label key={channel}><input type="checkbox" checked={selected.includes(channel)}
          onChange={event => update({selected:event.target.checked ? [...selected,channel] : selected.filter(item => item !== channel)})}/>
          <i style={{background: plateColors[channel]}}/>{PLATE_LABELS[channel]}</label>)}
      </fieldset>
      <fieldset><legend>辅助检查</legend>
        <label><input type="checkbox" checked={showGuides} onChange={event => update({showGuides:event.target.checked})}/>印刷参考线</label>
        <label><input type="checkbox" checked={showOverlap} disabled={activeCount < 2}
          onChange={event => update({showOverlap:event.target.checked})}/>标出重叠区域</label>
      </fieldset>
      {showGuides && <PrintGuideLegend project={project} safeMm={safeMm} face={physicalSide}/>}
      <section className="proof-issues" aria-label="本面印前检查">
        <strong>本面印前检查</strong>
        {checkError ? <button type="button" onClick={()=>setAttempt(value=>value+1)}>检查失败，重试</button> :
          !issues ? <span role="status">正在预检</span> :
          issues.some(issue=>issue.target.side===side) ? issues.filter(issue=>issue.target.side===side).map((issue,index)=>
            <button type="button" key={index} onClick={()=>onLocate(issue.target)}>{issue.blocking?'需修正':'提醒'} · {issue.text}</button>) :
          <span>本面检查通过</span>}
      </section>
    </div>
  </div>;
}
