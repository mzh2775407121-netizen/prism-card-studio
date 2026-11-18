type IconSize = number | readonly [number, number];

const iconSizes = {
  'project-mark': [23.8095, 20.5772],
  'panel-left-close': 16,
  'panel-right-close': 16,
  'finished-preview': 20,
  'stock-chevron': [13, 12],
  'layers-search': 16,
  'tool-select': 16,
  'tool-chevron': 10,
  'tool-line': 16,
  'tool-rectangle': 16,
  'tool-text': 16,
  'tool-pen': 16,
  'layer-more': 12.5,
  'layer-default': 12,
  'layer-group': 12,
  'layer-chevron': 10,
  'layer-polygon': 12,
  'layer-unlock': 12,
  'layer-eye': 12,
  'align-horizontal-start': 12,
  'align-horizontal-center': 12,
  'align-horizontal-end': 12,
  'align-vertical-start': 12,
  'align-vertical-center': 12,
  'align-vertical-end': 12,
  'rotate-left': 12,
  'flip-horizontal': 12,
  'flip-vertical': 12,
  'appearance-corner': 13.2,
  'appearance-eye': 15.4,
  'section-add': 15.4,
  'paint-eye': 15.4,
  'paint-remove': 15.4,
  'type-chevron': 7,
  'type-line-height': [14, 16],
  'type-letter-spacing': 16,
  'type-align-left': [17, 14],
  'type-align-center': [33, 22],
  'type-align-right': [33, 22],
  'type-align-top': 16,
  'type-align-middle': [33, 22],
  'type-align-bottom': [33, 22],
  'inspector-mask-eye': 14,
  'inspector-mask-edit': 14,
} as const satisfies Record<string, IconSize>;

export default function FigmaIcon({ name, className = '' }: {
  name: keyof typeof iconSizes;
  className?: string;
}) {
  const size = iconSizes[name];
  const [width, height] = typeof size === 'number' ? [size, size] : size;
  return <img className={`figma-icon ${className}`} src={`/assets/editor-icons/${name}.svg`}
    alt="" width={width} height={height} draggable={false}/>;
}

