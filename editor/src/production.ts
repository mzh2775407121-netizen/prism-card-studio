import { effectInProduction, getCardCornerRadiusMm, plateFor, processKind, type PrintChannel, type Project, type SideName } from './model';
import type { PrintJobProfile } from './printProfiles';

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
const FACTORY_STAGE_LABELS = { ...PLATE_LABELS, ...MANUAL_OPERATIONS, artwork: '彩稿', die: '模切' };
export type FactoryProcessStage = keyof typeof FACTORY_STAGE_LABELS;
export const isFactoryProcessStage = (value: unknown): value is FactoryProcessStage =>
  typeof value === 'string' && Object.hasOwn(FACTORY_STAGE_LABELS, value);
export interface FactoryProcessRule {
  stage: FactoryProcessStage;
  after: FactoryProcessStage;
  required?: boolean;
}
export interface ProductionStep {
  id: string;
  kind: 'artwork' | 'layer' | 'die' | ManualOperation;
  face: ProductionFace;
  layerId?: string;
  name: string;
  method?: string;
  note?: string;
  materialCode?: string;
  requiresStepId?: string;
}
export interface ProductionPlan {
  dieShape: DieShape;
  printer?: string;
  stockCode?: string;
  note?: string;
  steps: ProductionStep[];
  /** Recover interleaved operations when the original two faces are paired again. */
  splitOrder?: { pair: string; ids: string[]; crossDependencies: Record<string, string> };
  printProfile?: PrintJobProfile;
}
export const EMPTY_PLAN: ProductionPlan = { dieShape: 'card', steps: [] };

const rank: Record<PrintChannel | 'artwork' | 'die', number> = {
  primer: 0, white: 1, artwork: 2, spot: 3, foil: 4, clear: 5, emboss: 6, deboss: 7, die: 8,
};
type LinkedStep = ProductionStep & { channel?: PrintChannel };

export function productionSteps(project: Project, plan = project.production ?? EMPTY_PLAN,
  faces: SideName[] = project.singleSided ? ['front'] : ['front', 'back']): LinkedStep[] {
  const available: LinkedStep[] = (['front', 'back'] as const).flatMap(face => {
    const artwork: LinkedStep = { id: `${face}:artwork`, kind: 'artwork', face, name: '彩稿' };
    const layers = project[face].effects.flatMap<LinkedStep>(effect => {
      const channel = plateFor(effect);
      return channel && effectInProduction(effect)
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
      return [{ ...step, method: saved.method, note: saved.note, materialCode: saved.materialCode, requiresStepId: saved.requiresStepId }];
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

export function factoryProductionOrder(project: Project, faces: SideName[], profile?: PrintJobProfile) {
  const steps = productionSteps(project, project.production, faces);
  const issues: { step: LinkedStep; message: string }[] = [];
  if (profile?.route !== 'specialty' || !profile.processRules?.length) return { steps, issues };

  const ids = new Set(steps.map(step => step.id));
  const prerequisites = new Map(steps.map(step =>
    [step.id, new Set(step.requiresStepId && ids.has(step.requiresStepId) ? [step.requiresStepId] : [])]));
  const stageOf = (step: LinkedStep) => step.channel ?? step.kind;
  for (const rule of profile.processRules) {
    for (const step of steps.filter(step => stageOf(step) === rule.stage)) {
      const previous = steps.filter(candidate => stageOf(candidate) === rule.after &&
        (step.face === 'both' || candidate.face === 'both' || step.face === candidate.face));
      if (!previous.length && rule.required) {
        issues.push({ step, message: `「${step.name}」须先完成${FACTORY_STAGE_LABELS[rule.after]}，当前交稿缺少该工序` });
      }
      for (const candidate of previous) prerequisites.get(step.id)!.add(candidate.id);
    }
  }
  const order: LinkedStep[] = [];
  const placed = new Set<string>();
  const pending = [...steps];
  // Preserve the proposed order for steps whose precedence is not constrained by this profile.
  while (pending.length) {
    const index = pending.findIndex(step => [...prerequisites.get(step.id)!].every(id => placed.has(id)));
    if (index < 0) {
      issues.push({ step: pending[0], message: `「${pending[0].name}」的厂规顺序与前置工序冲突` });
      return { steps, issues };
    }
    const [step] = pending.splice(index, 1);
    order.push(step);
    placed.add(step.id);
  }
  return { steps: order, issues };
}

export function dieBounds(project: Pick<Project, 'widthMm' | 'heightMm' | 'cornerRadiusMm'>, shape: DieShape) {
  return {
    width: project.widthMm, height: project.heightMm,
    radius: shape === 'card' ? getCardCornerRadiusMm(project) : 0,
  };
}

export function reflectionCount(project: Project, faces: SideName[] = project.singleSided ? ['front'] : ['front', 'back']) {
  return faces.reduce((count, face) => count + project[face].effects.filter(effect =>
    processKind(effect) === 'reflection' && effectInProduction(effect)).length, 0);
}
