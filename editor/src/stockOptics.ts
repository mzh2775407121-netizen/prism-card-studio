import { getStockFinish, type CardSide, type Project, type SideName, type StockFinish } from './model';
import { confirmedStockFinish, isMetalFinish, isTransparentStock, stockPreset } from './stockMaterials';

export type StockLight = { x: number; y: number; opacity: number };
export type StockOptics = { finish: StockFinish; cornerRadius: number; whiteMask?: HTMLCanvasElement };
type Context = CanvasRenderingContext2D;
type Stop = [number, string];
type Point = { x: number; y: number };

export const REST_STOCK_LIGHT: StockLight = { x: 50, y: 50, opacity: 0 };
const TAU = Math.PI * 2;

export function getStockAppearance(project: Project, side: SideName | CardSide): StockFinish {
  const finish = getStockFinish(project, side);
  return finish.match ? { ...finish, match: confirmedStockFinish(project, side) } : finish;
}

export function stockFinishVisible(finish: StockFinish) {
  return finish.style !== 'none' && finish.visible !== false && finish.opacity > 0;
}

export function stockBlendMode(finish: StockFinish): 'source-over' | 'multiply' {
  return finish.match?.method === 'overlaminate' ? 'source-over' : 'multiply';
}

export function stockGroundColor(material: string, finish: StockFinish) {
  if (!isTransparentStock(material)) return stockPreset(material)?.color ?? '#ffffff';
  if (stockFinishVisible(finish) && (isMetalFinish(finish.style) || finish.match?.transparent === false)) return '#d4d7de';
  return material === 'pet-clear' ? 'rgba(238,241,248,.12)' : 'rgba(232,239,249,.18)';
}

function randomSeries(seed: number) {
  return () => {
    seed = seed * 16807 % 2147483647;
    return seed / 2147483647;
  };
}

const dots = (() => {
  const random = randomSeries(68393);
  return Array.from({ length: 468 }, (_, i) => ({
    x: (i % 18 + .18 + random() * .64) / 18,
    y: (Math.floor(i / 18) + .18 + random() * .64) / 26,
    radius: .003 + random() * .0045,
    phase: random() * TAU,
  }));
})();

function clipCell(polygon: Point[], center: Point, other: Point) {
  const dx = other.x - center.x, dy = other.y - center.y;
  const mx = (other.x + center.x) / 2, my = (other.y + center.y) / 2;
  const plane = (p: Point) => (p.x - mx) * dx + (p.y - my) * dy;
  const clipped: Point[] = [];
  polygon.forEach((p, index) => {
    const q = polygon[(index + 1) % polygon.length];
    const a = plane(p), b = plane(q);
    if (a <= 0) clipped.push(p);
    if ((a < 0) !== (b < 0)) clipped.push({ x: p.x + a / (a - b) * (q.x - p.x), y: p.y + a / (a - b) * (q.y - p.y) });
  });
  return clipped;
}

const facets = (() => {
  const random = randomSeries(79819);
  const centers = Array.from({ length: 96 }, (_, i) => ({
    x: (i % 8 + .08 + random() * .84) / 8,
    y: (Math.floor(i / 8) + .08 + random() * .84) / 12,
    phase: random() * TAU,
  }));
  return centers.map(center => ({
    ...center, shape: centers.reduce((cell, other) => center === other ? cell : clipCell(cell, center, other),
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]),
  }));
})();

