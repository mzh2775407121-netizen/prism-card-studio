import type { PrintChannel, Project, SideName } from './model';
import { isFactoryProcessStage, SPOT_NAMES, type FactoryProcessRule } from './production';

export type TechnicalPrintProfile = keyof typeof SPOT_NAMES;
export type FactoryRoute = 'raster' | 'specialty';
export interface PrintJobProfile {
  route: FactoryRoute;
  product: string;
  version: string;
  reference: string;
  widthMm: number;
  heightMm: number;
  bleedMm: number;
  safeMm: number;
  dpi: number;
  minImagePpi: number;
  faces: 'both' | 'front' | 'either';
  rasterFormat: 'png' | 'jpeg';
  backOrientation: 'normal' | 'rotate180' | 'mirror';
  requireBleedArtwork: boolean;
  requireVectorPlates: boolean;
  colorRequirement: 'standard' | 'icc';
  iccName: string;
  minPlateWidthMm: number;
  minKnockoutMm?: number;
  plateTrimMarginMm: number;
  whiteFoilGapMm: number;
  foilWhiteOverlap: boolean;
  spotNames: Partial<Record<'white' | 'foil', string>>;
  /** Precedence applies to matching operations on a face; whole-card operations span both faces. */
  processRules?: FactoryProcessRule[];
}

export const FACTORY_ROUTES = {
  raster: '普通彩印 · 图片上传',
  specialty: '白墨／箔版 · 交稿打样',
} as const;
export const PRINT_SAFE_MARGIN_MM = 3;

export const MPC_TRADITIONAL_POKER = {
  printer: 'MakePlayingCards',
  product: 'Traditional Poker · 双面全彩',
  productUrl: 'https://www.makeplayingcards.com/promotional/custom-traditional-size-poker-cards.html',
  reference: 'https://www.makeplayingcards.com/pops/faq-photo.html',
  version: '公开规格核对 2026-11-19',
  widthMm: 63.5, heightMm: 88.9, bleedMm: 3.048, safeMm: 3.048, dpi: 300,
} as const;

export function createPrintJobProfile(project: Project, route: FactoryRoute): PrintJobProfile {
  const faces = !project.singleSided ? 'both' : project.looseFace === 'back' ? 'either' : 'front';
  return {
    route, product: '', version: '', reference: '',
    widthMm: project.widthMm, heightMm: project.heightMm, bleedMm: project.bleedMm, safeMm: PRINT_SAFE_MARGIN_MM,
    dpi: 300, minImagePpi: 0, faces, rasterFormat: 'png', backOrientation: 'normal',
    requireBleedArtwork: false, requireVectorPlates: false, colorRequirement: 'standard', iccName: '',
    minPlateWidthMm: 0, minKnockoutMm: 0, plateTrimMarginMm: 0, whiteFoilGapMm: 0, foilWhiteOverlap: true, spotNames: {},
  };
}

export function mpcPrintJobProfile(project: Project): PrintJobProfile {
  const { product, reference, version, widthMm, heightMm, bleedMm, safeMm, dpi } = MPC_TRADITIONAL_POKER;
  return { ...createPrintJobProfile(project, 'raster'), faces: 'both', product, reference, version,
    widthMm, heightMm, bleedMm, safeMm, dpi, requireBleedArtwork: true, minImagePpi: 300 };
}

export function projectPrintProfile(project: Project) {
  return project.production?.printProfile;
}

const FRONT_SLOT: SideName[] = ['front'];
const BOTH_SLOTS: SideName[] = ['front', 'back'];

export function printSubmissionSides(project: Project, applyFactory: boolean): SideName[] {
  return project.singleSided || (applyFactory && projectPrintProfile(project)?.faces === 'front')
    ? FRONT_SLOT
    : BOTH_SLOTS;
}

export const isRasterProfile = (project: Project) => projectPrintProfile(project)?.route === 'raster';

export function printSpotNames(project: Project, technical: TechnicalPrintProfile, applyFactory = true): Record<PrintChannel, string> {
  const profile = applyFactory ? projectPrintProfile(project) : undefined;
  const names: Record<PrintChannel, string> = { ...SPOT_NAMES[technical] };
  if (profile?.route === 'specialty') {
    if (profile.spotNames.white?.trim()) names.white = profile.spotNames.white.trim();
    if (profile.spotNames.foil?.trim()) names.foil = profile.spotNames.foil.trim();
  }
  return names;
}

export function profileOutputScope(project: Project) {
  const profile = projectPrintProfile(project);
  return profile?.route === 'raster'
    ? { title: 'RGB 彩印打样', description: '按所录入的尺寸、出血及方向导出图片。' }
    : { title: '技术打样', description: profile
      ? '按所录入的厂规检查并生成通用 CMYK 和指定专色版。色彩与工艺仍需印厂确认。'
      : '通用 CMYK 彩稿与工艺分版。正式生产需由印厂确认色彩配置、交稿标准和样品。' };
}

const boundedNumber = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const boundedText = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
export const validSpotName = (value: string) => /^[A-Za-z0-9_.-]{1,64}$/.test(value.trim());

export function isPrintJobProfile(value: unknown): value is PrintJobProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<keyof PrintJobProfile, unknown>;
  const names = profile.spotNames as Record<string, unknown> | undefined;
  const rules = profile.processRules;
  return (profile.route === 'raster' || profile.route === 'specialty') &&
    boundedText(profile.product, 120) && boundedText(profile.version, 60) &&
    boundedText(profile.reference, 600) && boundedText(profile.iccName, 120) &&
    boundedNumber(profile.widthMm, 10, 500) && boundedNumber(profile.heightMm, 10, 500) &&
    boundedNumber(profile.bleedMm, 0, 20) && boundedNumber(profile.safeMm, 0, 20) &&
    boundedNumber(profile.dpi, 150, 1200) && Number.isInteger(profile.dpi) &&
    boundedNumber(profile.minImagePpi, 0, 1200) && Number.isInteger(profile.minImagePpi) &&
    boundedNumber(profile.minPlateWidthMm, 0, 10) && (profile.minKnockoutMm === undefined || boundedNumber(profile.minKnockoutMm, 0, 10)) && boundedNumber(profile.plateTrimMarginMm, 0, 20) &&
    boundedNumber(profile.whiteFoilGapMm, 0, 10) &&
    (profile.faces === 'both' || profile.faces === 'front' || profile.faces === 'either') &&
    (profile.rasterFormat === 'png' || profile.rasterFormat === 'jpeg') &&
    (profile.backOrientation === 'normal' || profile.backOrientation === 'rotate180' || profile.backOrientation === 'mirror') &&
    (profile.colorRequirement === 'standard' || profile.colorRequirement === 'icc') &&
    typeof profile.requireBleedArtwork === 'boolean' && typeof profile.requireVectorPlates === 'boolean' &&
    typeof profile.foilWhiteOverlap === 'boolean' &&
    (rules === undefined || (Array.isArray(rules) && rules.length <= 200 && rules.every((rule: unknown) => {
      if (!rule || typeof rule !== 'object') return false;
      const { stage, after, required } = rule as Partial<FactoryProcessRule>;
      return isFactoryProcessStage(stage) && isFactoryProcessStage(after) && stage !== after &&
        (required === undefined || typeof required === 'boolean');
    }))) &&
    Boolean(names && typeof names === 'object' && !Array.isArray(names) && Object.entries(names).every(([key, name]) =>
      (key === 'white' || key === 'foil') && boundedText(name, 64)));
}
