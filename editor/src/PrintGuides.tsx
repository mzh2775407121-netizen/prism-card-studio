import { Ellipse, Group, Rect } from 'react-konva';
import { getCardCornerRadiusMm, type CardNode, type Project } from './model';
import { PRINT_SAFE_MARGIN_MM } from './printProfiles';
import './print-guides.css';

export { PRINT_SAFE_MARGIN_MM } from './printProfiles';
type CardSize = Pick<Project, 'widthMm' | 'heightMm' | 'bleedMm' | 'cornerRadiusMm' | 'production'>;

const guideStyles = {
  bleed: { label: '出血线', color: '#ffab89', dash: [7, 5] },
  trim: { label: '成品裁切线', color: '#f0f2ef', dash: [5, 4] },
  safe: { label: '正文安全区', color: '#86e9ce', dash: [3, 4] },
};

export function getPrintSafeMarginMm(project: CardSize) {
  return project.production?.printProfile?.safeMm ?? PRINT_SAFE_MARGIN_MM;
}

export function printGuideBounds(project: CardSize, safeMm = getPrintSafeMarginMm(project)) {
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const bleed = project.bleedMm * 10;
  const inset = Math.min(safeMm * 10, Math.min(width, height) / 2 - .01);
  const radius = getCardCornerRadiusMm(project) * 10;
  const followsCard = !project.production || project.production.dieShape === 'card';
  return {
    trim: { x: 0, y: 0, width, height, cornerRadius: radius },
    bleed: { x: -bleed, y: -bleed, width: width + bleed * 2, height: height + bleed * 2, cornerRadius: followsCard && radius ? radius + bleed : 0 },
    safe: { x: inset, y: inset, width: width - inset * 2, height: height - inset * 2,
      cornerRadius: project.production?.dieShape === 'rectangle' ? 0 : Math.max(0, radius - inset) },
  };
}

export function isOutsidePrintSafeArea(node: CardNode, project: CardSize, safeMm?: number) {
  const { safe } = printGuideBounds(project, safeMm);
  const angle = node.rotation * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [[0,0], [node.width,0], [0,node.height], [node.width,node.height]].some(([x,y]) => {
    const px = node.x + x * cos - y * sin;
    const py = node.y + x * sin + y * cos;
    if (project.production?.dieShape === 'ellipse') {
      return Math.hypot((px - safe.x - safe.width / 2) / (safe.width / 2),
        (py - safe.y - safe.height / 2) / (safe.height / 2)) > 1.000001;
    }
    const radius = safe.cornerRadius;
    const centerX = Math.min(safe.x + safe.width - radius, Math.max(safe.x + radius, px));
    const centerY = Math.min(safe.y + safe.height - radius, Math.max(safe.y + radius, py));
    return Math.hypot(px - centerX, py - centerY) > radius + 0.000001;
  });
}

export function PrintCornerPreview({ project }: { project: CardSize }) {
  const bounds = printGuideBounds(project);
  const outer = bounds.bleed;
  const scale = Math.min(132 / outer.width, 94 / outer.height);
  return <div className="corner-preview" role="img" aria-label={`圆角预览，成品半径 ${getCardCornerRadiusMm(project)} mm`}>
    <div className="corner-preview-lines" style={{ width: outer.width * scale, height: outer.height * scale }}>
      {(Object.keys(guideStyles) as (keyof typeof guideStyles)[]).filter(key => key !== 'bleed' || project.bleedMm > 0).map(key => {
        const { x, y, width, height, cornerRadius } = bounds[key];
        return <div key={key} className="corner-preview-line" data-guide={key} style={{
          left: (x - outer.x) * scale, top: (y - outer.y) * scale,
          width: width * scale, height: height * scale, borderRadius: cornerRadius * scale, color: guideStyles[key].color,
        }} />;
      })}
    </div>
  </div>;
}

export function PrintGuideLegend({ project, compact = false }: { project: CardSize; compact?: boolean }) {
  const safeMm = getPrintSafeMarginMm(project);
  const labels = {
    bleed: project.bleedMm ? `四边外扩 ${project.bleedMm} mm` : '当前未设置出血',
    trim: `${project.widthMm} × ${project.heightMm} mm`,
    safe: project.production?.dieShape === 'ellipse' ? `椭圆参考 · 内缩 ${safeMm} mm` : `四边内缩 ${safeMm} mm`,
  };
  return <ul className={`print-guide-legend${compact ? ' compact-guides' : ''}`} aria-label="印刷参考线">
    {(Object.keys(guideStyles) as (keyof typeof guideStyles)[]).map(key => (
      <li key={key} title={compact ? `${guideStyles[key].label} · ${labels[key]}` : undefined}>
        <span className="guide-sample" style={{ color: key === 'bleed' && !project.bleedMm ? '#a9a9a9' : guideStyles[key].color }} aria-hidden="true" />
        <span><strong>{guideStyles[key].label}</strong><small className={compact ? 'sr-only' : undefined}>{labels[key]}</small></span>
      </li>
    ))}
  </ul>;
}

export function PrintGuideLines({ project, scale }: { project: CardSize; scale: number }) {
  const bounds = printGuideBounds(project);
  return <Group listening={false} name="print-guides">
    {(Object.keys(guideStyles) as (keyof typeof guideStyles)[]).filter(key => key !== 'bleed' || project.bleedMm > 0).map(key => {
      const { color, dash } = guideStyles[key];
      const stroke = { stroke: color, strokeWidth: 1 / scale, opacity: .6, dash: dash.map(length => length / scale) };
      if (key !== 'bleed' && project.production?.dieShape === 'ellipse') {
        const { x, y, width, height } = bounds[key];
        return <Ellipse key={key} name={`print-guide-${key}`} x={x + width / 2} y={y + height / 2}
          radiusX={width / 2} radiusY={height / 2} {...stroke}/>;
      }
      const rect = key === 'trim' && project.production?.dieShape === 'rectangle' ? { ...bounds[key], cornerRadius: 0 } : bounds[key];
      return <Rect key={key} name={`print-guide-${key}`} {...rect} {...stroke} />;
    })}
  </Group>;
}
