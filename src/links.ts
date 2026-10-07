import fs from 'node:fs'
import { logger } from './log.js'

/**
 * Links in messages: cleaned of what only tracks who shared them and from where, with ClearURLs' rules
 * (`clearurls/data.min.json`, from github.com/ClearURLs/Rules, LGPL-3.0, see `clearurls/LICENSE`), and shortened for
 * showing. The whole clean link is what a click copies.
 */
export const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g

interface Provider { pattern: RegExp; exceptions: RegExp[]; redirections: RegExp[]; raw: RegExp[]; params: RegExp[] }
interface RuleSet { urlPattern: string; completeProvider?: boolean; rules?: string[]; referralMarketing?: string[]; rawRules?: string[]; exceptions?: string[]; redirections?: string[] }

/** What ClearURLs doesn't cover yet: Instagram's share token, and X under its new domain as under twitter.com. */
const EXTRA: RuleSet[] = [
  { urlPattern: '^https?:\\/\\/(?:[a-z0-9-]+\\.)*?instagram\\.com', rules: ['stkn'] },
  { urlPattern: '^https?:\\/\\/(?:[a-z0-9-]+\\.)*?x\\.com', rules: ['(?:ref_?)?src', 's', 'cn', 'ref_url', 't'] },
]

let providers: Provider[] | undefined

/** A rule set made into regular expressions; a pattern that doesn't compile is left out rather than failing all. */
function compile(r: RuleSet): Provider | null {
  const re = (s: string, flags: string) => { try { return new RegExp(s, flags) } catch { return null } }
  const all = (list: string[] | undefined, wrap: (s: string) => string, flags: string) => (list ?? []).map(s => re(wrap(s), flags)).filter((x): x is RegExp => !!x)
  const pattern = re(r.urlPattern, 'i')
  if (!pattern) return null
  return {
    pattern,
    exceptions: all(r.exceptions, s => s, 'i'),
    redirections: all(r.redirections, s => s, 'i'),
    raw: all(r.rawRules, s => s, 'gi'),
    // As the extension does, referral marketing (affiliate tags) goes too.
    params: all([...(r.rules ?? []), ...(r.referralMarketing ?? [])], s => `^${s}$`, 'i'),
  }
}

function load(): Provider[] {
  if (providers) return providers
  const sets: RuleSet[] = []
  try {
    const data = JSON.parse(fs.readFileSync(new URL('./clearurls/data.min.json', import.meta.url), 'utf8')) as { providers: Record<string, RuleSet> }
    // A "complete provider" is a whole site of tracking, which the extension blocks: for showing a link it changes nothing.
    sets.push(...Object.values(data.providers).filter(p => !p.completeProvider))
  } catch (e) {
    logger.warn({ e: String(e) }, 'clearurls rules')
  }
  providers = [...sets, ...EXTRA].map(compile).filter((p): p is Provider => !!p)
  return providers
}

/** The query (or a fragment written as one) without the parameters whose names a rule matches; the rest as written. */
function dropParams(url: string, rules: RegExp[]): string {
  const h = url.indexOf('#')
  let q = url.indexOf('?')
  if (h >= 0 && q > h) q = -1
  const base = url.slice(0, q >= 0 ? q : h >= 0 ? h : url.length)
  const query = q >= 0 ? url.slice(q + 1, h >= 0 ? h : url.length) : ''
  const hash = h >= 0 ? url.slice(h + 1) : ''
  const keep = (part: string) => part.split('&').filter(kv => {
    if (!kv) return false
    let key = kv.split('=')[0]!
    try { key = decodeURIComponent(key) } catch { /* as written */ }
    return !rules.some(r => r.test(key))
  }).join('&')
  const nq = query ? keep(query) : ''
  const nh = hash.includes('=') ? keep(hash) : hash
  return base + (nq ? `?${nq}` : '') + (nh ? `#${nh}` : '')
}

const cleaned = new Map<string, string>()

/**
 * A link without its tracking: for each ClearURLs provider whose pattern takes it (and no exception spares it), a
 * redirection through the site is undone to the link it leads to (itself cleaned), its raw rules are cut out of the
 * whole link, and the parameters named by its rules are dropped. Remembered, as messages are drawn over and over.
 */
export function cleanUrl(url: string, depth = 0): string {
  const known = cleaned.get(url)
  if (known !== undefined) return known
  let out = url
  try {
    for (const p of load()) {
      if (!p.pattern.test(out) || p.exceptions.some(e => e.test(out))) continue
      for (const r of p.redirections) {
        const to = r.exec(out)?.[1]
        if (!to || depth >= 3) continue
        let target = to
        try { target = decodeURIComponent(to) } catch { /* as written */ }
        if (/^https?:\/\//i.test(target)) { out = cleanUrl(target, depth + 1); break }
      }
      for (const r of p.raw) out = out.replace(r, '')
      out = dropParams(out, p.params)
    }
  } catch (e) {
    logger.warn({ e: String(e), url }, 'cleanUrl')
    out = url
  }
  if (cleaned.size > 5000) cleaned.clear()
  cleaned.set(url, out)
  return out
}

/** Longest a link is shown before its path is cut in the middle (or, failing that, its end). */
const SHOWN_MAX = 60

/**
 * A clean link as shown: without "https://", "www." or a final "/"; when that's still long, the path's middle gives
 * way to "…" (the domain stays whole, and the first and last parts of the path, then the query), and past that its
 * end. The parameters that are left after cleaning (a search, an id, a video's start) stay.
 */
export function shortUrl(url: string): string {
  const m = /^https?:\/\/(?:www\.)?([^/?#]+)([^?#]*)(.*)$/i.exec(url)
  if (!m) return url
  const host = m[1]!, path = m[2]!.replace(/\/$/, ''), tail = m[3]!
  let shown = host + path + tail
  if (shown.length <= SHOWN_MAX) return shown
  const parts = path.split('/').filter(Boolean)
  if (parts.length > 2) shown = `${host}/${parts[0]}/…/${parts.at(-1)}${tail}`
  return shown.length <= SHOWN_MAX ? shown : `${shown.slice(0, SHOWN_MAX - 1)}…`
}

/** The links in a text: each as it's shown (clean and short) and the whole clean link a click copies. */
export function linksIn(text: string): { shown: string; url: string }[] {
  return (text.match(URL_RE) ?? []).map(raw => { const url = cleanUrl(raw); return { shown: shortUrl(url), url } })
}

/** A text with its links as they're shown (clean and short). */
export function showLinks(text: string): string {
  return text.replace(URL_RE, raw => shortUrl(cleanUrl(raw)))
}
