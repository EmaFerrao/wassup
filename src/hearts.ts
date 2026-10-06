import type blessed from 'blessed'
import { mix, nearest256, type Rgb } from './rainbow.js'

/**
 * Um coração (ou um beijo) sozinho, enviado ou recebido, faz subir pelo painel de mensagens um coração grande (ou uns
 * lábios), da cor do emoji, que nasce sobre a própria mensagem, cresce e sobe, como o Instagram fazia no chat.
 * Desenha-se por cima de tudo, só nas células do desenho, escrevendo directamente no buffer do ecrã do blessed a partir
 * de um elemento vazio que é o último a renderizar.
 */
export type Kind = 'heart' | 'kiss'
/**
 * A forma vem de uma função implícita de coração, amostrada a meia célula: cada célula do terminal tem dois "pixels",
 * o de cima e o de baixo, desenhados com ▀ e ▄ (a cor de cima no texto, a de baixo no fundo quando ambos estão dentro).
 * A cobertura de cada pixel, por 4×2 subpontos, mistura a cor com o fundo e suaviza as bordas; uma luz de cima à
 * esquerda dá o volume. Uma célula é cerca de duas vezes mais alta que larga, por isso os pixels saem quadrados.
 */
interface Px { cover: number; light: number }
/** Cada forma: largura em colunas para `h` linhas, se (x, y) normalizados estão dentro, e a janela de (x, y) a amostrar. */
interface Form { width: (h: number) => number; inside: (x: number, y: number) => boolean; xr: [number, number]; yr: [number, number]; shade?: (x: number, y: number) => number }
const FORMS: Record<Kind, Form> = {
  // Coração implícito: os lóbulos chegam a y≈1.15 e a ponta a y≈-1; a largura máxima é x≈±1.15. Pixels quadrados.
  heart: {
    width: h => 2 * h - 1,
    inside: (x, y) => { const a = x * x + y * y - 1; return a * a * a - x * x * y * y * y <= 0 },
    xr: [-1.2, 1.2], yr: [1.2, -1.05],
  },
  // Lábios como a marca de beijo 💋: duas vezes mais largos que altos e inclinados uns 30°, com o canto esquerdo em
  // baixo; o lábio de cima com o arco de cupido ao meio, o de baixo mais cheio, e a boca entreaberta entre eles, uma
  // fenda que se fecha nos cantos.
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
/** Do espaço do desenho para o dos lábios deitados: roda 30° no sentido contrário ao dos ponteiros. */
const TILT = Math.PI / 6
function lipSpace(x: number, y: number): [number, number] {
  return [x * Math.cos(TILT) + y * Math.sin(TILT), -x * Math.sin(TILT) + y * Math.cos(TILT)]
}
/**
 * Pixels por célula: oitavos na vertical e quartos na horizontal, que numa célula com o dobro da altura dá pixels
 * quadrados; é o que os blocos de oitavos (▁▂▃▄▅▆▇) e os de quartos (▎▌▊) permitem desenhar.
 */
const PW = 4, PH = 8
/** A forma com `H` pixels de altura (a largura segue a proporção da forma); uma por altura, para o crescimento ser pixel a pixel. */
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
 * Blocos com que se aproxima uma célula de 4×4 pixels: a máscara diz que pixels o carácter pinta com a cor do texto
 * (bit r·4+c, linha r de cima para baixo, coluna c da esquerda para a direita). Metades, oitavos verticais, quartos horizontais e quadrantes.
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

/** Altura máxima em linhas: os lábios são mais baixos, porque são o dobro de largos. */
const MAX_H: Record<Kind, number> = { heart: 8, kiss: 10 }
const LIFE_MS = 4200
const FRAME_MS = 20

/** Só um coração ou um beijo, de qualquer cor ou feitio, sem mais nada: a forma e a cor a animar, ou nada. */
export function reaction(text: string): { kind: Kind; color: Rgb } | null {
  const t = text.trim()
  if (/^(?:<3|[♥♡❣💟❤🧡💛💚💙💜🖤🤍🤎🩷🩵🩶💖💗💓💞💕💘💝]\uFE0F?(?:\u200D[🔥🩹]\uFE0F?)?)$/u.test(t)) return { kind: 'heart', color: heartColor(t) }
  // Caras a beijar, a marca do beijo, o casal (💏, ou as sequências 👩‍❤️‍💋‍👨 com a marca no meio) e o ":*".
  const oneEmoji = /^\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*$/u.test(t)
  if (/^:-?\*$/.test(t) || (oneEmoji && /[😘😗😙😚💋💏]/u.test(t))) return { kind: 'kiss', color: [225, 30, 70] }
  return null
}

/** A cor do coração usado: vermelho por omissão (❤ ♥ ♡ ❣ 💟 <3, e o ❤️‍🔥 e ❤️‍🩹), e cada um dos outros com a sua. */
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

/** Onde nasce resolve-se no primeiro desenho, já com a mensagem no ecrã: `at` devolve a célula do emoji, ou nada. */
interface Heart { born: number; kind: Kind; color: Rgb; at: () => { x: number; y: number } | null; x?: number; y?: number }

type Cell = [number, string]
type Lines = (Cell[] & { dirty?: boolean })[]

export class Hearts {
  private hearts: Heart[] = []
  private timer: NodeJS.Timeout | undefined
  private layer: blessed.Widgets.BoxElement

  constructor(private screen: blessed.Widgets.Screen, private over: blessed.Widgets.BoxElement, private bg: Rgb, make: typeof blessed.box) {
    // Elemento sem conteúdo nem tamanho: só serve para desenhar na sua vez, por cima dos irmãos criados antes.
    this.layer = make({ parent: screen, top: 0, left: 0, width: 1, height: 1, hidden: true })
    this.layer.render = (() => { this.draw(); return undefined }) as unknown as typeof this.layer.render
  }

  /** Lança a forma, da cor dada, a partir da célula que `at` indicar (a do emoji na mensagem). */
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

  /** Para cada coração vivo: sobe com o tempo, cresce em três tamanhos e funde-se com o fundo no último terço. */
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
        // A mensagem pode ainda não estar desenhada: espera-se até meio segundo; depois nasce ao fundo, ao meio.
        const pos = h.at()
        if (!pos && now - h.born < 500) continue
        const { x, y } = pos ?? { x: left + Math.floor(width / 2), y: top + height - 1 }
        h.x = x; h.y = y; h.born = now
      }
      // Cresce continuamente até metade do caminho e depois fica no tamanho máximo.
      const maxH = MAX_H[h.kind]
      const fullH = PH * maxH
      const shape = makeShape(h.kind, Math.max(2, Math.min(fullH, Math.round(p * 2 * fullH))))
      // Cor cheia do princípio ao fim: surge, sobe e desaparece ao chegar ao topo, sem escurecer.
      const fade = 0
      // Sobe desde a linha da mensagem, a ponta de baixo a começar sobre o emoji, até sair toda pelo topo do painel,
      // a deslizar entretanto para o centro; nunca sai pelos lados nem por baixo. O movimento é em quartos de célula
      // nas duas direcções: a forma empacota-se em células a partir de qualquer pixel.
      const H = shape.length, W = shape[0]!.length
      const travelPx = (h.y - top + maxH + 1) * PH
      const topPx = Math.min((top + height) * PH - H, (h.y + 1) * PH - H - Math.round(p * travelPx))
      const ease = 1 - (1 - p) * (1 - p)
      const cxPx = (h.x + 0.5 + (left + width / 2 - h.x - 0.5) * ease) * PW
      const leftPx = Math.max(left * PW, Math.min((left + width) * PW - W, Math.round(cxPx - W / 2)))
      // Volume: o lado oposto à luz tende para a cor de fundo do terminal (não para preto), brilho quase branco perto
      // dela; a cobertura parcial nas bordas mistura com o mesmo fundo.
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
          // Os 32 pixels da célula e a máscara dos presentes.
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
          // Célula cheia: ▀ com a metade de cima no texto e a de baixo no fundo, para o sombreado ter meia célula.
          if (mask === FULL) { cell[0] = (color(pick(TOP_HALF)) << 9) | color(pick(~TOP_HALF >>> 0)); cell[1] = '▀'; row.dirty = true; continue }
          // Senão o bloco que erra menos pixels. Os presentes fora do bloco pintam-se no fundo da célula (tapando o
          // que lá estava); sem nenhum, o fundo fica. Pixels ausentes dentro do bloco, ou fora dele quando o fundo é
          // pintado, contam como erro. Em empate, o bloco que cobre mais presentes.
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
