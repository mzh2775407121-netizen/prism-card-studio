declare module 'fontkit' {
  export interface GlyphCommand {
    command: 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'closePath';
    args: number[];
  }

  export interface Font {
    unitsPerEm: number;
    hasGlyphForCodePoint(codePoint: number): boolean;
    getVariation(settings: { wght: number }): Font;
    layout(text: string, features?: Record<string, boolean>): {
      glyphs: { path: { commands: GlyphCommand[] }; codePoints: number[]; id: number }[];
      positions: { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }[];
    };
  }

  export function create(bytes: Uint8Array): Font;
}
