import { getCardCornerRadiusMm, plateFor, processKind, processLayerEnabled, type PrintChannel, type Project, type SideName } from './model';

export const DIE_SHAPES = { card: '跟随卡牌圆角', rectangle: '直角矩形', ellipse: '椭圆' } as const;
export type DieShape = keyof typeof DIE_SHAPES;
export const MANUAL_OPERATIONS = {
  lamination: '覆膜', coating: '全幅涂布', edge: '边缘处理', inspection: '质检与包装', custom: '其他工序',
} as const;
export type ManualOperation = keyof typeof MANUAL_OPERATIONS;
export type ProductionFace = SideName | 'both';
export const FACE_LABELS: Record<ProductionFace, string> = { front: '正面', back: '背面', both: '整卡' };
export const PLATE_LABELS: Record<PrintChannel, string> = {
  primer: '底涂', white: '白墨', spot: '专色', foil: '箔版', clear: '光油', emboss: '压凸', deboss: '压凹',
};
export const SPOT_NAMES = {
  standard: { primer: 'Primer', white: 'White', spot: 'Spot_Ink', foil: 'Foil_Gold', clear: 'Spot_UV', emboss: 'Emboss', deboss: 'Deboss' },
  alternate: { primer: 'PRIMER', white: 'OPW', spot: 'SPOT_INK', foil: 'FOIL', clear: 'CLEAR', emboss: 'EMBOSS', deboss: 'DEBOSS' },
};
export interface ProductionStep {
  id: string;
  kind: 'artwork' | 'layer' | 'die' | ManualOperation;
  face: ProductionFace;
  layerId?: string;
  name: string;
  method?: string;
  note?: string;
}
export interface ProductionPlan {
  dieShape: DieShape;
  printer?: string;
  stockCode?: string;
  note?: string;
  steps: ProductionStep[];
}
export const EMPTY_PLAN: ProductionPlan = { dieShape: 'card', steps: [] };

const rank: Record<PrintChannel | 'artwork' | 'die', number> = {
  primer: 0, white: 1, artwork: 2, spot: 3, foil: 4, clear: 5, emboss: 6, deboss: 7, die: 8,
};
type LinkedStep = ProductionStep & { channel?: PrintChannel };

export function productionSteps(project: Project, plan = project.production ?? EMPTY_PLAN, faces: SideName[] = ['front', 'back']): LinkedStep[] {
  const available: LinkedStep[] = (['front', 'back'] as const).flatMap(face => {
    const artwork: LinkedStep = { id: `${face}:artwork`, kind: 'artwork', face, name: '彩稿' };
    const layers = project[face].effects.flatMap<LinkedStep>(effect => {
      const channel = plateFor(effect);
      return channel && processLayerEnabled(effect)
        ? [{ id: `${face}:layer:${effect.id}`, kind: 'layer', face, layerId: effect.id, name: effect.name, channel }]
        : [];
    });
    return [artwork, ...layers];
  });
  available.push({ id: 'die', kind: 'die', face: 'both', name: '模切' });
  const getRank = (step: LinkedStep) => step.channel ? rank[step.channel] : step.kind === 'artwork' ? rank.artwork : rank.die;
  available.sort((a, b) => getRank(a) - getRank(b));
  const matches = new Map(available.map(step => [step.id, step]));
  const ordered = plan.steps.flatMap<LinkedStep>(saved => {
    const step = matches.get(saved.id);
    if (step) {
      matches.delete(saved.id);
      return [{ ...step, method: saved.method, note: saved.note }];
    }
    return Object.hasOwn(MANUAL_OPERATIONS, saved.kind) ? [saved] : [];
  });
  for (const step of matches.values()) {
    // New layers use the suggested order until their placement has been set in the work order.
    const before = ordered.findIndex(item => item.kind === 'die' || (!Object.hasOwn(MANUAL_OPERATIONS, item.kind) && getRank(item) > getRank(step)));
    if (step.kind === 'die' || before === -1) ordered.push(step);
    else ordered.splice(before, 0, step);
  }
  return ordered.filter(step => step.face === 'both' || faces.includes(step.face));
}

export function dieBounds(project: Pick<Project, 'widthMm' | 'heightMm' | 'cornerRadiusMm'>, shape: DieShape) {
  return {
    width: project.widthMm, height: project.heightMm,
    radius: shape === 'card' ? getCardCornerRadiusMm(project) : 0,
  };
}

export function reflectionCount(project: Project, faces: SideName[] = ['front', 'back']) {
  return faces.reduce((count, face) => count + project[face].effects.filter(effect =>
    processKind(effect) === 'reflection' && processLayerEnabled(effect)).length, 0);
}
