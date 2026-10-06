import type blessed from 'blessed'
import { mix, nearest256, type Rgb } from './rainbow.js'

/**
 * A heart (or a kiss) sent or received alone makes a big heart (or lips), in the emoji's color, rise through the
 * message panel: it's born over the message itself, grows and rises, like Instagram used to do in chat.
 * It draws over everything, only on the cells of the shape, writing directly into blessed's screen buffer from
 * an empty element that is the last to render.
 */
export type Kind = 'heart' | 'kiss'
/**
 * The shape comes from an implicit heart function, sampled at half-cell resolution: each terminal cell has two
 * "pixels", top and bottom, drawn with ▀ and ▄ (top color in the foreground, bottom in the background when both
 * are filled). Each pixel's coverage, via 4×2 subpoints, blends the color with the background and softens the
 * edges; a light from the upper left gives it volume. A cell is about twice as tall as it is wide, so the pixels
 * come out square.
 */
interface Px { cover: number; light: number }
/** Each shape: width in columns for `h` lines, whether normalized (x, y) is inside, and the (x, y) window to sample. */
interface Form { width: (h: number) => number; inside: (x: number, y: number) => boolean; xr: [number, number]; yr: [number, number]; shade?: (x: number, y: number) => number }
const FORMS: Record<Kind, Form> = {
  // Implicit heart: the lobes reach y≈1.15 and the tip y≈-1; max width is x≈±1.15. Square pixels.
  heart: {
    width: h => 2 * h - 1,
    inside: (x, y) => { const a = x * x + y * y - 1; return a * a * a - x * x * y * y * y <= 0 },
    xr: [-1.2, 1.2], yr: [1.2, -1.05],
  },
  // Lips like the kiss mark 💋: twice as wide as tall and tilted about 30°, with the left corner down; the upper
  // lip with the cupid's bow in the middle, the lower one fuller, and the mouth slightly open between them, a
  // slit that closes at the corners.
  kiss: {
    width: h => Math.round(2.25 * h),
    inside: (x, y) => {
      const [u, v] = lipSpace(x, y)
      if (Math.abs(u) >= 1) return false
      const upper = 0.14 + 0.5 * (1 - u * u) - 0.2 * Math.exp(-((u / 0.22) ** 2))
      const lower = -0.62 * Math.pow(1 - u * u, 0.65)
      const gap = 0.11 * Math.sqrt(1 - u * u)
      return (v >= gap && v <= upper) || (v >= lower && v <= -gap)
    },
    xr: [-1.12, 1.12], yr: [1.0, -1.0],
  },
}
/** From drawing space to the tilted-lips space: rotates 30° counterclockwise. */
const TILT = Math.PI / 6
function lipSpace(x: number, y: number): [number, number] {
  return [x * Math.cos(TILT) + y * Math.sin(TILT), -x * Math.sin(TILT) + y * Math.cos(TILT)]
}
/**
 * Pixels per cell: eighths vertically and quarters horizontally, which in a cell twice as tall as it is wide gives
 * square pixels; that's what the eighth blocks (▁▂▃▄▅▆▇) and quarter blocks (▎▌▊) let you draw.
 */
