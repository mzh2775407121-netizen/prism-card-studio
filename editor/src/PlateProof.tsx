import { useEffect, useRef, useState } from 'react';
import { PRINT_CHANNELS, plateFor, effectInProduction, type PrintChannel, type Project, type SideName } from './model';
import { PLATE_LABELS } from './production';
import { printGuideBounds, PrintGuideLegend } from './PrintGuides';
import { makeCanvas, renderCard } from './render';
import { orientPrintCanvas } from './printPreflight';
import { projectPrintProfile } from './printProfiles';
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

export function PlateProof({ project, initialSide, applyFactory }: { project: Project; initialSide: SideName; applyFactory: boolean }) {
  const [side, setSide] = useState(project.singleSided ? 'front' : initialSide);
  const [artwork, setArtwork] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const [showOverlap, setShowOverlap] = useState(false);
  const [selected, setSelected] = useState<PrintChannel[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const printProfile = applyFactory ? projectPrintProfile(project) : undefined;
  const available = PRINT_CHANNELS.filter(channel => project[side].effects
    .some(effect => effectInProduction(effect) && plateFor(effect) === channel));
  const activeKey = selected.filter(channel => available.includes(channel)).join(',');
  const bounds = printGuideBounds(project);

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
        ctx.drawImage(orientPrintCanvas(image, side, printProfile), 0, 0);
        const oriented = plates.map(plate => orientPrintCanvas(plate, side, printProfile));
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
  }, [project, side, artwork, activeKey, showOverlap, printProfile]);

  const activeCount = activeKey ? activeKey.split(',').length : 0;
  return <div className="plate-proof">
    <div className="plate-proof-preview">
      <div className="plate-proof-card" style={{width: `min(100%, ${Math.min(490, 540 * bounds.bleed.width / bounds.bleed.height)}px)`}}>
        <canvas ref={canvasRef} aria-label={side === 'front' ? '正面核稿预览' : '背面核稿预览'}
          style={{aspectRatio: `${bounds.bleed.width} / ${bounds.bleed.height}`, visibility: status === 'ready' ? 'visible' : 'hidden'}} />
        {status !== 'ready' && <span className="plate-proof-status" role="status">{status === 'loading' ? '正在生成分版' : '分版预览失败'}</span>}
        {showGuides && status === 'ready' && (['bleed','trim','safe'] as const).map(kind => {
          const guide = bounds[kind], outer = bounds.bleed;
          const pct = (value: number, total: number) => `${100 * value / total}%`;
          return <div key={kind} data-guide={kind} className="plate-proof-line" style={{
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
      <label className="field">核稿卡面<select value={side} onChange={event => setSide(event.target.value as SideName)}>
        <option value="front">正面</option>{!project.singleSided && <option value="back">背面</option>}
      </select></label>
      {side === 'back' && printProfile && printProfile.backOrientation !== 'normal' &&
        <span className="micro-copy">交稿方向 · {printProfile.backOrientation === 'mirror' ? '水平镜像' : '旋转 180°'}</span>}
      <fieldset><legend>显示版面</legend>
        <label><input type="checkbox" checked={artwork} onChange={event => setArtwork(event.target.checked)}/>彩稿</label>
        {available.map(channel => <label key={channel}><input type="checkbox" checked={selected.includes(channel)}
          onChange={event => setSelected(previous => event.target.checked ? [...previous,channel] : previous.filter(item => item !== channel))}/>
          <i style={{background: plateColors[channel]}}/>{PLATE_LABELS[channel]}</label>)}
      </fieldset>
      <fieldset><legend>辅助检查</legend>
        <label><input type="checkbox" checked={showGuides} onChange={event => setShowGuides(event.target.checked)}/>印刷参考线</label>
        <label><input type="checkbox" checked={showOverlap} disabled={activeCount < 2}
          onChange={event => setShowOverlap(event.target.checked)}/>标出重叠区域</label>
      </fieldset>
      {showGuides && <PrintGuideLegend project={project}/>}
    </div>
  </div>;
}
