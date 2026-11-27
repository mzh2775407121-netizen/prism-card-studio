import type { CSSProperties } from 'react';
import './auth-showcase.css';

type Artwork = {
  asset: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  radius?: number;
  foil?: boolean;
};

const assetUrl = (name: string) => '/assets/auth/showcase-' + name;

const slides: Array<{ id: string; label: string; title: string; description: string; glow: Artwork[]; cards: Artwork[] }> = [
  {
    id: 'studio',
    label: '卡牌工作室',
    title: 'Prism 卡牌工作室｜一站式打造收藏级卡牌',
    description: 'AI 灵感生成 + 全息图层精修，和 Agent 一起打造专属套卡',
    glow: [
      { asset: 'studio-cyan.svg', x: -160, y: -170, width: 560, height: 560 },
      { asset: 'studio-violet.svg', x: 60, y: -40, width: 520, height: 520 },
    ],
    cards: [
      { asset: 'card-thunder.jpg', x: 54.65, y: 78.42, width: 162, height: 232, rotation: -11, opacity: .78 },
      { asset: 'card-yellow.jpg', x: 190.38, y: 123.32, width: 162, height: 232, rotation: 11, opacity: .78 },
      { asset: 'card-flare.jpg', x: 109, y: 64, width: 190, height: 272 },
    ],
  },
  {
    id: 'agent',
    label: 'Agent 对话创作',
    title: '对话即创作｜输入想法，Agent 自动构图出卡',
    description: '一句话描述世界观与画风，自动生成角色、边框与技能文案',
    glow: [
      { asset: 'agent-cyan.svg', x: -20, y: -150, width: 540, height: 540 },
      { asset: 'agent-blue.svg', x: -140, y: 40, width: 460, height: 460 },
    ],
    cards: [
      { asset: 'card-thunder.jpg', x: 166.24, y: 52.61, width: 178, height: 254, rotation: 6, opacity: .96 },
      { asset: 'card-spark.jpg', x: 56.03, y: 62.67, width: 148, height: 212, rotation: -8, opacity: .72 },
    ],
  },
  {
    id: 'craft',
    label: '图层与工艺精修',
    title: '专业图层精修｜一键叠加全息与烫金工艺',
    description: '精细控制轮廓光效、卡背纹样与印前尺寸，所见即所得',
    glow: [
      { asset: 'craft-violet.svg', x: -150, y: -90, width: 540, height: 540 },
      { asset: 'craft-cyan.svg', x: 80, y: 20, width: 480, height: 480 },
    ],
    cards: [
      { asset: 'card-foil.png', x: 136, y: 88, width: 176, height: 250, opacity: .65, foil: true },
      { asset: 'card-flare.jpg', x: 82, y: 54, width: 176, height: 250 },
    ],
  },
  {
    id: 'community',
    label: '社区与资产库',
    title: '灵感社区与资产库｜管理你的每一套作品',
    description: '云端同步套卡资产，探索全球创作者的高赞卡面与模板',
    glow: [
      { asset: 'community-gold.svg', x: 10, y: -150, width: 520, height: 520 },
      { asset: 'community-violet.svg', x: -160, y: 30, width: 520, height: 520 },
    ],
    cards: [
      { asset: 'card-yellow.jpg', x: 43.01, y: 28.66, width: 146, height: 206, rotation: -4, opacity: .90, radius: 12 },
      { asset: 'card-flare.jpg', x: 213.01, y: 12.66, width: 146, height: 206, rotation: -4, opacity: .96, radius: 12 },
      { asset: 'card-spark.jpg', x: 61.01, y: 250.66, width: 146, height: 206, rotation: -4, opacity: .78, radius: 12 },
      { asset: 'card-thunder.jpg', x: 231.01, y: 234.66, width: 146, height: 206, rotation: -4, opacity: .85, radius: 12 },
    ],
  },
];

function artworkStyle(art: Artwork): CSSProperties {
  return {
    '--art-x': art.x,
    '--art-y': art.y,
    '--art-width': art.width,
    '--art-height': art.height,
    '--art-rotation': (art.rotation ?? 0) + 'deg',
    '--art-radius': art.radius ?? 14,
    opacity: art.opacity,
  } as CSSProperties;
}

const swatches = [
  { color: 'blue', label: '全息闪膜', value: '80%', x: 234, y: 72 },
  { color: 'gold', label: '轮廓烫金', value: 'ON', x: 242, y: 198 },
  { color: 'violet', label: '印前规范', value: '63×88mm', x: 30, y: 272 },
];

export function AuthShowcase({ slide, onSlide }: { slide: number; onSlide: (index: number) => void }) {
  const activeSlide = slides[slide] ?? slides[0];

  return <aside className="auth-showcase" aria-label="Prism 功能预览">
    {slides.map(scene => <div
      className={'auth-showcase__scene auth-showcase__scene--' + scene.id}
      key={scene.id}
      data-active={scene === activeSlide || undefined}
      aria-hidden={scene !== activeSlide}
    >
      {scene.glow.map(art => <img
        key={art.asset} className="auth-showcase__art" src={assetUrl(art.asset)}
        width={art.width} height={art.height} style={artworkStyle(art)} alt=""
      />)}
      {scene.cards.map(art => <span
        key={art.asset} className="auth-showcase__art auth-showcase__card"
        data-foil={art.foil || undefined} style={artworkStyle(art)}
      >
        <img src={assetUrl(art.asset)} alt="" draggable={false} />
      </span>)}

      {scene.id === 'agent' && <div className="auth-showcase__prompt">
        <div className="auth-showcase__agent">
          <img src={assetUrl('agent-star.svg')} alt="" width={13} height={13} />
          <span>Prism Agent · 正在生成卡面</span>
        </div>
        <div className="auth-showcase__request">
          <span>帮我创建一张深海幻影风格的闪卡，带全息光纹</span>
          <span className="auth-showcase__send" aria-hidden="true">
            <img src={assetUrl('agent-arrow.svg')} alt="" width={13} height={13} />
          </span>
        </div>
      </div>}

      {scene.id === 'craft' && swatches.map(swatch => <div
        className="auth-showcase__swatch" key={swatch.color}
        style={{ '--art-x': swatch.x, '--art-y': swatch.y } as CSSProperties}
      >
        <img src={assetUrl('craft-' + swatch.color + '-dot.svg')} alt="" width={7} height={7} />
        <span>{swatch.label}</span>
        <span>{swatch.value}</span>
      </div>)}

      <div className="auth-showcase__scrim" />
    </div>)}

    <div className="auth-showcase__copy">
      <p className="auth-showcase__title">{activeSlide.title}</p>
      <p className="auth-showcase__description">{activeSlide.description}</p>
      <div className="auth-showcase__pager" aria-label="切换预览">
        {slides.map((scene, index) => <button
          key={scene.id} type="button" aria-label={scene.label} aria-pressed={scene === activeSlide}
          onClick={() => onSlide(index)}
        />)}
      </div>
    </div>
  </aside>;
}