const PW = 4, PH = 8
/** The shape with `H` pixels of height (width follows the shape's proportion); one per height, so growth is pixel by pixel. */
const shapeCache = new Map<string, (Px | null)[][]>()
function makeShape(kind: Kind, H: number): (Px | null)[][] {
  const key = `${kind}:${H}`
  const hit = shapeCache.get(key)
  if (hit) return hit
  const f = FORMS[kind]
  const W = Math.max(1, Math.round(H * (PW * f.width(MAX_H[kind])) / (PH * MAX_H[kind])))
  const px = (r: number, c: number): Px | null => {
    let cover = 0
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      const x = f.xr[0] + (c + (sx + 0.5) / 2) / W * (f.xr[1] - f.xr[0])
      const y = f.yr[0] + (r + (sy + 0.5) / 2) / H * (f.yr[1] - f.yr[0])
      if (f.inside(x, y)) cover++
    }
    cover /= 4
    if (cover < 0.5) return null
    const cx = (c + 0.5) / W * 2 - 1, cy = 1 - (r + 0.5) / H * 2
    let light = Math.max(0, Math.min(1, 1 - Math.hypot(cx + 0.45, cy - 0.5) / 1.5))
    if (f.shade) light *= f.shade(f.xr[0] + (c + 0.5) / W * (f.xr[1] - f.xr[0]), f.yr[0] + (r + 0.5) / H * (f.yr[1] - f.yr[0]))
    return { cover, light }
  }
  const rows: (Px | null)[][] = []
  for (let r = 0; r < H; r++) {
    const row: (Px | null)[] = []
    for (let c = 0; c < W; c++) row.push(px(r, c))
    rows.push(row)
  }
  shapeCache.set(key, rows)
  return rows
}
/**
 * Blocks used to approximate a 4×4-pixel cell: the mask says which pixels the character paints in the foreground
 * color (bit r·4+c, row r top to bottom, column c left to right). Halves, vertical eighths, horizontal quarters and quadrants.
 */
const BLOCKS: { ch: string; mask: number }[] = (() => {
  const m = (f: (r: number, c: number) => boolean) => { let v = 0; for (let r = 0; r < PH; r++) for (let c = 0; c < PW; c++) if (f(r, c)) v |= 1 << (r * PW + c); return v >>> 0 }
  return [
    { ch: '█', mask: m(() => true) },
    { ch: '▁', mask: m(r => r >= 7) }, { ch: '▂', mask: m(r => r >= 6) }, { ch: '▃', mask: m(r => r >= 5) }, { ch: '▄', mask: m(r => r >= 4) },
    { ch: '▅', mask: m(r => r >= 3) }, { ch: '▆', mask: m(r => r >= 2) }, { ch: '▇', mask: m(r => r >= 1) },
    { ch: '▔', mask: m(r => r < 1) }, { ch: '▀', mask: m(r => r < 4) },
    { ch: '▎', mask: m((_r, c) => c < 1) }, { ch: '▌', mask: m((_r, c) => c < 2) }, { ch: '▊', mask: m((_r, c) => c < 3) }, { ch: '▐', mask: m((_r, c) => c >= 2) },
    { ch: '▘', mask: m((r, c) => r < 4 && c < 2) }, { ch: '▝', mask: m((r, c) => r < 4 && c >= 2) },
    { ch: '▖', mask: m((r, c) => r >= 4 && c < 2) }, { ch: '▗', mask: m((r, c) => r >= 4 && c >= 2) },
    { ch: '▚', mask: m((r, c) => (r < 4) === (c < 2)) }, { ch: '▞', mask: m((r, c) => (r < 4) !== (c < 2)) },
    { ch: '▛', mask: m((r, c) => !(r >= 4 && c >= 2)) }, { ch: '▜', mask: m((r, c) => !(r >= 4 && c < 2)) },
    { ch: '▙', mask: m((r, c) => !(r < 4 && c >= 2)) }, { ch: '▟', mask: m((r, c) => !(r < 4 && c < 2)) },
  ]
})()
const FULL = 0xffffffff
const TOP_HALF = BLOCKS.find(b => b.ch === '▀')!.mask
const bits = (v: number) => { v >>>= 0; let n = 0; while (v) { n += v & 1; v >>>= 1 } return n }

/** Max height in lines: lips are shorter, because they're twice as wide. */
const MAX_H: Record<Kind, number> = { heart: 8, kiss: 10 }
const LIFE_MS = 4200
const FRAME_MS = 20

/** Only a heart or a kiss, any color or shape, with nothing else: the shape and color to animate, or nothing. */
export function reaction(text: string): { kind: Kind; color: Rgb } | null {
  const t = text.trim()
  if (/^(?:<3|[♥♡❣💟❤🧡💛💚💙💜🖤🤍🤎🩷🩵🩶💖💗💓💞💕💘💝]️?(?:‍[🔥🩹]️?)?)$/u.test(t)) return { kind: 'heart', color: heartColor(t) }
  // Kissing faces, the kiss mark, the couple (💏, or the 👩‍❤️‍💋‍👨 sequences with the mark in the middle) and ":*".
  const oneEmoji = /^\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic})*$/u.test(t)
  if (/^:-?\*$/.test(t) || (oneEmoji && /[😘😗😙😚💋💏]/u.test(t))) return { kind: 'kiss', color: [225, 30, 70] }
  return null
}

