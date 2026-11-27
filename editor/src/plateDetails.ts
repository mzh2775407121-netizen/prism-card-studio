type Section = { start: number; end: number; length: number };
type Coverage = { pixels: Uint8Array; width: number; height: number; left: number; right: number; top: number; bottom: number };

/** Locate sustained thin sections. Isolated antialias pixels and tapered tips are not measurements. */
export function findThinSection(mask: Coverage, minPixels: number, ink: boolean) {
  if (minPixels < 3) return;
  for (const across of [true, false]) {
    const first = across ? mask.top : mask.left, last = across ? mask.bottom : mask.right;
    const lo = across ? mask.left : mask.top, hi = across ? mask.right : mask.bottom;
    let previous: Section[] = [];
    for (let line = first; line <= last; line++) {
      const current: Section[] = [];
      let prevIndex = 0;
      const at = (p: number) => Boolean(mask.pixels[across ? line * mask.width + p : p * mask.width + line]);
      for (let p = lo; p <= hi;) {
        if (at(p) !== ink) { p++; continue; }
        const start = p;
        while (p <= hi && at(p) === ink) p++;
        // Clear strips must actually have ink on both sides.
        if ((!ink && (start === lo || p > hi)) || p - start + 1 >= minPixels) continue;
        while (prevIndex < previous.length && previous[prevIndex].start < start - 1) prevIndex++;
        const match = previous[prevIndex];
        const length = match && Math.abs(match.start - start) <= 1 && Math.abs(match.end - p) <= 1 ? match.length + 1 : 1;
        current.push({ start, end: p, length });
        if (length >= Math.max(4, Math.ceil(minPixels * 1.5))) {
          const center = (start + p - 1) / 2;
          return { widthPx: p - start, x: across ? center : line, y: across ? line : center };
        }
      }
      previous = current;
    }
  }
}
