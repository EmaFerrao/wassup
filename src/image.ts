import { createJimp } from '@jimp/core'
import { defaultFormats, defaultPlugins } from 'jimp'
import webp from '@jimp/wasm-webp'

const Jimp = createJimp({ formats: [...defaultFormats, webp], plugins: defaultPlugins })

export interface Decoded {
  w: number
  h: number
  png: Buffer
  /** RGBA pixels of the already-downscaled image (max. 400 px wide), for the half-blocks */
  rgba: Buffer
  rw: number
  rh: number
}

const cache = new Map<string, Decoded | Error>()
const pending = new Map<string, Promise<Decoded | Error>>()
// Each decoded image takes up close to 1 MB (PNG for Kitty plus the pixels for the blocks): the cache is limited
// to the most recently used.
const CACHE_MAX = 40

export function cached(path: string): Decoded | Error | undefined {
  const hit = cache.get(path)
  if (hit) { cache.delete(path); cache.set(path, hit) }
  return hit
}

function remember(path: string, d: Decoded | Error) {
  cache.set(path, d)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
}

/**
 * Decodes with sharp (native, off the main thread: a 9 Mpx photo in tens of ms), falling back to jimp (pure
 * JavaScript, hundreds of ms blocking the UI) only when sharp isn't available. Never more than two at once.
 */
type SharpFn = typeof import('sharp').default
let sharpMod: SharpFn | null | undefined
async function loadSharp() {
  if (sharpMod !== undefined) return sharpMod
  try { sharpMod = (await import('sharp')).default } catch { sharpMod = null }
  return sharpMod
}