/** The color of the heart used: red by default (❤ ♥ ♡ ❣ 💟 <3, and ❤️‍🔥 and ❤️‍🩹), and each of the others with its own. */
function heartColor(t: string): Rgb {
  if (/🧡/u.test(t)) return [255, 140, 0]
  if (/💛/u.test(t)) return [255, 215, 0]
  if (/💚/u.test(t)) return [0, 200, 80]
  if (/💙/u.test(t)) return [30, 120, 255]
  if (/💜/u.test(t)) return [160, 60, 230]
  if (/🤎/u.test(t)) return [140, 85, 50]
  if (/🖤/u.test(t)) return [70, 70, 70]
  if (/🤍/u.test(t)) return [245, 245, 245]
  if (/🩷/u.test(t)) return [255, 150, 200]
  if (/🩵/u.test(t)) return [110, 200, 255]
  if (/🩶/u.test(t)) return [160, 160, 160]
  if (/[💖💗💓💞💕💘💝]/u.test(t)) return [255, 80, 160]
  return [255, 30, 60]
}

/** Where it's born is resolved on the first draw, once the message is on screen: `at` returns the emoji's cell, or nothing. */
interface Heart { born: number; kind: Kind; color: Rgb; at: () => { x: number; y: number } | null; x?: number; y?: number }

type Cell = [number, string]
type Lines = (Cell[] & { dirty?: boolean })[]

export class Hearts {
  private hearts: Heart[] = []
  private timer: NodeJS.Timeout | undefined
  private layer: blessed.Widgets.BoxElement

  constructor(private screen: blessed.Widgets.Screen, private over: blessed.Widgets.BoxElement, private bg: Rgb, make: typeof blessed.box) {
    // Element with no content or size: it only exists to draw in its turn, over the siblings created before it.
    this.layer = make({ parent: screen, top: 0, left: 0, width: 1, height: 1, hidden: true })
    this.layer.render = (() => { this.draw(); return undefined }) as unknown as typeof this.layer.render
  }

  /** Launches the shape, in the given color, from the cell that `at` reports (the emoji's, in the message). */
  launch(kind: Kind, color: Rgb, at: () => { x: number; y: number } | null) {
    this.hearts.push({ born: Date.now(), kind, color, at })
    if (!this.timer) this.timer = setInterval(() => this.tick(), FRAME_MS)
  }

  private tick() {
    const now = Date.now()
    this.hearts = this.hearts.filter(h => now - h.born < LIFE_MS)
    if (!this.hearts.length && this.timer) { clearInterval(this.timer); this.timer = undefined }
    this.screen.render()
  }

