/**
 * Arco-íris suave em 256 cores, para o nome de um tab enquanto alguém escreve. O blessed só aceita índices da paleta
 * de 256 nas etiquetas, por isso as cores calculam-se em RGB (anel de matizes, mistura com a cor do texto para o
 * desvanecer) e só no fim se escolhe o índice mais próximo no cubo 6×6×6 ou na rampa de cinzentos.
 */
export type Rgb = [number, number, number]

/** "#rrggbb" (a resposta do terminal ao OSC 10/11) para RGB; null se não for isso. */
export function parseHex(s: string | null): Rgb | null {
  const m = s && /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s)
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : null
}

function hsvToRgb(h: number, s: number, v: number): Rgb {
  const f = (n: number) => {
    const k = (n + h * 6) % 6
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))))
  }
  return [f(5), f(3), f(1)]
}

/**
 * Anel de `n` cores ao longo do matiz: pastel (pouca saturação, muito brilho) sobre fundo escuro, fundas sobre fundo
 * claro. Pouca saturação é o que torna o efeito calmo em vez de berrante.
 */
export function rainbowRing(dark: boolean, n = 48): Rgb[] {
  return Array.from({ length: n }, (_, i) => (dark ? hsvToRgb(i / n, 0.45, 0.95) : hsvToRgb(i / n, 0.7, 0.6)))
}

/** Mistura linear de `a` para `b`; `t` de 0 (só `a`) a 1 (só `b`). */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map(i => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as Rgb
}

const CUBE = [0, 95, 135, 175, 215, 255]
const nearestCube = (c: number) => CUBE.reduce((best, v, i) => (Math.abs(v - c) < Math.abs(CUBE[best]! - c) ? i : best), 0)
const dist2 = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

/** Índice da paleta de 256 mais próximo de uma cor: o cubo 6×6×6 (16..231) ou a rampa de cinzentos (232..255). */
export function nearest256(rgb: Rgb): number {
  const [r, g, b] = rgb.map(nearestCube) as Rgb
  const cube = 16 + 36 * r + 6 * g + b
  const cubeRgb: Rgb = [CUBE[r]!, CUBE[g]!, CUBE[b]!]
  const luma = Math.round((rgb[0] + rgb[1] + rgb[2]) / 3)
  const gi = Math.max(0, Math.min(23, Math.round((luma - 8) / 10)))
  const gv = 8 + gi * 10
  return dist2(rgb, [gv, gv, gv]) < dist2(rgb, cubeRgb) ? 232 + gi : cube
}
