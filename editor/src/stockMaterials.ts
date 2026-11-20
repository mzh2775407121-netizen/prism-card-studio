import { getStockFinish, STOCK_REFLECTIONS, type CardSide, type Project, type SideName, type StockFinishMatch, type StockReflection, type StockSpec } from './model';

type StockPreset = {
  id: string;
  name: string;
  note: string;
  color: string;
  cores?: NonNullable<StockSpec['core']>[];
  weights?: number[];
  thicknesses?: number[];
  defaults: StockSpec;
  plastic?: true;
  transparent?: true;
};

export const STOCKS: StockPreset[] = [
  { id: 'matte', name: '哑光白卡', note: '白色不透底', color: '#f6f3eb', cores: ['white', 'none'], weights: [300, 350, 400], defaults: { grammageGsm: 300, core: 'white' } },
  { id: 'black', name: '黑芯卡纸', note: '遮光夹层', color: '#f4f2eb', cores: ['black'], weights: [300, 310, 330], defaults: { grammageGsm: 310, core: 'black' } },
  { id: 'blue', name: '蓝芯卡纸', note: '遮光夹层', color: '#f4f5f7', cores: ['blue'], weights: [280, 300], defaults: { grammageGsm: 300, core: 'blue' } },
  { id: 'silver', name: '金属银卡', note: '银色金属表面', color: '#c3c8cf', cores: ['white', 'blue', 'black'], defaults: {} },
  { id: 'holo', name: '镭射卡基', note: '镭射纹样表面', color: '#c9c9d4', cores: ['white', 'blue', 'black'], defaults: {} },
  { id: 'pvc-white', name: '白色 PVC', note: '白色实心', color: '#f8f8f8', plastic: true, thicknesses: [.30, .32, .35], defaults: { thicknessMm: .30 } },
  { id: 'pvc-clear', name: '透明 PVC', note: '全透片材', color: '#e8eff9', plastic: true, transparent: true, thicknesses: [.35], defaults: { thicknessMm: .35 } },
  { id: 'pet-clear', name: '透明 PET', note: '全透片材', color: '#eef1f8', plastic: true, transparent: true, thicknesses: [.19, .25], defaults: { thicknessMm: .19 } },
];

export const STOCK_CORES: Record<NonNullable<StockSpec['core']>, string> = {
  white: '白芯', none: '无芯', blue: '蓝芯', black: '黑芯', gray: '灰芯',
};

export const STOCK_FINISH_STYLES: StockReflection[] = [
  'none', 'mirror', 'matte-silver', 'rainbow', 'dots', 'cracked-ice', 'pillar',
];

export const STOCK_FINISH_METHODS: Record<StockFinishMatch['method'], string> = {
  composite: '预制复合卡基', underprint: '印前复合或转移', overlaminate: '印后覆膜',
};

export const stockPreset = (id: string) => STOCKS.find(stock => stock.id === id);
export const isTransparentStock = (id: string) => stockPreset(id)?.transparent === true;
export const isMetalFinish = (style: StockReflection) => style === 'mirror' || style === 'matte-silver';
export const stockFinishHasPattern = (style: StockReflection) => style !== 'none' && !isMetalFinish(style);

export function effectiveStockSpec(project: Pick<Project, 'material' | 'stockSpec'>): StockSpec | undefined {
  const cores = stockPreset(project.material)?.cores;
  if (cores?.length === 1 && project.stockSpec?.core === undefined) return { ...project.stockSpec, core: cores[0] };
  return project.stockSpec;
}

export function changeStockSpec(material: string, previousMaterial: string, previous: StockSpec): StockSpec {
  const stock = stockPreset(material);
  if (!stock) return {};
  if (material === previousMaterial) return previous;
  const core = previous.core && stock.cores?.includes(previous.core) ? previous.core : stock.defaults.core;
  if (stock.plastic) return { thicknessMm: previous.thicknessMm !== undefined && stock.thicknesses?.includes(previous.thicknessMm)
    ? previous.thicknessMm : stock.defaults.thicknessMm };
  return { grammageGsm: previous.grammageGsm !== undefined && stock.weights?.includes(previous.grammageGsm)
    ? previous.grammageGsm : stock.defaults.grammageGsm, core };
}

export function stockKeys(project: Project) {
  const production = project.production;
  const profile = production?.printProfile;
  const printer = production?.printer?.trim(), stockCode = production?.stockCode?.trim();
  const product = profile?.product?.trim(), version = profile?.version?.trim(), reference = profile?.reference?.trim();
  const spec = effectiveStockSpec(project);
  return {
    stockKey: JSON.stringify([project.material, spec?.grammageGsm, spec?.thicknessMm, spec?.core]),
    profileKey: printer && stockCode && product && version && reference
      ? JSON.stringify([printer, stockCode, product, version, reference, profile?.route]) : '',
  };
}

export function stockFinishConflict(style: StockReflection, match: Pick<StockFinishMatch, 'transparent'>) {
  if (style !== 'none' && match.transparent && isMetalFinish(style)) return '金属银效果需要不透明反光材料。';
  return '';
}

export function confirmedStockFinish(project: Project, side: SideName | CardSide): StockFinishMatch | undefined {
  const { style, match } = getStockFinish(project, side);
  if (!match || style === 'none' || !match.materialCode.trim() || stockFinishConflict(style, match)
    || (stockFinishHasPattern(style) && !match.patternCode?.trim())) return;
  const { stockKey, profileKey } = stockKeys(project);
  if (profileKey && match.profileKey === profileKey && match.stockKey === stockKey) return match;
}

export function needsStockFinishMatch(project: Project, side: SideName) {
  const finish = getStockFinish(project, side);
  return (finish.style !== 'none' || finish.reviewRequired === true) && !confirmedStockFinish(project, side);
}

export function resetStockFinishMatch(project: Project, side: SideName, review = false) {
  const finish = getStockFinish(project, side);
  return { ...project[side], stockFinish: {
    ...finish, match: undefined, reviewRequired: review || finish.reviewRequired || !!finish.match || undefined,
  } };
}

export function stockDelivery(project: Project, sides: SideName[]) {
  return sides.map(side => {
    const { style } = getStockFinish(project, side);
    const match = confirmedStockFinish(project, side);
    const status = needsStockFinishMatch(project, side) ? 'pending' : match ? 'confirmed' : 'not-used';
    return {
      side, style, label: STOCK_REFLECTIONS[style], status,
      ...(match && {
        materialCode: match.materialCode, patternCode: match.patternCode, orientationDeg: match.orientationDeg,
        method: match.method, transparent: match.transparent,
      }),
    };
  });
}