  /** For each live heart: rises over time, grows through three sizes and blends into the background in the last third. */
  private draw() {
    if (!this.hearts.length) return
    const now = Date.now()
    const lines = (this.screen as unknown as { lines: Lines }).lines
    const top = Number(this.over.atop), left = Number(this.over.aleft)
    const height = Number(this.over.height), width = Number(this.over.width)
    for (const h of this.hearts) {
      const p = (now - h.born) / LIFE_MS
      if (p < 0) continue
      if (h.x == null || h.y == null) {
        // The message may not be drawn yet: wait up to half a second; after that it's born at the bottom, centered.
        const pos = h.at()
        if (!pos && now - h.born < 500) continue
        const { x, y } = pos ?? { x: left + Math.floor(width / 2), y: top + height - 1 }
        h.x = x; h.y = y; h.born = now
      }
      // Grows continuously until halfway, then stays at max size.
      const maxH = MAX_H[h.kind]
      const fullH = PH * maxH
      const shape = makeShape(h.kind, Math.max(2, Math.min(fullH, Math.round(p * 2 * fullH))))
      // Full color from start to finish: appears, rises and disappears on reaching the top, without darkening.
      const fade = 0
      // Rises from the message's line, bottom tip starting over the emoji, until it's entirely off the top of the
      // panel, sliding meanwhile toward the center; it never goes off the sides or the bottom. Movement is in
      // quarter-cells in both directions: the shape packs into cells starting from any pixel.
      const H = shape.length, W = shape[0]!.length
      const travelPx = (h.y - top + maxH + 1) * PH
      const topPx = Math.min((top + height) * PH - H, (h.y + 1) * PH - H - Math.round(p * travelPx))
      const ease = 1 - (1 - p) * (1 - p)
      const cxPx = (h.x + 0.5 + (left + width / 2 - h.x - 0.5) * ease) * PW
      const leftPx = Math.max(left * PW, Math.min((left + width) * PW - W, Math.round(cxPx - W / 2)))
      // Volume: the side opposite the light tends toward the terminal's background color (not black), near-white
      // brightness close to it; partial coverage at the edges blends with that same background.
      const color = (qs: Px[]): number => {
        const q = { cover: qs.reduce((a, b) => a + b.cover, 0) / qs.length, light: qs.reduce((a, b) => a + b.light, 0) / qs.length }
        const shaded = mix(mix(h.color, this.bg, 0.5 * (1 - q.light)), [255, 255, 255], 0.45 * Math.max(0, q.light - 0.55) / 0.45)
        return nearest256(mix(shaded, this.bg, Math.max(fade * fade, 1 - q.cover)))
      }
      const firstRow = Math.floor(topPx / PH), lastRow = Math.floor((topPx + H - 1) / PH)
      const firstCol = Math.floor(leftPx / PW), lastCol = Math.floor((leftPx + W - 1) / PW)
      for (let y = Math.max(top, firstRow); y <= Math.min(top + height - 1, lastRow); y++) {
        const row = lines[y]
        if (!row) continue
        for (let x = Math.max(left, firstCol); x <= Math.min(left + width - 1, lastCol); x++) {
          const cell = row[x]
          if (!cell) continue
          // The cell's 32 pixels and the mask of those present.
          const q: (Px | null)[] = []
          let mask = 0
          for (let r = 0; r < PH; r++) for (let c = 0; c < PW; c++) {
            const pr = y * PH + r - topPx, pc = x * PW + c - leftPx
            const v = pr >= 0 && pr < H && pc >= 0 && pc < W ? shape[pr]![pc] ?? null : null
            q.push(v); if (v) mask |= 1 << (r * PW + c)
          }
          mask >>>= 0
          if (!mask) continue
          const keep = cell[0] & 0x1ff
          const pick = (m: number) => q.filter((v, i): v is Px => !!v && !!((m >>> i) & 1))
          // Full cell: ▀ with the top half in the foreground and the bottom in the background, so shading gets half-cell resolution.
          if (mask === FULL) { cell[0] = (color(pick(TOP_HALF)) << 9) | color(pick(~TOP_HALF >>> 0)); cell[1] = '▀'; row.dirty = true; continue }
          // Otherwise the block that misses the fewest pixels. Pixels present outside the block are painted in the
          // cell's background (covering what was there); with none, the background stays. Missing pixels inside the
          // block, or outside it when the background gets painted, count as errors. Ties go to the block covering
          // more present pixels.
          let best = BLOCKS[0]!, bestErr = Infinity, bestHit = -1
          for (const b of BLOCKS) {
            const outside = (mask & ~b.mask) >>> 0
            const err = bits(b.mask & ~mask) + (outside ? bits(~mask & ~b.mask) : 0)
            const hit = bits(b.mask & mask)
            if (err < bestErr || (err === bestErr && hit > bestHit)) { best = b; bestErr = err; bestHit = hit }
          }
          const inside = pick(best.mask), outside = pick(~best.mask >>> 0)
          if (!inside.length) continue
          cell[0] = (color(inside) << 9) | (outside.length ? color(outside) : keep)
          cell[1] = best.ch
          row.dirty = true
        }
      }
    }
  }
}
