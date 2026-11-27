import { getStockFinish, processKind, processLayerEnabled, type Project } from './model';
import { stockFinishVisible } from './stockOptics';

export type ModelShading = 'unlit' | 'pbr';

export function supportsMaterialModel(project: Project) {
  const pet = project.material === 'pet-clear';
  if (!pet && !['matte', 'black', 'blue'].includes(project.material)) return false;
  const sides = project.singleSided ? [project.front] : [project.front, project.back];
  let local = false;
  for (const side of sides) {
    if (stockFinishVisible(getStockFinish(project, side))) return false;
    for (const effect of side.effects.filter(processLayerEnabled)) {
      if (processKind(effect) !== (pet ? 'white' : 'foil')) return false;
      if (!pet && effect.type !== 'gold' && effect.type !== 'silver') return false;
      const region = side.regions.find(r => r.id === effect.regionId);
      if (!region) return false;
      if (region.kind !== 'full' || region.inverted || region.strokes.length || effect.maskContent?.length) local = true;
    }
  }
  return local;
}
