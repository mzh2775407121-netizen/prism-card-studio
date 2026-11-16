import { Group, Rect } from 'react-konva';
import { getCardCornerRadiusMm, type CardNode, type Project } from './model';
import './print-guides.css';

export const PRINT_SAFE_MARGIN_MM = 3;
type CardSize = Pick<Project, 'widthMm' | 'heightMm' | 'bleedMm' | 'cornerRadiusMm'>;

const guideStyles = {
  bleed: { label: '出血线', color: '#ffab89', dash: [7, 5] },
  trim: { label: '成品裁切线', color: '#f0f2ef', dash: [5, 4] },
  safe: { label: '正文安全区', color: '#86e9ce', dash: [3, 4] },
};

export function printGuideBounds(project: CardSize) {
  const width = project.widthMm * 10;
  const height = project.heightMm * 10;
  const bleed = project.bleedMm * 10;
  const inset = PRINT_SAFE_MARGIN_MM * 10;
  const radius = getCardCornerRadiusMm(project) * 10;
  return {
    trim: { x: 0, y: 0, width, height, cornerRadius: radius },
    bleed: { x: -bleed, y: -bleed, width: width + bleed * 2, height: height + bleed * 2, cornerRadius: radius ? radius + bleed : 0 },
    safe: { x: inset, y: inset, width: width - inset * 2, height: height - inset * 2, cornerRadius: Math.max(0, radius - inset) },
  };
}

export function isOutsidePrintSafeArea(node: CardNode, project: CardSize) {
  const { safe } = printGuideBounds(project);
  const angle = node.rotation * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [[0,0], [node.width,0], [0,node.height], [node.width,node.height]].some(([x,y]) => {
    const px = node.x + x * cos - y * sin;
    const py = node.y + x * sin + y * cos;
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

export function PrintGuideLegend({ project }: { project: CardSize }) {
  const labels = {
    bleed: project.bleedMm ? `四边外扩 ${project.bleedMm} mm` : '当前未设置出血',
    trim: `${project.widthMm} × ${project.heightMm} mm`,
    safe: `四边内缩 ${PRINT_SAFE_MARGIN_MM} mm`,
  };
  return <ul className="print-guide-legend" aria-label="印刷参考线">
    {(Object.keys(guideStyles) as (keyof typeof guideStyles)[]).map(key => (
      <li key={key}>
        <span className="guide-sample" style={{ color: key === 'bleed' && !project.bleedMm ? '#a4ada6' : guideStyles[key].color }} aria-hidden="true" />
        <span><strong>{guideStyles[key].label}</strong><small>{labels[key]}</small></span>
      </li>
    ))}
  </ul>;
}

export function PrintGuideLines({ project, scale }: { project: CardSize; scale: number }) {
  const bounds = printGuideBounds(project);
  return <Group listening={false} name="print-guides">
    {(Object.keys(guideStyles) as (keyof typeof guideStyles)[]).filter(key => key !== 'bleed' || project.bleedMm > 0).map(key => {
      const { color, dash } = guideStyles[key];
      return <Rect key={key} name={`print-guide-${key}`} {...bounds[key]}
        stroke={color} strokeWidth={1 / scale} opacity={0.6} dash={dash.map(length => length / scale)} />;
    })}
  </Group>;
}