async function decodeWithSharp(sharp: SharpFn, path: string): Promise<Decoded> {
  const img = sharp(path, { animated: false }).rotate()
  const meta = await img.metadata()
  const w = meta.width ?? 0, h = meta.height ?? 0
  const png = await img.clone().resize({ width: 800, withoutEnlargement: true }).png().toBuffer()
  const { data, info } = await img.clone().resize({ width: 400, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { w, h, png, rgba: Buffer.from(data), rw: info.width, rh: info.height }
}

async function decodeWithJimp(path: string): Promise<Decoded> {
  const img = await Jimp.read(path)
  const w = img.width, h = img.height
  if (w > 800) img.resize({ w: 800 })
  const png = Buffer.from(await img.getBuffer('image/png'))
  const small = img.clone()
  if (small.width > 400) small.resize({ w: 400 })
  return { w, h, png, rgba: Buffer.from(small.bitmap.data), rw: small.width, rh: small.height }
}

const DECODE_CONCURRENCY = 2
let decoding = 0
const waiting: (() => void)[] = []
const acquire = () => new Promise<void>(r => { if (decoding < DECODE_CONCURRENCY) { decoding++; r() } else waiting.push(() => { decoding++; r() }) })
const release = () => { decoding--; waiting.shift()?.() }

export function decode(path: string): Promise<Decoded | Error> {
  const hit = cached(path)
  if (hit) return Promise.resolve(hit)
  const p = pending.get(path)
  if (p) return p
  const job = (async (): Promise<Decoded | Error> => {
    await acquire()
    try {
      const sharp = await loadSharp()
      return sharp ? await decodeWithSharp(sharp, path) : await decodeWithJimp(path)
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    } finally {
      release()
    }
  })()
  pending.set(path, job)
  job.then(r => { remember(path, r); pending.delete(path) })
  return job
}

/**
 * Size in cells for a w×h px image, assuming cells twice as tall as they are wide. With `fill` it occupies the
 * whole available width (shrunk only if the height doesn't fit); without `fill` it never grows past its natural
 * size.
 */
export function cellSize(w: number, h: number, maxCols: number, maxRows: number, fill = false): { cols: number; rows: number } {
  let cols = Math.max(1, fill ? maxCols : Math.min(maxCols, Math.round(w / 8)))
  let rows = Math.max(1, Math.round((cols * h) / w / 2))
  if (rows > maxRows) {
    rows = maxRows
    cols = Math.max(1, Math.round((rows * 2 * w) / h))
  }
  return { cols, rows }
}

/** Rows of ▀ half-blocks in 24-bit color (blessed reduces it to 256 colors): two pixel rows per line. */
export function halfBlocks(d: Decoded, cols: number, rows: number): string[] {
  const out: string[] = []
  const sx = d.rw / cols, sy = d.rh / (rows * 2)
  const px = (x: number, y: number): [number, number, number, number] => {
    const ix = Math.min(d.rw - 1, Math.floor(x * sx)), iy = Math.min(d.rh - 1, Math.floor(y * sy))
    const o = (iy * d.rw + ix) * 4
    return [d.rgba[o]!, d.rgba[o + 1]!, d.rgba[o + 2]!, d.rgba[o + 3]!]
  }
  for (let r = 0; r < rows; r++) {
    let line = ''
    for (let c = 0; c < cols; c++) {
      const [tr, tg, tb, ta] = px(c, r * 2)
      const [br, bg, bb, ba] = px(c, r * 2 + 1)
      if (ta < 64 && ba < 64) line += '\x1b[0m '
      else if (ba < 64) line += `\x1b[0m\x1b[38;2;${tr};${tg};${tb}m▀`
      else if (ta < 64) line += `\x1b[0m\x1b[38;2;${br};${bg};${bb}m▄`
      else line += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m▀`
    }
    out.push(line + '\x1b[0m')
  }
  return out
}

export type ImageMode = 'kitty' | 'blocks' | 'none'

/** `WA_IMAGES` forces the mode; otherwise what the terminal answered during probing is used. */
export function detectImageMode(kittyGraphics: boolean): ImageMode {
  const forced = process.env.WA_IMAGES
  if (forced === 'kitty' || forced === 'blocks' || forced === 'none') return forced
  return kittyGraphics ? 'kitty' : 'blocks'
}

/**
 * Kitty graphics protocol (Ghostty, Kitty, WezTerm): the image is transmitted once per id and then placed in
 * screen cells on every frame. With q=2 the terminal doesn't reply, so as not to mix bytes into blessed's stdin.
 */
export class KittyImages {
  private ids = new Map<string, number>()
  private nextId = 1
  private order: string[] = []
  constructor(private write: (s: string) => void, private maxImages = 60) {}

  private transmit(path: string, png: Buffer): number {
    const id = this.nextId++
    const b64 = png.toString('base64')
    const chunk = 4096
    for (let i = 0; i < b64.length; i += chunk) {
      const last = i + chunk >= b64.length
      const head = i === 0 ? `a=t,f=100,i=${id},q=2,m=${last ? 0 : 1}` : `m=${last ? 0 : 1}`
      this.write(`\x1b_G${head};${b64.slice(i, i + chunk)}\x1b\\`)
    }
    this.ids.set(path, id)
    this.order.push(path)
    if (this.order.length > this.maxImages) {
      const old = this.order.shift()!
      const oldId = this.ids.get(old)
      this.ids.delete(old)
      if (oldId) this.write(`\x1b_Ga=d,d=I,i=${oldId},q=2\x1b\\`)
    }
    return id
  }

  /** Clears every placement on screen (the data stays in the terminal). Call at the start of each frame. */
  clear() {
    this.write('\x1b_Ga=d,d=a,q=2\x1b\\')
  }

  /**
   * Places the image with its top-left corner at cell (col,row), 1-based, occupying cols×rows cells.
   * `crop` is the visible vertical fraction [top,bottom) from 0 to 1, for images partly outside the panel.
   */
  place(path: string, d: Decoded, col: number, row: number, cols: number, rows: number, cropTop = 0, cropBottom = 1) {
    const id = this.ids.get(path) ?? this.transmit(path, d.png)
    const pw = Math.min(d.w, 800), ph = Math.round((d.h * pw) / d.w)
    const y = Math.floor(cropTop * ph), h = Math.max(1, Math.floor((cropBottom - cropTop) * ph))
    this.write(`\x1b7\x1b[${row};${col}H\x1b_Ga=p,i=${id},c=${cols},r=${rows},x=0,y=${y},w=${pw},h=${h},C=1,q=2\x1b\\\x1b8`)
  }

  /** Releases everything, on exit. */
  dispose() {
    this.write('\x1b_Ga=d,d=A,q=2\x1b\\')
    this.ids.clear()
    this.order = []
  }
}