function band(context: Context, angle: number, x: number, y: number, radius: number, stops: Stop[]) {
  const { width, height } = context.canvas;
  const dx = Math.cos(angle) * radius, dy = Math.sin(angle) * radius;
  const gradient = context.createLinearGradient(x - dx, y - dy, x + dx, y + dy);
  stops.forEach(([at, color]) => gradient.addColorStop(at, color));
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function tint(context: Context, fill: string) {
  context.fillStyle = fill;
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
}

export function paintStockOptics(context: Context, optics: StockOptics, light: StockLight) {
  const { width, height } = context.canvas;
  const { finish, cornerRadius, whiteMask } = optics;
  const energy = .58 + light.opacity * .42;
  const x = width * light.x / 100, y = height * light.y / 100;
  const unit = Math.min(width, height);
  const angle = ((finish.match?.orientationDeg ?? 0) + (finish.style === 'pillar' ? 0 : 28)) * Math.PI / 180;
  const phase = (light.x - 50) * .09 + (light.y - 50) * .057;
  const hue = (light.x - 50) * .45 + (light.y - 50) * .65;

  context.save();
  context.resetTransform();
  context.clearRect(0, 0, width, height);
  context.beginPath();
  context.roundRect(0, 0, width, height, cornerRadius);
  context.clip();
  switch (finish.style) {
    case 'mirror':
      tint(context, 'rgba(104,113,127,.20)');
      band(context, angle, x, y, unit * .16, [[0, '#41485422'], [.24, '#42465062'], [.43, '#c2c6cb81'],
        [.474, '#fdfdfdf2'], [.53, '#fff'], [.56, '#eef0f3a8'], [.69, '#d8dce03f'], [1, '#d8dce000']]);
      break;
    case 'matte-silver':
      tint(context, 'rgba(125,131,141,.22)');
      band(context, angle, x, y, unit * .51, [[0, '#6a707929'], [.22, '#babec324'], [.49, '#f8fafc83'],
        [.64, '#e8eaed59'], [.83, '#c2c5ca22'], [1, '#878e990d']]);
      break;
    case 'rainbow': {
      const stops: Stop[] = [[0, '#ac72df00'], [.12, '#8b66df25']];
      [279, 326, 25, 54, 132, 183, 220].forEach((color, i) => {
        stops.push([.20 + i * .095, `hsla(${color + hue},88%,70%,${.32 + energy * .30})`]);
      });
      stops.push([.88, '#9a78df42'], [1, '#8463de0b']);
      band(context, angle, x, y, unit * .76, stops);
      break;
    }
    case 'dots':
      tint(context, 'rgba(158,167,185,.18)');
      for (const dot of dots) {
        const strength = Math.pow(.5 + .5 * Math.cos(dot.phase + angle + phase), 5);
        const dotX = dot.x * width, dotY = dot.y * height, radius = unit * dot.radius;
        context.beginPath();
        context.arc(dotX, dotY, radius, 0, TAU);
        context.fillStyle = `hsla(${154 + dot.phase * 43 + hue},83%,${43 + strength * 22}%,${.10 + strength * energy * .64})`;
        context.fill();
        if (strength > .4) {
          context.beginPath();
          context.arc(dotX, dotY, radius * strength * .66, 0, TAU);
          context.fillStyle = `rgba(255,255,255,${strength * energy})`;
          context.fill();
        }
      }
      break;
    case 'cracked-ice':
      for (const facet of facets) {
        const orientation = facet.phase + angle;
        const reflection = .5 + .5 * Math.cos(orientation + phase);
        context.beginPath();
        facet.shape.forEach((point, index) => {
          if (index === 0) context.moveTo(point.x * width, point.y * height);
          else context.lineTo(point.x * width, point.y * height);
        });
        context.closePath();
        context.fillStyle = `hsla(${184 + orientation * 32 + hue},${48 + reflection * 43}%,${49 + reflection * 44}%,${.08 + reflection * energy * .64})`;
        context.fill();
        context.strokeStyle = 'rgba(240,243,250,.10)';
        context.lineWidth = Math.max(.35, unit * .0010);
        context.stroke();
      }
      break;
    case 'pillar': {
      const stops: Stop[] = [[0, '#37435c0a']];
      [.09, .22, .38, .55, .68, .87].forEach((center, stripe) => {
        const color = 140 + stripe * 43 + hue;
        const width = stripe % 2 === 0 ? .043 : .052;
        stops.push([center - width, `hsla(${color},55%,50%,.08)`],
          [center - width * .5, `hsla(${color},90%,61%,${.23 + energy * .47})`],
          [center, '#f6f9ffd0'],
          [center + width * .38, `hsla(${color + 40},85%,68%,${.16 + energy * .39})`],
          [center + width, `hsla(${color},55%,52%,.09)`]);
      });
      stops.push([1, '#37435c0a']);
      band(context, angle, x * .63 + width * .185, y * .63 + height * .185, Math.hypot(width, height) * .82, stops);
      break;
    }
    case 'radial': {
      const radial = context.createConicGradient(angle, width * .5, height * .5);
      for (let i = 0; i <= 72; i++) {
        const turn = i / 72 * TAU;
        const strength = .5 + .5 * Math.cos(turn + phase);
        const tone = i % 4 / 4;
        radial.addColorStop(i / 72, `hsla(${(i % 72) * 5 + hue},82%,${68 + tone * 20}%,${.07 + tone * strength * energy * .60})`);
      }
      tint(context, '#9ba1b825');
      context.fillStyle = radial;
      context.fillRect(0, 0, width, height);
      break;
    }
  }
  if (whiteMask) {
    context.globalCompositeOperation = 'destination-out';
    context.drawImage(whiteMask, 0, 0);
  }
  context.restore();
}
