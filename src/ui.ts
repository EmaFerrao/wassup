import blessed from 'blessed'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import QRCode from 'qrcode'
import { store, type ChatRow, type MessageRow, type ReactionRow } from './db.js'
import { chatName, contactName, thumbPath, mediaFile, jidUser, type ConnState } from './yap.js'
import { inHerdr, reportHerdr, titleHerdr, releaseHerdr, openChatHerdr, focusTabHerdr } from './herdr.js'
import type { Backend } from './backend.js'
import { waMarkup, clipTagged, esc, colorFor, setTheme, dim, faint, italic, padding, urlsIn, fmtTime, fmtDay, dayKey, truncate, strWidth, wrapTagged, alignRight, visibleWidth, wrapWidth, fold, graphemes, wrapChars } from './format.js'
import { decode, cached, cellSize, halfBlocks, detectImageMode, KittyImages, type Decoded, type ImageMode } from './image.js'
import { logger, uiLog } from './log.js'
import { patchBlessedDraw, patchBlessedUnicode } from './unicode.js'
import type { TermCaps } from './term.js'
import { emojify, completeEmoji } from './emoji.js'
import { enableKittyKeyboard } from './kittykeys.js'
import { enableBracketedPaste } from './paste.js'
import { Hearts, reaction } from './hearts.js'
import { t } from './i18n.js'
import { parseHex, rainbowRing, mix, nearest256, type Rgb } from './rainbow.js'
import { suggest, llmEnabled, type Suggestion } from './llm.js'
import { patchBlessedItalic } from './italic.js'

/** WhatsApp Web's quick reactions, in its order, plus "⋯" for typing any other. */
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏', '⋯']

type Focus = 'picker' | 'messages' | 'input'

/** An image in the panel: ready (with pixels) or just reserved, waiting to be downloaded and decoded once it becomes visible. */
interface ImageSlot { row: MessageRow; origLine: number; cols: number; rows: number; pad: number; path?: string; d?: Decoded }

/** What each terminal keeps in `state`: its tabs, the process that holds them, and the last interaction. */
interface TerminalState { tabs: string[]; active: number; pid?: number; lastActive?: number; herdrTab?: string }

function pidAlive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.charAt(stat.lastIndexOf(')') + 2) !== 'Z'
  } catch { return false }
}

/** A segment of the tab bar: which tab it corresponds to and where its × is (or whether it's the +). */
interface TabSegment { x0: number; x1: number; index: number; closeX0: number; closeX1: number }

const num = (x: unknown): number => x as number

// Internal blessed fields the UI uses: the lines already wrapped to the panel width and the maps between
// original line and drawn line (ftor: original→drawn, rtof: drawn→original).
interface ClinesBox extends blessed.Widgets.BoxElement {
  _clines: string[] & { ftor: number[][]; rtof: number[] }
  childBase: number
}

/** How long the rainbow fade lasts after the person stops typing. */
const FADE_MS = 1500
/** The notice for a message in another chat: time to appear, stay, and disappear, in milliseconds. */
const NOTICE = { fadeIn: 400, hold: 6000, fadeOut: 800 }

const HELP = t('help')

// Terminal theme colors, never assumed: default foreground and background, and the 16 named ones, which the theme
// guarantees are readable over its background. Transient notices are discreet; only waiting for the QR code and
// connection drops stand out. Connected is not shown.
const FG = { tab: 'default', badge: 'red', warn: 'yellow', error: 'red' }

/** Gray from the 256-color ramp (232..255, from #080808 to #eeeeee in steps of 10) closest to a given luminance. */
function gray256(luma: number): number {
  return 232 + Math.max(0, Math.min(23, Math.round((luma - 8) / 10)))
}

/**
 * What's derived from the terminal's real background (OSC 11): whether the theme is dark, and the gray for the
 * selected-message highlight, moved away from its luminance toward the light side on a dark theme and toward the
 * dark side on a light one. With no response, dark is assumed and the highlight is a medium gray, readable with
 * either light or dark text.
 */
function theme(bg: string | null): { dark: boolean; selected: number } {
  const m = bg && /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg)
  if (!m) return { dark: true, selected: 240 }
  const luma = 0.299 * parseInt(m[1]!, 16) + 0.587 * parseInt(m[2]!, 16) + 0.114 * parseInt(m[3]!, 16)
  const dark = luma < 128
  return { dark, selected: gray256(luma + (dark ? 48 : -48)) }
}

/**
 * A key applied to a text with a cursor (in graphemes): arrows, Home/End, Backspace/Delete, Ctrl-U (everything),
 * Shift+Backspace (previous word, only on terminals with the Kitty keyboard protocol), and typed characters,
 * inserted at the cursor, with :codes: and smileys swapped for the emoji as soon as they're complete. Returns null
 * if the key isn't an editing key.
 */
function edit(value: string, cursor: number, k: string, ch: string, key: blessed.Widgets.Events.IKeyEventArg): { value: string; cursor: number } | null {
  const chars = graphemes(value)
  const at = Math.min(cursor, chars.length)
  const join = (before: string[], after: string[]) => ({ value: before.join('') + after.join(''), cursor: before.length })
  if (k === 'left') return { value, cursor: Math.max(0, at - 1) }
  if (k === 'right') return { value, cursor: Math.min(chars.length, at + 1) }
  if (k === 'home') return { value, cursor: 0 }
  if (k === 'end') return { value, cursor: chars.length }
  if (k === 'backspace') return join(chars.slice(0, Math.max(0, at - 1)), chars.slice(at))
  if (k === 'delete') return join(chars.slice(0, at), chars.slice(at + 1))
  if (k === 'C-u') return join([], [])
  if (k === 'S-backspace') return join(graphemes(chars.slice(0, at).join('').replace(/\S*\s*$/, '')), chars.slice(at))
  if (ch && !key.ctrl && !key.meta && ch >= ' ' && ch !== '\x7f') {
    // On closing a :code: or isolating a smiley with space/punctuation, the text is swapped for the emoji right away.
    const before = chars.slice(0, at).join('') + ch
    return join(graphemes(/[:\s.,!?]/.test(ch) ? emojify(before) : before), chars.slice(at))
  }
  return null
}



export class Ui {
  private screen: blessed.Widgets.Screen
  private tabsBar: blessed.Widgets.BoxElement
  private msgBox: ClinesBox
  private input: blessed.Widgets.BoxElement
  private picker: blessed.Widgets.ListElement
  /** Notice of a new message in another chat: a line with a background, sitting over its tab in the bar. */
  private toast: blessed.Widgets.BoxElement
  /** Emoji suggestions for the :prefix before the cursor: the box above the input, the options, the chosen one, and where the prefix starts. */
  private suggest: blessed.Widgets.BoxElement
  private suggestions: { emoji: string; name: string }[] = []
  private suggestIndex = 0
  private suggestStart = 0
  /** Local model suggestion for the text `text` (continuation or correction), requested 150 ms after the last keystroke and shown for 4 s. */
  private ghost: { text: string; s: Suggestion } | undefined
  /** The correction floating right above the word it replaces. */
  private ghostBox!: blessed.Widgets.BoxElement
  private ghostTimer: NodeJS.Timeout | undefined
  private ghostAbort: AbortController | undefined
  /** Right-arrow presses with the next suggestion still on the way: accepted on arrival, one per arrow, so → → → correct in a chain. */
  private acceptOnArrival = 0
  private ghostHide: NodeJS.Timeout | undefined
  /** The text as it was left after accepting a suggestion that ended mid-word: the next letter gets a space before it. */
  private accepted: string | undefined
  /** The notice for a message in another chat and the moment it started appearing; the clock animates it until it's gone. */
  private notice: { jid: string; text: string; since: number } | undefined
  private noticeTimer: NodeJS.Timeout | undefined

  private tabs: string[] = []
  private active = -1
  private segments: TabSegment[] = []
  private pickerOpen = false
  private chats: ChatRow[] = []
  private filtered: ChatRow[] = []
  private filter = ''
  private pickerFilterShown: string | undefined
  private focus: Focus = 'input'
  private inputValue = ''
  /** Cursor position in the input and in the chat filter, in graphemes. */
  private cursor = 0
  private filterCursor = 0
  /** Layout of the input on the last draw, used to map clicks: grapheme lines and the first visible line. */
  private inputLines: string[][] = [[]]
  private inputTop = 0
  private disableKittyKeyboard?: () => void
  private disablePaste: () => void
  private hearts: Hearts
  /** The message being dragged right to reply to it, and by how many columns. */
  private drag: { id: string; dx: number } | undefined
  /** Chats whose Herdr tab was requested recently and may not be registered yet. */
  private spawning = new Set<string>()
  private lineMap: (MessageRow | null)[] = []
  /** Content lines (indices in `lineMap`) holding a message's name and time: the only ones a drag replies from. */
  private headerLines = new Set<number>()
  /**
   * Content lines holding a message's own text (or caption), with the columns (within the panel, end exclusive)
   * the text occupies: the only cells the text selection takes. The last one also carries the time, after the text.
   */
  private textLines = new Map<number, { start: number; end: number }>()
  /**
   * Text being selected with the mouse: the cell pressed (`ax`, `ay`) and the one the pointer is at (`hx`, `hy`),
   * swept in reading order within the columns of the panel it started in (`xi`..`xl`). Copied to the clipboard on
   * release and kept highlighted until the next click or key.
   */
  private textSel: { ax: number; ay: number; hx: number; hy: number; xi: number; xl: number; input: boolean } | undefined
  /** The terminal reports the pointer's movement with no button held (mode 1003): only then is there a hover. */
  private anyMotion: boolean
  /** Message under the pointer: its name line gets a "☺" that opens the quick reactions. */
  private hover: MessageRow | undefined
  /** Message whose quick-reaction bar is open, after a click on its "☺". */
  private quickFor: MessageRow | undefined
  /** Where the "☺" or the bar were last drawn, so the click can find them. */
  private quickHit: { y: number; icon?: number; items?: { x: number; w: number; emoji: string }[] } | undefined
  /** Where the pointer is (terminals that report motion): the reaction under it is drawn highlighted. */
  private pointer: { x: number; y: number } | undefined
  /** Drawn messages, in order; the selected one (click or arrows in the panel) and the one being replied to or reacted to. */
  private rows: MessageRow[] = []
  private selected: MessageRow | null = null
  private replyTo: MessageRow | null = null
  /** My own message open in the input for editing (Backspace or Delete with an empty line). */
  private editing: MessageRow | null = null
  /** What's left unsent in each chat: switching tabs swaps the input, so nothing goes to the wrong person. */
  private drafts = new Map<string, { value: string; cursor: number }>()
  private reactTo: MessageRow | null = null
  private inputHeader = false
  private images: ImageSlot[] = []
  private mode: ImageMode
  private kitty: KittyImages | undefined
  private connText = t('connecting')
  private transient = ''
  private transientTimer: NodeJS.Timeout | undefined
  private atBottom = true
  private renderTimer: NodeJS.Timeout | undefined
  /**
   * Chats where someone is typing (null) or just stopped (the moment they stopped, for the rainbow to fade), and the
   * clock that redraws the bar while there are names animating.
   */
  private typing = new Map<string, number | null>()
  private typingTimer: NodeJS.Timeout | undefined
  private ring: Rgb[]
  private fgRgb: Rgb
  private bgRgb: Rgb
  private dirtyTabs = true
  private dirtyMessages = true
  private showingQr = false

  /** Whether the terminal background is dark (decides the strong color of the active tab and of names) and the gray for the selected message. */
  private dark: boolean
  private selectedBg: number

  /**
   * `yap ema`, or any startup inside Herdr: only one chat at a time. No tabs (in Herdr, the tabs are its own) and no
   * notices or state from the others; the picker switches it.
   */
  private get fixed(): boolean { return !!this.wanted || inHerdr }
  /** Input lines: two at minimum, growing with the text up to half the screen. */
  private inputRows = 1
  /** Lines occupied at the bottom: the input. */
  private get bottom(): number { return this.inputRows }
  /** Lines occupied at the top: the tab bar (1), which doesn't exist in single-chat mode. */
  private get barRows(): number { return this.fixed ? 0 : 1 }

  constructor(private yap: Backend, caps: TermCaps, private wanted?: string) {
    this.mode = detectImageMode(caps.kittyGraphics, inHerdr)
    ;({ dark: this.dark, selected: this.selectedBg } = theme(caps.bg))
    this.ring = rainbowRing(this.dark)
    this.fgRgb = parseHex(caps.fg) ?? (this.dark ? [192, 192, 192] : [48, 48, 48])
    this.bgRgb = parseHex(caps.bg) ?? (this.dark ? [0, 0, 0] : [255, 255, 255])
    setTheme(this.dark)
    patchBlessedUnicode()
    this.screen = blessed.screen({ smartCSR: true, fullUnicode: caps.utf8, title: 'yap', warnings: false })
    // Each patch rebuilds `draw` from the source of the one before, so the italic one, which only knows blessed's own
    // variables, goes first; the wide-emoji one then adds its own on top.
    patchBlessedItalic(this.screen); patchBlessedDraw()
    // With a UTF-8 locale, frames come out in Unicode box-drawing characters (─│┌). Without this, blessed switches to
    // the DEC line-drawing set, which SSH apps on phones don't know and show as q, x, l, k.
    if (caps.utf8) (this.screen.program as unknown as { tput: { brokenACS: boolean } }).tput.brokenACS = true
    const program = this.screen.program as unknown as { _write: (s: string) => void }
    if (this.mode === 'kitty') this.kitty = new KittyImages(s => program._write(s))
    // Only with the terminal confirming the protocol: it's what lets Shift+Backspace be distinguished, for deleting words.
    if (caps.kittyKeyboard) this.disableKittyKeyboard = enableKittyKeyboard((this.screen.program as unknown as { input: Parameters<typeof enableKittyKeyboard>[0] }).input, s => program._write(s))
    // Outside the Kitty translator: pasted text doesn't go through it.
    this.disablePaste = enableBracketedPaste((this.screen.program as unknown as { input: Parameters<typeof enableBracketedPaste>[0] }).input, s => program._write(s))
    logger.info({ caps, images: this.mode, dark: this.dark, term: process.env.TERM }, 'terminal')

    // Layout: the tab bar at the top with status on the right, messages at full width, input in one line at the bottom, growing with the text.
    this.tabsBar = blessed.box({
      parent: this.screen, top: 0, left: 0, width: '100%', height: 1, tags: true, mouse: true,
    })
    this.msgBox = blessed.box({
      parent: this.screen, top: this.barRows, left: 0, right: 0, height: `100%-${this.bottom + this.barRows}`, padding: { left: 1 },
      // The lines arrive wrapped to the panel's width already (blessed only wraps from the left, and measures emoji
      // one unit too long); left to itself it would still cut a line that reaches the edge at its last word.
      tags: true, wrap: false, scrollable: true, alwaysScroll: true, mouse: true,
    }) as ClinesBox
    this.input = blessed.box({
      parent: this.screen, top: `100%-${this.bottom}`, left: 0, right: 0, height: this.inputRows, padding: { left: 1 },
      tags: true, mouse: true,
    })
    this.picker = blessed.list({
      parent: this.screen, top: this.barRows, left: 0, right: 0, height: `100%-${this.bottom + this.barRows + 1}`, padding: { left: 1 }, hidden: true,
      tags: true, keys: true, mouse: true,
      // The selected chat is marked as the active tab: bold and the theme's strongest color, without inverting.
      style: { selected: { bold: true, fg: this.dark ? 'bright-white' : 'black' } } as unknown as blessed.Widgets.ListElementStyle,
    })
    // Floating over the messages (status at the top right, "typing…" above the input); created last so it stays on top.
    this.toast = blessed.box({ parent: this.screen, top: 0, left: 0, width: 1, height: 1, tags: true, hidden: true })
    // In single-chat mode the bar is gone and messages gain the line; status goes to the floating box, on the right.
    if (this.fixed) this.tabsBar.hide()
    // Emoji suggestions, above the input and over the messages, with the highlight background to stand out.
    this.suggest = blessed.box({
      parent: this.screen, top: '100%-4', left: 0, width: 1, height: 1, tags: true, hidden: true, padding: { left: 1 }, wrap: false, mouse: true,
      style: { bg: this.selectedBg } as unknown as blessed.Widgets.Types.TStyle,
    })
    // The model's correction, floating one line above the word it replaces, with the same background.
    this.ghostBox = blessed.box({
      parent: this.screen, top: 0, left: 0, width: 1, height: 1, tags: true, hidden: true, wrap: false,
      style: { bg: this.selectedBg } as unknown as blessed.Widgets.Types.TStyle,
    })
    // A click on a line of the emoji list selects that one.
    this.suggest.on('click', (data: { x: number; y: number }) => {
      const i = data.y - num(this.suggest.atop)
      if (i < 0 || i >= this.suggestions.length) return
      this.suggestIndex = i
      this.acceptSuggestion()
    })

    // Above everything, the emoji rising when a message or reaction is a single emoji, sent or received.
    this.hearts = new Hearts(this.screen, this.msgBox, this.bgRgb, blessed.box)
    // Topmost of all: in its turn, inverts the cells of the text selection and draws the "☺" or the quick reactions
    // over the hovered message, whatever panel drew the cells.
    const overlay = blessed.box({ parent: this.screen, top: 0, left: 0, width: 1, height: 1, hidden: true })
    overlay.render = (() => { this.drawTextSel(); this.drawQuick(); return undefined }) as unknown as typeof overlay.render

    // Mouse with clicks, wheel and motion while a button is held (1000+1002) in SGR encoding (1006), instead of the
    // set blessed enables for xterm (1000/1002/1003/1005): any-motion reporting (1003) and UTF-8 encoding (1005)
    // confuse SSH apps on phones like Termius, which with 1000+1006 send taps as clicks. Any-motion reporting, which
    // the hover needs, is only asked of terminals that identified themselves (XTVERSION): desktop ones, not those
    // apps. blessed turns off whatever was enabled on exit.
    this.anyMotion = caps.version != null
    const mouse = this.screen.program as unknown as { disableMouse: () => void; setMouse: (o: Record<string, boolean>, enable: boolean) => void; _bindMouse: (s: string, buf: Buffer) => void }
    mouse.disableMouse()
    mouse.setMouse({ vt200Mouse: true, cellMotion: true, allMotion: this.anyMotion, sgrMouse: true }, true)
    // blessed only reads the first mouse sequence in each byte packet, and terminals send the button press and
    // release (or two wheel notches) in the same packet: the release was lost and there was never a click. The
    // packet is split into individual SGR sequences before blessed reads them.
    const bindMouse = mouse._bindMouse
    mouse._bindMouse = (s, buf) => {
      const parts = s.match(/\x1b\[<\d+;\d+;\d+[mM]|[^\x1b]+|\x1b(?!\[<)[\s\S]*?(?=\x1b\[<|$)/g)
      if (!parts || parts.length <= 1) return bindMouse.call(mouse, s, buf)
      for (const part of parts) bindMouse.call(mouse, part, Buffer.from(part, 'latin1'))
    }
    this.screen.program.hideCursor()
    this.bindEvents()
    this.registerTerminal()
    this.setFocus('input')
    this.drawInput()
    this.drawStatus()
    // `yap paula` opens that chat right away: the first, from most recent backward, whose name or number contains the text.
    if (this.wanted) {
      const jid = this.findChat(this.wanted)
      if (!jid) { this.quit(t('noChatWith', this.wanted)); return }
      this.openTab(jid)
    }
    this.renderNow()
    // drawStatus has already left the tab bar drawn, so the renderNow above doesn't touch the title or Herdr.
    this.updateTitle()
  }

  private get current(): string | null {
    return this.tabs[this.active] ?? null
  }

  // ---------- events ----------

  private bindEvents() {
    this.bindDiagnostics()
    this.screen.on('keypress', (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => this.onKey(ch, key))
    // The picker list has its position and height calculated by hand: it's recomputed when the terminal resizes.
    this.screen.on('resize', () => { this.dirtyMessages = true; this.dirtyTabs = true; if (this.pickerOpen) this.refreshPicker(); this.scheduleRender() })
    this.screen.on('render', () => { this.loadVisibleImages(); this.placeImages() })

    // The mouse wheel scrolls one line per notch (by default blessed jumps half the panel, or two list entries).
    this.msgBox.removeAllListeners('wheeldown')
    this.msgBox.removeAllListeners('wheelup')
    this.msgBox.on('wheeldown', () => { this.msgBox.scroll(1); this.screen.render() })
    this.msgBox.on('wheelup', () => { this.msgBox.scroll(-1); this.screen.render() })
    this.picker.removeAllListeners('element wheeldown')
    this.picker.removeAllListeners('element wheelup')
    this.picker.on('element wheeldown', () => { this.picker.scroll(1, true); this.screen.render() })
    this.picker.on('element wheelup', () => { this.picker.scroll(-1, true); this.screen.render() })

    this.picker.on('select', (_item, index) => this.pickChat(index))
    // The click lands on the item (a child of the list) and arrives as 'element click', after blessed has already moved the selection.
    this.picker.on('element click', () => this.pickChat((this.picker as unknown as { selected: number }).selected))

    this.tabsBar.on('click', (data: { x: number; y: number }) => {
      const x = data.x - num(this.tabsBar.aleft)
      const seg = this.segments.find(s => x >= s.x0 && x < s.x1)
      uiLog.info({ x, seg }, 'tab bar click')
      if (!seg) return
      if (x >= seg.closeX0 && x < seg.closeX1) return this.closeTab(seg.index)
      this.activateTab(seg.index)
    })
    // Clicking a message selects it (and opens the attachment if the click lands on one); outside messages it
    // returns focus to the input. Dragging a message's name and time line to the right (press and release on
    // that line, 4 or more columns ahead) starts a reply to it, like on WhatsApp mobile; dragging over any other
    // line selects text (below).
    // While the button is held the message's lines slide right with the pointer, like WhatsApp Web; letting go
    // 4 or more columns to the right starts the reply, less snaps back. In SGR the motion reports carry bit 32 of
    // the button byte, which blessed hands over as repeated 'mousedown's: the raw byte tells them apart.
    // `header`: the message's name or time line, where a drag replies and the "☺" sits; on the line where the time
    // follows the text, only outside the text's own columns, which select text instead.
    const lineAt = (y: number, x = -1) => {
      const line = this.msgBox.childBase + (y - num(this.msgBox.atop) - num(this.msgBox.itop))
      const orig = this.msgBox._clines?.rtof?.[line]
      if (orig == null) return null
      const cols = this.textLines.get(orig), col = x - num(this.msgBox.aleft) - num(this.msgBox.ileft)
      const onText = cols != null && col >= cols.start && col < cols.end
      return { row: this.lineMap[orig] ?? null, header: this.headerLines.has(orig) && !onText }
    }
    const rowAt = (y: number) => lineAt(y)?.row ?? null
    let pressed: { x: number; y: number; row: MessageRow | null; header: boolean } | undefined
    this.msgBox.on('mouse', (data: { action: string; x: number; y: number; raw?: number[] }) => {
      const motion = !!((data.raw?.[0] ?? 0) & 32)
      if (data.action === 'mousedown' && !motion) { const l = lineAt(data.y, data.x); pressed = { x: data.x, y: data.y, row: l?.row ?? null, header: !!l?.header }; return }
      if (!motion || !pressed?.row || !pressed.header) return
      const dx = pressed.y === data.y ? Math.max(0, Math.min(8, data.x - pressed.x)) : 0
      if (this.drag?.id === pressed.row.id && this.drag.dx === dx) return
      this.drag = { id: pressed.row.id, dx }
      this.dirtyMessages = true
      this.renderNow()
    })
    // A double click (two clicks on the same message within 400 ms) also starts the reply, undoing the selection
    // the first click made.
    let lastClick: { y: number; at: number; id: string } | undefined
    this.msgBox.on('click', (data: { x: number; y: number }) => {
      const row = rowAt(data.y)
      const dragged = pressed?.header && pressed.y === data.y && data.x - pressed.x >= 4
      pressed = undefined
      if (this.drag) { this.drag = undefined; this.dirtyMessages = true }
      if (this.textSelected()) return
      // The "☺" opens the quick reactions of the hovered message; one of them reacts, "⋯" goes to the keyboard
      // flow; any other click closes the bar and does nothing else, like on WhatsApp Web.
      const hit = this.quickHit
      if (hit?.icon != null && data.y === hit.y && Math.abs(data.x - hit.icon) <= 1 && this.hover) { this.quickFor = this.hover; return this.renderNow() }
      if (this.quickFor) {
        const target = this.quickFor
        const item = hit && data.y === hit.y ? hit.items?.find(i => data.x >= i.x && data.x < i.x + i.w) : undefined
        this.quickFor = undefined
        if (item?.emoji === '⋯') { this.reactTo = target; this.replyTo = null; this.setFocus('input'); this.drawInput() }
        else if (item) void this.react(target, item.emoji, true)
        return this.renderNow()
      }
      // A click on a link copies it, whole, instead of selecting the message.
      if (!dragged) { const url = this.linkAt(data.x, data.y); if (url) return this.copyToClipboard(url) }
      const now = Date.now()
      const double = !!row && lastClick?.id === row.id && now - lastClick.at < 400
      lastClick = row ? { y: data.y, at: now, id: row.id } : undefined
      if (row && (dragged || double)) {
        if (double) this.select(null)
        this.replyTo = row; this.reactTo = null
        this.setFocus('input')
        this.drawInput()
        return this.renderNow()
      }
      if (row) this.select(row)
      else this.setFocus('input')
      if (row?.media_mime) this.openMedia(row)
      this.renderNow()
    })
    this.msgBox.on('scroll', () => { this.updateAtBottom(); if (this.textSel) { this.textSel = undefined; this.screen.render() } })
    // Clicking the input places the cursor at the clicked position (or at the end of the line, if the click lands past the text).
    this.input.on('click', (data: { x: number; y: number }) => {
      if (this.textSelected()) return
      if (!this.pickerOpen) this.setFocus('input')
      {
        const x = data.x - num(this.input.aleft) - num(this.input.ileft) - 2
        const row = this.inputTop + data.y - num(this.input.atop) - num(this.input.itop) - (this.inputHeader ? 1 : 0)
        let pos = 0
        for (let r = 0; r < Math.min(row, this.inputLines.length); r++) pos += this.inputLines[r]!.length
        const line = this.inputLines[row]
        if (line) {
          let col = 0
          for (const ch of line) { const w = visibleWidth(esc(ch)); if (col + w / 2 > x) break; col += w; pos++ }
        }
        if (this.pickerOpen) this.filterCursor = pos
        else this.cursor = pos
        this.drawInput()
      }
      this.screen.render()
    })
    // Text selection, like in a terminal: pressing on text (any line of the messages but a name and time one, or
    // the input) and dragging highlights the cells swept, in reading order, within that panel; letting go copies
    // the text to the clipboard (OSC 52) and leaves it highlighted until the next click or key. The screen gets the
    // events after the panels, so the panels' click handlers already see the selection and stay out of its way.
    const inside = (box: blessed.Widgets.BoxElement, x: number, y: number) => {
      const xi = num(box.aleft) + num(box.ileft), xl = num(box.aleft) + num(box.width) - (num(box.iwidth) - num(box.ileft))
      const yi = num(box.atop) + num(box.itop), yl = num(box.atop) + num(box.height) - (num(box.iheight) - num(box.itop))
      return x >= xi && x < xl && y >= yi && y < yl ? { xi, xl, yi, yl } : null
    }
    let selPress: { x: number; y: number; xi: number; xl: number; yi: number; yl: number; input: boolean } | undefined
    this.screen.on('mouse', (d: { action: string; x: number; y: number; raw?: number[] }) => {
      if (d.action === 'mousemove') {
        const row = !this.pickerOpen && inside(this.msgBox, d.x, d.y) ? lineAt(d.y)?.row ?? undefined : undefined
        // A redraw when the message under the pointer changes, and along the line with the "☺" or the reactions,
        // where the one under the pointer is highlighted.
        const onBar = (y: number) => this.quickHit != null && y === this.quickHit.y
        const changed = row?.id !== this.hover?.id || onBar(d.y) || (this.pointer != null && onBar(this.pointer.y))
        this.pointer = { x: d.x, y: d.y }
        this.hover = row
        if (changed) this.screen.render()
        return
      }
      const motion = !!((d.raw?.[0] ?? 0) & 32)
      if (d.action === 'mousedown' && !motion) {
        if (this.textSel) { this.textSel = undefined; this.screen.render() }
        const box = (this.pickerOpen || lineAt(d.y, d.x)?.header ? null : inside(this.msgBox, d.x, d.y)) ?? inside(this.input, d.x, d.y)
        selPress = box ? { x: d.x, y: d.y, ...box, input: !inside(this.msgBox, d.x, d.y) } : undefined
        return
      }
      if (motion && selPress) {
        const { xi, xl, yi, yl } = selPress
        const hx = Math.max(xi, Math.min(xl - 1, d.x)), hy = Math.max(yi, Math.min(yl - 1, d.y))
        if (this.textSel?.hx === hx && this.textSel.hy === hy) return
        this.textSel = { ax: selPress.x, ay: selPress.y, hx, hy, xi, xl, input: selPress.input }
        return this.screen.render()
      }
      if (d.action === 'mouseup' && selPress) {
        selPress = undefined
        if (!this.textSel) return
        if (!this.textSelected()) { this.textSel = undefined; return this.screen.render() }
        this.copyTextSel()
      }
    })

    this.yap.on('connection', (state, detail) => this.onConnection(state, detail))
    this.yap.on('chats', () => { this.dirtyTabs = true; if (this.pickerOpen) this.refreshPicker(); this.scheduleRender() })
    this.yap.on('typing', (jid, who) => this.onTyping(jid, who.length > 0))
    this.yap.on('messages', jid => { if (jid === '*' || jid === this.current) this.dirtyMessages = true; this.dirtyTabs = true; this.scheduleRender() })
    this.yap.on('notify', (jid, row) => {
      if (jid === this.current) {
        this.yap.markRead(jid).catch(e => logger.warn({ e }, 'markRead'))
        if (row.type === 'text' && reaction(row.text)) this.heartFor(r => r.id === row.id, row.text)
        return
      }
      // In Herdr the new chat opens in one of its tabs, in the background, by the same rule as a new tab: only the
      // most recently used terminal, and never if it's already open in another. Until the new tab registers, the
      // request is remembered.
      if (this.fixed) {
        if (inHerdr && !this.openElsewhere(jid) && this.isMostRecentTerminal() && !this.spawning.has(jid)) {
          this.spawning.add(jid)
          setTimeout(() => this.spawning.delete(jid), 15000)
          openChatHerdr(jid, chatName(jid), false).catch(e => logger.warn({ e }, 'herdr: open tab'))
        }
        return
      }
      if (this.tabs.includes(jid)) { this.screen.program.bell(); this.notify(jid, row.text || `[${row.type}]`); return }
      // Chat without a tab: with several terminals, only the most recently used one opens the tab, and never if the
      // chat already has a tab in another live terminal.
      if (this.openElsewhere(jid) || !this.isMostRecentTerminal()) return
      this.openTab(jid, false)
      this.screen.program.bell()
      this.notify(jid, row.text || `[${row.type}]`)
    })
    this.yap.on('status', text => this.flash(text))
    // A reaction, mine or someone else's, animates from the spot where it appears in the message.
    this.yap.on('reaction', (jid, msgId, _sender, emoji) => { if (jid === this.current && reaction(emoji)) this.heartFor(r => r.id === msgId, emoji) })
  }

  /** Logs to yap.log everything that arrives from the terminal and what the UI does with it. */
  private bindDiagnostics() {
    const program = this.screen.program as unknown as { input: NodeJS.ReadStream }
    program.input.on('data', (b: Buffer) => {
      // Only escape sequences (mouse, special keys), never the typed text.
      if (b[0] === 0x1b) uiLog.info({ raw: JSON.stringify(b.toString('latin1')) }, 'bytes')
    })
    this.screen.on('mouse', (d: { action: string; button?: string; x: number; y: number; shift?: boolean; ctrl?: boolean }) => {
      this.touchActivity()
      // Pointer movement with no button, when the terminal reports it, is one event per cell: not logged.
      if (d.action !== 'mousemove') uiLog.info({ action: d.action, button: d.button, x: d.x, y: d.y, shift: d.shift, ctrl: d.ctrl }, 'mouse')
    })
    const named: [string, blessed.Widgets.BlessedElement][] = [['tabs', this.tabsBar], ['messages', this.msgBox], ['input', this.input], ['picker', this.picker]]
    for (const [name, w] of named) {
      ;(w as unknown as { on: (ev: string, fn: (el: blessed.Widgets.BlessedElement, d: { action: string; x: number; y: number }) => void) => void })
        .on('element mouse', (el, d) => { if (d.action !== 'mousemove') uiLog.info({ panel: name, child: el !== w ? el.type : undefined, action: d.action, x: d.x, y: d.y }, 'mouse in panel') })
    }
    this.screen.on('keypress', (_ch: string, key: blessed.Widgets.Events.IKeyEventArg) => uiLog.info({ key: key.full, focus: this.focus }, 'key'))
    uiLog.info({ modes: `mouse 1000+1002${this.anyMotion ? '+1003' : ''}+1006`, term: process.env.TERM, program: process.env.TERM_PROGRAM, cols: this.screen.width, rows: this.screen.height }, 'startup')
  }

  private onConnection(state: ConnState, detail?: string) {
    if (state === 'qr' && this.yap.qr) {
      QRCode.toString(this.yap.qr, { type: 'terminal', small: true }, (err, qr) => {
        if (err) { logger.error({ err }, 'qr'); return }
        this.showingQr = true
        this.msgBox.setContent(['', `  {bold}${esc(t('qrTitle'))}{/bold}`, '', `  ${esc(t('qrHint'))}`, '', qr].join('\n'))
        this.lineMap = []; this.images = []; this.rows = []; this.selected = null
        this.screen.render()
      })
      this.connText = `{${FG.warn}-fg}● ${esc(t('waitingQr'))}{/${FG.warn}-fg}`
    } else if (state === 'open') {
      this.connText = ''
      this.showingQr = false
      this.dirtyMessages = true
      for (const jid of this.tabs) this.yap.subscribePresence(jid)
      if (Date.now() - this.lastActive < 120000) { this.lastPresenceTouch = Date.now(); this.yap.touchPresence() }
      this.scheduleRender()
    } else if (state === 'closed') {
      this.connText = `{${FG.error}-fg}● ${esc(detail ?? t('disconnected'))}{/${FG.error}-fg}`
    } else {
      this.connText = `{${FG.warn}-fg}● ${esc(t('connecting'))}{/${FG.warn}-fg}`
    }
    this.drawStatus()
    this.screen.render()
  }

  /** Someone started or stopped typing: the rainbow runs across the tab's name and, once they stop, fades out. */
  private onTyping(jid: string, active: boolean) {
    if (active) this.typing.set(jid, null)
    else if (this.typing.has(jid)) this.typing.set(jid, Date.now())
    if (this.typing.size && !this.typingTimer) {
      this.typingTimer = setInterval(() => {
        for (const [j, stopped] of this.typing) if (stopped != null && Date.now() - stopped > FADE_MS) this.typing.delete(j)
        if (!this.typing.size && this.typingTimer) { clearInterval(this.typingTimer); this.typingTimer = undefined }
        this.drawTabs(); this.screen.render()
      }, 40)
    }
    this.drawTabs()
    this.updateTitle()
    this.screen.render()
  }

  /**
   * The name with the rainbow: the ring of hues runs across the letters (one full turn in ~3 s, at 25 frames per
   * second), and once the person stops, each color blends into the text color over FADE_MS, with a smooth curve,
   * until it's back to normal.
   */
  private rainbow(name: string, stopped: number | null): string {
    const n = this.ring.length
    const phase = (Date.now() / 1000) * (n / 3)
    const raw = stopped == null ? 0 : Math.min(1, (Date.now() - stopped) / FADE_MS)
    const t = raw * raw * (3 - 2 * raw)
    return graphemes(name).map((g, i) => {
      const c = nearest256(mix(this.ring[Math.floor(phase + i * 1.5) % n]!, this.fgRgb, t))
      return `{${c}-fg}${esc(g)}{/${c}-fg}`
    }).join('')
  }

  /** Pasted text goes in whole where the cursor is; in the input it keeps the lines, in the picker filter it collapses to one. */
  private paste(text: string) {
    if (this.focus === 'picker') {
      const chars = graphemes(this.filter), at = Math.min(this.filterCursor, chars.length)
      const ins = graphemes(text.replace(/\n/g, ' '))
      this.filter = [...chars.slice(0, at), ...ins, ...chars.slice(at)].join(''); this.filterCursor = at + ins.length
      this.refreshPicker()
      return this.screen.render()
    }
    if (this.focus !== 'input' || !text) return
    const chars = graphemes(this.inputValue), at = Math.min(this.cursor, chars.length)
    const ins = graphemes(text)
    this.inputValue = [...chars.slice(0, at), ...ins, ...chars.slice(at)].join(''); this.cursor = at + ins.length
    this.accepted = undefined
    this.promoteActive()
    this.noteComposing()
    this.updateSuggestions()
    this.drawInput()
    this.screen.render()
  }

  private onKey(ch: string, key: blessed.Widgets.Events.IKeyEventArg) {
    this.touchActivity()
    if (this.textSel) { this.textSel = undefined; this.screen.render() }
    const k = key.full
    if (k !== 'right') this.acceptOnArrival = 0
    // blessed emits each Enter twice: a synthetic "enter" and right after the real "return". Only the second counts;
    // otherwise, with suggestions open, the first would accept the emoji and the second would send the message.
    if (key.name === 'enter' && key.sequence === '\r') return
    if (k === 'C-c') return this.quit()
    if (k === 'paste') return this.paste(ch)
    // ESC closes, in order: the reply or reaction in progress, the selection, the picker filter, the picker, the
    // active tab, the program.
    if (k === 'escape') {
      if (this.quickFor) { this.quickFor = undefined; return this.screen.render() }
      if (this.suggestions.length) { this.suggestions = []; this.drawSuggestions(); return this.screen.render() }
      if (this.replyTo || this.reactTo) { this.replyTo = this.reactTo = null; this.drawInput(); return this.screen.render() }
      if (this.editing) { this.editing = null; this.inputValue = ''; this.cursor = 0; this.updateSuggestions(); this.drawInput(); return this.screen.render() }
      if (this.focus === 'messages') { this.setFocus('input'); return this.renderNow() }
      if (this.pickerOpen) {
        if (this.filter) { this.filter = ''; this.filterCursor = 0; this.refreshPicker(); return this.screen.render() }
        // With no tabs there's nowhere to go back to: the picker is the only panel, and closing it means quitting.
        return this.tabs.length ? this.closePicker() : this.quit()
      }
      if (this.current) return this.closeTab(this.active)
      return this.quit()
    }
    if (k === 'pageup') { this.msgBox.scroll(-(this.innerHeight() - 1)); return this.screen.render() }
    if (k === 'pagedown') { this.msgBox.scroll(this.innerHeight() - 1); return this.screen.render() }
    // Tab cycles through the open tabs; with the picker open it goes back to the active tab. New chats open with "/".
    // With text in the input, Tab accepts the suggestion in view: the emoji list, or the model's; with no text, it
    // switches tabs. The right arrow, with the cursor already at the end, does the same as Tab; mid-text it keeps
    // moving the cursor.
    if ((k === 'tab' || (k === 'right' && this.cursorAtEnd() && (this.suggestions.length || this.ghostShown()))) && this.focus === 'input' && !this.pickerOpen && this.inputValue) {
      if (this.suggestions.length) return this.acceptSuggestion()
      if (this.ghostShown()) this.acceptGhost()
      return
    }
    // → at the end, with no suggestion in view but one requested: the acceptance is flagged for when it arrives.
    if (k === 'right' && this.focus === 'input' && !this.pickerOpen && this.inputValue && this.cursorAtEnd() && (this.ghostTimer || this.ghostAbort)) {
      this.acceptOnArrival++
      return
    }
    if (k === 'tab') {
      if (!this.tabs.length) return
      return this.activateTab(this.pickerOpen ? this.active : (this.active + 1) % this.tabs.length)
    }

    if (this.focus === 'picker') {
      // Typing with the picker open filters the chats; arrows and Enter belong to the list.
      const e = edit(this.filter, this.filterCursor, k, ch, key)
      if (!e) return
      this.filterCursor = e.cursor
      if (e.value !== this.filter) { this.filter = e.value; this.refreshPicker() }
      else this.drawInput()
      return this.screen.render()
    }
    if (this.focus === 'input') {
      // "/" with the input empty opens the chat list right away; whatever's typed next filters the list.
      if (ch === '/' && !this.inputValue) return this.openPicker()
      // Shift+Enter (only with the Kitty protocol, which distinguishes it) or Ctrl+J start a new line in the message.
      if (k === 'S-return' || k === 'linefeed') return this.paste('\n')
      // With emoji suggestions open, ↑/↓ choose and Enter or Tab accept; everything else keeps typing and refines them.
      if (this.suggestions.length) {
        if (k === 'up' || k === 'down') {
          this.suggestIndex = (this.suggestIndex + (k === 'up' ? -1 : 1) + this.suggestions.length) % this.suggestions.length
          this.drawSuggestions()
          return this.screen.render()
        }
        if (k === 'enter' || k === 'return') return this.acceptSuggestion()
      }
      if (k === 'enter' || k === 'return') { const v = this.inputValue; this.inputValue = ''; this.cursor = 0; this.stopComposing(); this.updateSuggestions(); this.drawInput(); this.screen.render(); return void this.submit(v) }
      // Right after accepting a suggestion that ended mid-word, a letter or digit starts a new word: it goes in
      // with a space before it. Space and punctuation follow directly.
      if (this.accepted === this.inputValue && this.cursorAtEnd() && ch && /^[\p{L}\p{N}]$/u.test(ch) && !key.ctrl && !key.meta) {
        this.inputValue += ' '
        this.cursor++
      }
      const e = edit(this.inputValue, this.cursor, k, ch, key)
      if (!e) { if (k === 'up') this.moveSelection(-1); return }
      // Only the text changing spends the promised space; moving the cursor (→ at the end, with no suggestion) leaves it unspent.
      if (e.value !== this.inputValue) { this.accepted = undefined; this.promoteActive() }
      this.inputValue = e.value
      this.cursor = e.cursor
      this.noteComposing()
      this.updateSuggestions()
      this.drawInput()
      return this.screen.render()
    }
    if (this.focus === 'messages') {
      if (k === 'up' || k === 'down') return this.moveSelection(k === 'up' ? -1 : 1)
      // → over the selected message replies to it. It's also what Termius sends on a right swipe: a burst of
      // arrows, with no position; the following ones land on the empty input and do nothing.
      if (k === 'right' && this.selected) {
        this.replyTo = this.selected; this.reactTo = null
        this.setFocus('input')
        this.drawInput()
        return this.screen.render()
      }
      // Delete or Backspace over my own text message opens it in the input to correct it; Enter sends the edit,
      // Esc gives up.
      if ((k === 'delete' || k === 'backspace') && this.selected) return this.editMessage(this.selected)
      // Typing over the selected message starts a reply right away, with what was typed; ":" starts a reaction, and
      // stays typed so it can continue with the emoji's :code:. The input's header says which message.
      if (this.selected && ch && !key.ctrl && !key.meta && ch >= ' ' && ch !== '\x7f') {
        if (ch === ':') { this.reactTo = this.selected; this.replyTo = null } else { this.replyTo = this.selected; this.reactTo = null }
        this.inputValue = ch
        this.cursor = 1
        this.promoteActive()
        this.setFocus('input')
        return this.renderNow()
      }
    }
  }

  // ---------- text selection ----------

  /** Whether the mouse selection covers more than the cell it started on. */
  private textSelected(): boolean {
    const s = this.textSel
    return !!s && (s.ax !== s.hx || s.ay !== s.hy)
  }

  /** The selection's first and last cells, in reading order. */
  private textSelRange(): { x0: number; y0: number; x1: number; y1: number } | null {
    const s = this.textSel
    if (!s) return null
    const back = s.hy < s.ay || (s.hy === s.ay && s.hx < s.ax)
    return back ? { x0: s.hx, y0: s.hy, x1: s.ax, y1: s.ay } : { x0: s.ax, y0: s.ay, x1: s.hx, y1: s.hy }
  }

  /**
   * The cells of screen row `y` the selection takes, or nothing: only written text counts, never the name and
   * time, day separators, quotes, reactions or media notes. In the messages that's the rows showing a message's
   * own text; in the input, every row but the reply, reaction or edit header, from after the prompt.
   */
  private selCells(y: number): { from: number; to: number } | null {
    const s = this.textSel, r = this.textSelRange()
    if (!s || !r) return null
    let from = s.xi, to = s.xl - 1
    if (s.input) {
      if (this.inputHeader && y === num(this.input.atop) + num(this.input.itop)) return null
      from += 2
    } else {
      const real = this.msgBox.childBase + (y - num(this.msgBox.atop) - num(this.msgBox.itop))
      const orig = this.msgBox._clines?.rtof?.[real]
      const cols = orig != null ? this.textLines.get(orig) : undefined
      if (!cols) return null
      from = s.xi + cols.start; to = s.xi + cols.end - 1
    }
    if (y === r.y0) from = Math.max(from, r.x0)
    if (y === r.y1) to = Math.min(to, r.x1)
    return from <= to ? { from, to } : null
  }

  /** Inverts the selected cells in the screen buffer, right before blessed writes it out. */
  private drawTextSel() {
    const r = this.textSelRange()
    if (!r) return
    const lines = (this.screen as unknown as { lines: ([number, string][] & { dirty?: boolean })[] }).lines
    for (let y = r.y0; y <= r.y1; y++) {
      const line = lines[y], cells = this.selCells(y)
      if (!line || !cells) continue
      for (let x = cells.from; x <= cells.to; x++) {
        const cell = line[x]
        if (cell) cell[0] ^= 8 << 18
      }
      line.dirty = true
    }
  }

  /** Copies the selected cells' text to the clipboard, one line per screen row, without the spaces around each. */
  private copyTextSel() {
    const r = this.textSelRange()
    if (!r) return
    const lines = (this.screen as unknown as { lines: [number, string][][] }).lines
    const out: string[] = []
    for (let y = r.y0; y <= r.y1; y++) {
      const cells = this.selCells(y)
      if (!cells) continue
      let text = ''
      for (let x = cells.from; x <= cells.to; x++) {
        const ch = lines[y]?.[x]?.[1]
        // The cell after a wide character holds blessed's marker, not text.
        if (ch && ch !== '\x03') text += ch
      }
      out.push(text.trim())
    }
    if (out.length) this.copyToClipboard(out.join('\n'))
  }

  /** Puts `text` in the terminal's clipboard (OSC 52) and says so in the status. */
  private copyToClipboard(text: string) {
    ;(this.screen.program as unknown as { _write: (s: string) => void })._write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x1b\\`)
    this.flash(t('copied'))
  }

  /**
   * The URL under screen cell (`x`, `y`), whole, if the cell is on a message's text and the run of non-blank
   * cells around it is part of one of the message's URLs; a URL wrapped over two lines is found from either piece.
   */
  private linkAt(x: number, y: number): string | null {
    const real = this.msgBox.childBase + (y - num(this.msgBox.atop) - num(this.msgBox.itop))
    const orig = this.msgBox._clines?.rtof?.[real]
    const cols = orig != null ? this.textLines.get(orig) : undefined
    const row = orig != null ? this.lineMap[orig] : null
    if (!cols || !row?.text) return null
    const xi = num(this.msgBox.aleft) + num(this.msgBox.ileft)
    const line = (this.screen as unknown as { lines: [number, string][][] }).lines[y]
    if (!line) return null
    const ch = (cx: number) => { const c = line[cx]?.[1]; return c && c !== '\x03' && c !== ' ' ? c : '' }
    if (x < xi + cols.start || x >= xi + cols.end || !ch(x)) return null
    let a = x, b = x
    while (a - 1 >= xi + cols.start && (ch(a - 1) || line[a - 1]?.[1] === '\x03')) a--
    while (b + 1 < xi + cols.end && (ch(b + 1) || line[b + 1]?.[1] === '\x03')) b++
    let run = ''
    for (let cx = a; cx <= b; cx++) run += ch(cx)
    // Punctuation stuck to the link ("(https://…)") is in the run but not in the URL, and vice versa.
    return urlsIn(row.text).find(u => u.includes(run) || run.includes(u)) ?? null
  }

  // ---------- reactions ----------

  /** Sends `emoji` as my reaction to `row` (empty removes it); the same emoji again, from the mouse, removes it too. */
  private async react(row: MessageRow, emoji: string, toggle = false) {
    if (this.yap.state !== 'open') return this.flash(t('noConnection'))
    const mine = store.listReactions(row.chat_jid).find(r => r.msg_id === row.id && r.sender_jid === this.yap.me)
    const send = toggle && mine?.emoji === emoji ? '' : emoji
    try {
      await this.yap.react(row.chat_jid, row.id, send)
      if (!send) this.flash(t('reactionRemoved'))
    } catch (e) {
      logger.error({ e }, 'react')
      this.flash(`${t('error')}: ${(e as Error).message}`, 10000)
    }
  }

  /**
   * Over the hovered message's name line: a gray "☺" to its right (to its left in mine, which sit flush right),
   * or, once clicked, the quick reactions in its place. Drawn straight into the screen buffer, so the panel isn't
   * rebuilt at every pointer move; where it landed is kept for the click.
   */
  private drawQuick() {
    this.quickHit = undefined
    const row = this.quickFor ?? this.hover
    if (!row || this.showingQr) return
    let idx = -1
    for (let i = 0; i < this.lineMap.length; i++) if (this.lineMap[i]?.id === row.id && this.headerLines.has(i)) { idx = i; break }
    if (idx < 0) return
    const real = this.msgBox._clines.ftor[idx]?.[0]
    if (real == null) return
    const y = real - this.msgBox.childBase
    if (y < 0 || y >= this.innerHeight()) return
    const sy = num(this.msgBox.atop) + num(this.msgBox.itop) + y
    const xi = num(this.msgBox.aleft) + num(this.msgBox.ileft), xl = xi + num(this.msgBox.width) - num(this.msgBox.iwidth)
    const line = (this.screen as unknown as { lines: ([number, string][] & { dirty?: boolean })[] }).lines[sy]
    if (!line) return
    const mine = row.from_me === 1
    const blank = (x: number) => { const ch = line[x]?.[1]; return ch === ' ' || ch === '' }
    // Where the name line's text starts (mine) or ends (others).
    let edge = mine ? xi : xl - 1
    if (mine) while (edge < xl && blank(edge)) edge++
    else while (edge >= xi && blank(edge)) edge--
    // The pointer over an item's click area (its cells and one on each side) makes it stand out: the "☺" goes
    // from gray to bold in the text color, a reaction gets the selected message's background over the whole area.
    const over = (x: number, w: number) => this.pointer != null && this.pointer.y === sy && this.pointer.x >= x - 1 && this.pointer.x <= x + w
    const put = (x: number, ch: string, w: number, hot: boolean) => {
      for (let i = hot && w > 1 ? -1 : 0; i < (hot && w > 1 ? w + 1 : w); i++) {
        const cell = line[x + i]
        if (!cell) continue
        // The cell's own background (the selected message's, say) stays; the text goes gray.
        if (w > 1) cell[0] = hot ? (cell[0] & ~0x1ff) | this.selectedBg : cell[0]
        else cell[0] = hot ? (cell[0] & ~(0x1ff << 9)) | (0x1ff << 9) | (1 << 18) : (cell[0] & ~(0x1ff << 9)) | (244 << 9)
        if (i >= 0) cell[1] = i ? ' ' : ch
      }
    }
    // Two cells between the reactions: each one's click area is its own cells plus one on each side, so a click
    // that lands next to the emoji still counts, and no cell belongs to two of them.
    const items = this.quickFor ? QUICK.map(emoji => ({ emoji, w: emoji === '⋯' ? 1 : 2 })) : [{ emoji: '☺', w: 1 }]
    const gap = this.quickFor ? 2 : 1
    const total = items.reduce((n, i) => n + i.w, 0) + (items.length - 1) * gap
    let x = mine ? edge - 2 - total : edge + 2
    x = Math.max(xi, Math.min(xl - total, x))
    const hit: { y: number; icon?: number; items?: { x: number; w: number; emoji: string }[] } = { y: sy }
    if (this.quickFor) hit.items = []
    for (const item of items) {
      put(x, item.emoji, item.w, over(x, item.w))
      if (hit.items) hit.items.push({ x: x - 1, w: item.w + 2, emoji: item.emoji }); else hit.icon = x
      x += item.w + gap
    }
    line.dirty = true
    this.quickHit = hit
  }

  // ---------- message selection ----------

  private select(row: MessageRow | null) {
    this.selected = row
    this.dirtyMessages = true
    if (row) { if (this.focus !== 'messages') this.setFocus('messages') }
    else if (this.focus === 'messages') this.setFocus('input')
  }

  /** Moves the selection to the previous (-1) or next (+1) message; with no selection, ↑ picks the last one; ↓ from the last one goes back to the input. */
  private moveSelection(dir: -1 | 1) {
    if (!this.current || !this.rows.length) return
    const i = this.selected ? this.rows.findIndex(r => r.id === this.selected!.id) : this.rows.length
    const next = i + dir
    this.select(next >= this.rows.length ? null : this.rows[Math.max(0, next)]!)
    this.renderNow()
    if (this.selected) this.scrollToSelected()
    this.screen.render()
  }

  /** Scrolls the panel just enough for the selected message to become fully visible. */
  private scrollToSelected() {
    const id = this.selected?.id
    const first = this.lineMap.findIndex(r => r?.id === id)
    if (first < 0) return
    let last = first
    while (last + 1 < this.lineMap.length && this.lineMap[last + 1]?.id === id) last++
    const ftor = this.msgBox._clines?.ftor
    const top = ftor?.[first]?.[0], bottom = ftor?.[last]?.at(-1)
    if (top == null || bottom == null) return
    const base = this.msgBox.childBase, h = this.innerHeight()
    if (top < base) this.msgBox.scrollTo(top)
    else if (bottom >= base + h) this.msgBox.scrollTo(bottom - h + 1)
  }

  /** Puts one of my own text messages in the input, to correct and resend it as an edit. */
  private editMessage(row: MessageRow) {
    if (!row.from_me || row.type !== 'text') return this.flash(t('onlyOwnText'))
    this.editing = row
    this.replyTo = this.reactTo = null
    this.setFocus('input')
    this.inputValue = row.text.replace(/\n\((editada|edited)\)$/, '')
    this.cursor = graphemes(this.inputValue).length
    this.updateSuggestions()
    this.drawInput()
    this.renderNow()
  }

  private who(row: MessageRow): string {
    return row.from_me ? t('me') : row.chat_jid.endsWith('@g.us') ? contactName(row.sender_jid) : chatName(row.chat_jid)
  }

  private snippet(row: MessageRow): string {
    return row.text.split('\n')[0] || `[${row.type}]`
  }

  private async submit(v: string) {
    const text = emojify(v.trim())
    // Reaction in progress: what was typed is the emoji (empty removes the reaction), and it goes to the chosen message.
    const reactTo = this.reactTo
    if (reactTo) {
      this.reactTo = null
      this.drawInput()
      this.screen.render()
      // The ":" the reaction starts with, alone, counts the same as nothing: it removes the reaction.
      return this.react(reactTo, text === ':' ? '' : text)
    }
    // Edit in progress: the text replaces the open message's; empty sends nothing and the edit stays open.
    const editing = this.editing
    if (editing) {
      if (!text) { this.drawInput(); return this.screen.render() }
      this.editing = null
      this.drawInput()
      this.screen.render()
      if (this.yap.state !== 'open') return this.flash(t('noConnection'))
      try {
        await this.yap.edit(editing.chat_jid, editing.id, text)
      } catch (e) {
        logger.error({ e }, 'edit')
        this.flash(`${t('error')}: ${(e as Error).message}`, 10000)
      }
      return
    }
    if (!text) return
    if (text.startsWith('/')) return this.openPicker(text.slice(1).trim())
    if (!this.current) return this.flash(t('openFirst'))
    if (this.yap.state !== 'open') return this.flash(t('noConnection'))
    const jid = this.current
    // On sending, the panel jumps to the bottom to show the new message, even if it was looking at history.
    this.atBottom = true
    try {
      if (text.startsWith(':')) return this.flash(`${t('unknownCommand')}: ${text.split(' ')[0]}. ${HELP}`, 10000)
      const replyTo = this.replyTo?.chat_jid === jid ? this.replyTo : null
      this.replyTo = null
      this.drawInput()
      this.screen.render()
      await this.yap.send(jid, text, replyTo?.id)
      // My own message only appears once the server echoes it back; the most recent one of mine with the heart is then searched for.
      if (reaction(text)) this.heartFor(r => r.from_me === 1 && r.text === text && Date.now() - r.ts * 1000 < 30000, text)
    } catch (e) {
      logger.error({ e }, 'submit')
      this.flash(`${t('error')}: ${(e as Error).message}`, 10000)
    }
  }

  // ---------- tabs ----------

  /**
   * Each terminal has its own tabs, stored in `state` under the terminal's device (/dev/pts/N). The record also
   * carries the pid and the time of the last interaction: that's how the various processes know, from the database
   * alone, which tabs are open in other live terminals and which terminal was used most recently.
   */
  /** This terminal's record in the database: it only serves to coordinate terminals open at the same time. */
  private tabsKey(): string {
    return `tabs:pid${process.pid}`
  }

  private lastActive = Date.now()
  private lastActiveSaved = 0
  private lastPresenceTouch = 0
  /** The chat we told "typing" to, when we told it, and the deadline to say we stopped. */
  private composingJid: string | null = null
  private composingSentAt = 0
  private composingTimer: NodeJS.Timeout | undefined

  /** Always starts with no tabs (nothing is restored from previous runs) and clears the records of terminals already dead. */
  private registerTerminal() {
    for (const r of store.listState<TerminalState>('tabs:')) if (!r.value.pid || !pidAlive(r.value.pid)) store.deleteState(r.key)
    this.saveTabs()
  }

  private saveTabs() {
    this.lastActiveSaved = this.lastActive
    store.setState(this.tabsKey(), { tabs: this.tabs, active: this.active, pid: process.pid, lastActive: this.lastActive, herdrTab: process.env.HERDR_TAB_ID } satisfies TerminalState)
  }

  /**
   * The input changed: the active chat gets told we're typing, repeated every 5 seconds while we keep going, and
   * that we stopped after 5 seconds idle, on sending, on clearing everything, or on switching tabs.
   */
  private noteComposing() {
    const jid = this.current
    if (!jid || !this.inputValue || this.pickerOpen) return this.stopComposing()
    const now = Date.now()
    if (jid !== this.composingJid || now - this.composingSentAt > 5000) {
      if (this.composingJid && jid !== this.composingJid) this.yap.setComposing(this.composingJid, false)
      this.yap.setComposing(jid, true)
      this.composingJid = jid
      this.composingSentAt = now
    }
    if (this.composingTimer) clearTimeout(this.composingTimer)
    this.composingTimer = setTimeout(() => this.stopComposing(), 5000)
  }

  private stopComposing() {
    if (this.composingTimer) { clearTimeout(this.composingTimer); this.composingTimer = undefined }
    if (!this.composingJid) return
    this.yap.setComposing(this.composingJid, false)
    this.composingJid = null
  }

  /** Marks this terminal as the most recently used; saves at most every two seconds. */
  private touchActivity() {
    this.lastActive = Date.now()
    if (this.lastActive - this.lastActiveSaved > 2000) this.saveTabs()
    // Keeps the device "available" while the terminal is in use; every 10 seconds is enough.
    if (this.lastActive - this.lastPresenceTouch > 10000) { this.lastPresenceTouch = this.lastActive; this.yap.touchPresence() }
  }

  /** Records of the other terminals whose process is still alive. */
  private otherTerminals(): TerminalState[] {
    const mine = this.tabsKey()
    return store.listState<TerminalState>('tabs:').filter(r => r.key !== mine && r.value.pid && pidAlive(r.value.pid)).map(r => r.value)
  }

  private openElsewhere(jid: string): boolean {
    return this.otherTerminals().some(t => t.tabs.includes(jid))
  }

  private isMostRecentTerminal(): boolean {
    return this.otherTerminals().every(t => (t.lastActive ?? 0) <= this.lastActive)
  }

  /** Opens (or finds) the chat's tab; with `activate` it becomes the active one and the chat is marked as read. */
  private openTab(jid: string, activate = true) {
    let i = this.tabs.indexOf(jid)
    if (i < 0) { this.tabs.push(jid); i = this.tabs.length - 1 }
    uiLog.info({ jid, index: i, activate }, 'open tab')
    this.dirtyTabs = true
    if (activate) this.activateTab(i)
    else { this.saveTabs(); this.scheduleRender() }
  }

  /** Activates the tab without touching the bar's order; it's typing that brings it to the front (promoteActive). */
  private activateTab(i: number) {
    const jid = this.tabs[i]
    if (!jid) return
    if (i !== this.active) {
      this.stopComposing()
      const prev = this.current
      this.active = i; this.atBottom = true; this.dirtyMessages = true; this.selected = this.replyTo = this.reactTo = null; this.quickFor = undefined
      // A message correction isn't a draft: it's dropped. Everything else stays saved in the chat being left.
      if (this.editing) { this.editing = null; this.inputValue = ''; this.cursor = 0 }
      this.switchDraft(prev, jid)
    }
    if (this.notice?.jid === jid) this.notice = undefined
    this.dirtyTabs = true
    this.saveTabs()
    this.yap.subscribePresence(jid)
    if (this.pickerOpen) this.closePicker(false)
    this.setFocus('input')
    this.renderNow()
    this.yap.markRead(jid).catch(e => logger.warn({ e }, 'markRead'))
  }

  /** Moves the active tab to the first position, next to the input, when typing starts in it. */
  private promoteActive() {
    if (this.active <= 0 || !this.tabs[this.active]) return
    const [jid] = this.tabs.splice(this.active, 1)
    this.tabs.unshift(jid!)
    this.active = 0
    this.dirtyTabs = true
    this.saveTabs()
    this.drawTabs()
  }

  /** Saves the input as a draft of the chat being left and puts the draft of the chat being entered on the line. */
  private switchDraft(from: string | null, to: string | null) {
    if (from) {
      if (this.inputValue) this.drafts.set(from, { value: this.inputValue, cursor: this.cursor })
      else this.drafts.delete(from)
    }
    const d = to ? this.drafts.get(to) : undefined
    this.inputValue = d?.value ?? ''
    this.cursor = d?.cursor ?? 0
    this.updateSuggestions()
  }

  /** Closes the tab; if it was the active one, moves to the one on the right, or the one on the left, or to "chats". */
  private closeTab(i: number) {
    const closing = this.tabs[i]
    if (!closing) return
    uiLog.info({ jid: closing, index: i }, 'close tab')
    const wasActive = this.active === i
    this.tabs.splice(i, 1)
    if (this.active > i) this.active--
    else if (wasActive) { this.active = Math.min(i, this.tabs.length - 1); this.atBottom = true }
    // The draft goes with the tab; if it was the active one, the input becomes that of the remaining chat.
    this.drafts.delete(closing)
    if (wasActive) { this.editing = null; this.switchDraft(null, this.current) }
    this.dirtyTabs = true
    this.dirtyMessages = true
    this.lineMap = []; this.images = []; this.rows = []; this.selected = null
    this.saveTabs()
    // Closing the last tab means quitting: there's no going back to the picker.
    if (!this.tabs.length) return this.quit()
    this.renderNow()
    const jid = this.current
    if (jid) this.yap.markRead(jid).catch(e => logger.warn({ e }, 'markRead'))
  }

  private drawTabs() {
    const width = num(this.tabsBar.width)
    const maxName = width
    // In single-chat mode there's no tab to show: the line is left with just the status on the right.
    const tabs = this.fixed ? [] : this.tabs.map((jid, i) => {
      const unread = store.getChat(jid)?.unread ?? 0
      return { jid, i, name: chatName(jid), badge: unread > 0 ? `(${unread})` : '' }
    })
    // Shorten the names so they all fit, down to a minimum of 6 characters; beyond that the bar truncates on the right.
    const close = this.fixed ? '' : ' ×'
    const overhead = (t: { badge: string }) => 1 + (t.badge ? strWidth(t.badge) + 1 : 0) + strWidth(close) + 1
    let nameW = Math.max(...tabs.map(t => strWidth(t.name)), 0)
    const fits = (w: number) => tabs.reduce((sum, t) => sum + Math.min(strWidth(t.name), w) + overhead(t), 0) <= maxName
    while (nameW > 6 && !fits(nameW)) nameW--
    // The active tab stands out only through its text: bold and in the theme's strongest color; the others stay in the normal color.
    const strong = this.dark ? 'bright-white' : 'black'
    let out = '', x = 0
    this.segments = []
    for (const t of tabs) {
      const name = truncate(t.name, nameW)
      const label = this.typing.has(t.jid) ? this.rainbow(name, this.typing.get(t.jid)!) : esc(name)
      const text = ` ${name}${t.badge ? ' ' + t.badge : ''}${close} `
      const w = strWidth(text)
      const closeX0 = close ? x + w - 2 : x + w
      this.segments.push({ x0: x, x1: x + w, index: t.i, closeX0, closeX1: close ? closeX0 + 1 : closeX0 })
      const badge = t.badge ? ` {${FG.badge}-fg}{bold}${t.badge}{/bold}{/${FG.badge}-fg}` : ''
      const closeMark = close ? ` ${dim('×')}` : ''
      out += t.i === this.active && !this.pickerOpen
        ? `{${strong}-fg}{bold} ${label}{/bold}{/${strong}-fg}${badge}${closeMark} `
        : `{${FG.tab}-fg} ${label}{/${FG.tab}-fg}${badge}${closeMark} `
      x += w
    }
    // Status flush right: the transient message (yellow) or the connection; truncated if it doesn't fit.
    // Connected isn't announced: only transient notices and states that need attention (QR, connection dropped).
    const avail = width - x - 2
    let text = this.transient ? dim(esc(truncate(this.transient, avail))) : this.connText
    if (this.fixed) {
      // With no tab for the rainbow to run across, "typing…" runs here while the other person is typing.
      const jid = this.current
      const typing = !text && !!jid && this.typing.has(jid)
      if (typing) text = this.rainbow(t('typing'), this.typing.get(jid)!)
      if (!text) return this.toast.hide()
      const w = Math.min(width, visibleWidth(text) + 2)
      // Status sticks to the top right, where the tab bar would carry it; "typing…" stays on the left, on the line above the input.
      this.toast.left = typing ? 0 : width - w; this.toast.width = w
      this.toast.top = typing ? `100%-${this.bottom + 1}` : 0
      this.toast.setContent(` ${text} `)
      return this.toast.show()
    }
    if (avail >= 6 && text) out += ' '.repeat(Math.max(1, width - x - visibleWidth(text) - 1)) + text
    this.tabsBar.setContent(out)
    this.drawNotice(width)
  }

  /**
   * Lays the notice over the chat's tab (or flush right if the tab isn't in view), without its name and without a
   * background: the text emerges from the background up to a tone a bit below normal text, stays, then merges back
   * into the background. The color at each instant is the background→text blend at the moment's opacity, quantized
   * to 256 colors.
   */
  private drawNotice(width: number) {
    const n = this.notice
    if (!n) return this.toast.hide()
    const text = truncate(n.text, Math.max(1, width - 2))
    const w = strWidth(text) + 2
    const seg = this.segments.find(s => this.tabs[s.index] === n.jid)
    const left = Math.max(0, Math.min(seg && seg.x0 < width ? seg.x0 : width, width - w))
    this.toast.left = left
    this.toast.width = Math.min(w, width)
    const c = nearest256(mix(this.bgRgb, this.fgRgb, 0.85 * this.noticeOpacity(n.since)))
    this.toast.setContent(`{${c}-fg} ${esc(text)} {/${c}-fg}`)
    this.toast.show()
  }

  /** Notice opacity (0..1) since it started: rises, holds, falls; smooth curve at both ends. */
  private noticeOpacity(since: number): number {
    const t = Date.now() - since
    const ease = (x: number) => x * x * (3 - 2 * x)
    if (t < NOTICE.fadeIn) return ease(t / NOTICE.fadeIn)
    if (t < NOTICE.fadeIn + NOTICE.hold) return 1
    return ease(Math.max(0, 1 - (t - NOTICE.fadeIn - NOTICE.hold) / NOTICE.fadeOut))
  }

  private notify(jid: string, text: string) {
    // A notice on top of another already visible one doesn't fade in again: it stays opaque with the new text.
    const since = this.notice && this.noticeOpacity(this.notice.since) >= 1 ? Date.now() - NOTICE.fadeIn : Date.now()
    this.notice = { jid, text, since }
    if (!this.noticeTimer) {
      this.noticeTimer = setInterval(() => {
        if (this.notice && Date.now() - this.notice.since >= NOTICE.fadeIn + NOTICE.hold + NOTICE.fadeOut) this.notice = undefined
        if (!this.notice && this.noticeTimer) { clearInterval(this.noticeTimer); this.noticeTimer = undefined }
        this.drawStatus(); this.screen.render()
      }, 40)
    }
    this.drawStatus()
    this.screen.render()
  }

  // ---------- picker ----------

  private openPicker(filter = '') {
    this.filter = filter
    this.filterCursor = graphemes(filter).length
    this.pickerOpen = true
    this.dirtyTabs = true
    this.picker.show()
    this.msgBox.hide()
    this.refreshPicker()
    this.setFocus('picker')
    this.renderNow()
  }

  private closePicker(render = true) {
    this.pickerOpen = false
    this.dirtyTabs = true
    this.filter = ''
    this.picker.hide()
    this.msgBox.show()
    this.setFocus('input')
    if (render) this.renderNow()
  }

  private findChat(text: string): string | null {
    if (store.getChat(text)) return text
    const f = fold(text)
    return store.listChats().find(c => fold(chatName(c.jid)).includes(f) || jidUser(c.jid).includes(f))?.jid ?? null
  }

  private pickChat(index: number) {
    const jid = this.filtered[index]?.jid
    uiLog.info({ index, jid }, 'pick chat')
    if (!jid) return
    // In Herdr each chat is one of its tabs: the chosen one opens in a new tab, or switches to the tab where it already is.
    if (inHerdr && jid !== this.current) {
      this.closePicker()
      const other = this.otherTerminals().find(t => t.herdrTab && t.tabs.includes(jid))
      if (other?.herdrTab) focusTabHerdr(other.herdrTab)
      else openChatHerdr(jid, chatName(jid)).catch(e => logger.warn({ e }, 'herdr: open tab'))
      return
    }
    // In single-chat mode the picker switches the chat instead of adding a tab; the previous one's draft stays saved.
    const prev = this.fixed ? this.current : null
    this.openTab(jid)
    if (prev && prev !== jid) {
      this.tabs = [jid]; this.active = 0
      this.dirtyTabs = true
      this.saveTabs()
      this.renderNow()
    }
  }

  private refreshPicker() {
    // Keep the selection on the same chat: WhatsApp events redraw the list all the time and used to reset it to the top.
    const selectedJid = this.filtered[(this.picker as unknown as { selected: number }).selected]?.jid
    const sameFilter = this.pickerFilterShown === this.filter
    this.pickerFilterShown = this.filter
    // Most recent at the bottom, like the messages; the default selection is the last one (the most recent).
    this.chats = store.listChats().filter(c => !c.archived).reverse()
    const f = fold(this.filter)
    this.filtered = f ? this.chats.filter(c => fold(chatName(c.jid)).includes(f) || jidUser(c.jid).includes(f)) : this.chats
    const width = num(this.picker.width) - num(this.picker.iwidth) - 1
    // Person or group name on the left and a snippet of the last message on the right, like in a chat list.
    const nameW = Math.min(28, Math.max(12, Math.floor(width * 0.35)))
    const items = this.filtered.map(c => {
      const badge = c.unread > 0 ? ` (${c.unread})` : ''
      const open = this.tabs.includes(c.jid) ? ' ·' : ''
      const name = truncate(chatName(c.jid), nameW - strWidth(badge) - strWidth(open) - 1)
      const left = `${c.unread > 0 ? `{bold}${esc(name)}{/bold}{red-fg}${badge}{/red-fg}` : esc(name)}${open}`
      const last = store.lastMessage(c.jid)
      let preview = ''
      if (last) {
        const who = last.from_me ? `${t('me')}: ` : c.is_group ? `${contactName(last.sender_jid).split(' ')[0]}: ` : ''
        const kind: Record<string, string> = { image: t('image'), video: t('video'), gif: t('gif'), sticker: t('sticker'), document: t('file'), audio: t('audio'), voice: t('voice'), location: t('location'), contact: t('contact'), poll: t('poll') }
        const body = last.type === 'text' ? last.text.replace(/\s+/g, ' ') : last.type === 'deleted' ? t('deleted') : `[${kind[last.type] ?? last.type}]${last.text ? ' ' + last.text.replace(/\s+/g, ' ') : ''}`
        preview = truncate(`${fmtTime(last.ts)} ${who}${body}`, width - nameW - 2)
      }
      return `${left}${' '.repeat(Math.max(1, nameW - visibleWidth(left)))}${dim(esc(preview))}`
    })
    this.picker.setItems(items as unknown as string[])
    // List flush to the bottom when it's shorter than the panel, with a blank line separating it from the prompt.
    const panel = num(this.screen.height) - this.bottom - this.barRows - 1
    const gap = Math.max(0, panel - this.filtered.length)
    this.picker.top = this.barRows + gap
    this.picker.height = panel - gap
    const keep = sameFilter ? this.filtered.findIndex(c => c.jid === selectedJid) : -1
    this.picker.select(keep >= 0 ? keep : Math.max(0, this.filtered.length - 1))
    this.drawInput()
  }

  // ---------- state ----------

  private setFocus(f: Focus) {
    uiLog.info({ from: this.focus, to: f }, 'focus')
    this.focus = f
    if (f !== 'messages' && this.selected) { this.selected = null; this.dirtyMessages = true }
    if (f !== 'input' && this.suggestions.length) { this.suggestions = []; this.drawSuggestions() }
    const w = f === 'picker' ? this.picker : f === 'messages' ? this.msgBox : this.input
    w.focus()
    this.drawInput()
    this.drawStatus()
  }

  private flash(text: string, ms = 6000) {
    this.transient = text
    if (this.transientTimer) clearTimeout(this.transientTimer)
    this.transientTimer = setTimeout(() => { this.transient = ''; this.drawStatus(); this.screen.render() }, ms)
    this.drawStatus()
    this.screen.render()
  }

  private scheduleRender() {
    if (this.renderTimer) return
    this.renderTimer = setTimeout(() => { this.renderTimer = undefined; this.renderNow() }, 40)
  }

  private renderNow() {
    if (this.dirtyTabs) { this.dirtyTabs = false; this.drawTabs(); this.updateTitle() }
    if (this.dirtyMessages && !this.showingQr) { this.dirtyMessages = false; if (this.current) this.renderMessages() }
    // With no tabs (startup with nothing saved, or chats arriving for the first time) the most recent chat opens;
    // the picker only appears with "/".
    if (!this.current && !this.pickerOpen && !this.showingQr) {
      const recent = store.listChats().find(c => !c.archived)
      if (recent) return this.openTab(recent.jid)
    }
    this.screen.render()
  }

  // Window title: the active chat, with a dot in front while there are unread messages in any chat.
  private titleShown = ''
  private updateTitle() {
    const unread = store.listChats().filter(c => c.unread > 0 && (this.fixed ? c.jid === this.current : !c.archived))
    const title = `${unread.length ? '● ' : ''}${this.current ? chatName(this.current) : 'yap'}`
    if (title !== this.titleShown) { this.titleShown = title; this.screen.title = title; titleHerdr(title) }
    // In Herdr the same signal goes to the agent's status: someone typing is work in progress, unread asks for attention.
    const typing = [...this.typing].filter(([jid, stopped]) => stopped == null && (!this.fixed || jid === this.current)).map(([jid]) => chatName(jid))
    if (typing.length) reportHerdr('working', t('typingWho', typing.join(', ')))
    else if (unread.length) reportHerdr('blocked', unread.map(c => `${chatName(c.jid)} (${c.unread})`).join(', '))
    else reportHerdr('idle')
  }

  quit(reason?: string) {
    this.kitty?.dispose()
    this.disableKittyKeyboard?.()
    this.disablePaste()
    const released = releaseHerdr()
    this.screen.destroy()
    if (reason) process.stderr.write(`${reason}\n`)
    this.yap.stop().catch(() => {})
    store.deleteState(this.tabsKey())
    store.close()
    void released.then(() => process.exit(0))
  }

  private innerHeight(): number {
    return num(this.msgBox.height) - num(this.msgBox.iheight)
  }

  private updateAtBottom() {
    const total = this.msgBox._clines?.length ?? 0
    this.atBottom = this.msgBox.childBase + this.innerHeight() >= total
  }

  // ---------- drawing ----------

  private drawStatus() {
    this.dirtyTabs = true
    this.drawTabs()
    this.dirtyTabs = false
  }

  // ---------- emoji suggestions ----------

  /** A `:prefix` with two or more letters right before the cursor opens the list of emojis whose name starts that way. */
  private updateSuggestions(ghostDelay = 150) {
    const chars = graphemes(this.inputValue)
    const at = Math.min(this.cursor, chars.length)
    const m = /(^|[^\w:]):([a-z0-9_+-]{2,})$/i.exec(chars.slice(0, at).join(''))
    const options = m ? completeEmoji(m[2]!).slice(0, 5) : []
    const same = options.length === this.suggestions.length && options.every((o, i) => o.emoji === this.suggestions[i]!.emoji)
    this.suggestions = options
    if (!same) this.suggestIndex = 0
    if (m) this.suggestStart = at - graphemes(`:${m[2]}`).length
    this.drawSuggestions()
    this.scheduleGhost(ghostDelay)
  }

  // ---------- local model suggestions ----------

  private cursorAtEnd(): boolean {
    return this.cursor >= graphemes(this.inputValue).length
  }

  /** The stored suggestion still applies to what's typed and the cursor is at the end: it's the one shown and accepted. */
  private ghostShown(): Suggestion | null {
    const g = this.ghost
    return g && g.text === this.inputValue && !this.pickerOpen && this.cursorAtEnd() ? g.s : null
  }

  /**
   * Asks the model for a suggestion for the current text, `delay` ms after the last keystroke (150 while typing; 0
   * right after accepting one, which is when it's idle waiting for the next one), and only with the cursor at the
   * end, with no reaction in progress nor emoji suggestions open. A new request cancels the previous one; the
   * response is only used if the text is still the same when it arrives, and it stays in view for 10 s.
   */
  private scheduleGhost(delay = 150) {
    if (this.ghost && this.ghost.text !== this.inputValue) this.clearGhost()
    if (this.ghostTimer) { clearTimeout(this.ghostTimer); this.ghostTimer = undefined }
    this.ghostAbort?.abort()
    this.ghostAbort = undefined
    const jid = this.current
    if (!llmEnabled || !jid || this.focus !== 'input' || this.pickerOpen || this.reactTo || this.suggestions.length) return
    if (!this.cursorAtEnd() || this.inputValue.trim().length < 3 || this.ghost?.text === this.inputValue) return
    const text = this.inputValue
    this.ghostTimer = setTimeout(() => {
      this.ghostTimer = undefined
      if (text !== this.inputValue) return
      const abort = new AbortController()
      this.ghostAbort = abort
      const context = store.listMessages(jid, 6).filter(r => r.text && r.type !== 'deleted').map(r => ({ who: this.who(r), text: r.text }))
      suggest(context, text, abort.signal).then(s => {
        if (abort.signal.aborted || text !== this.inputValue) return
        if (this.ghostAbort === abort) this.ghostAbort = undefined
        if (!s) { this.acceptOnArrival = 0; return }
        this.ghost = { text, s }
        if (this.acceptOnArrival > 0) { this.acceptOnArrival--; return void this.acceptGhost() }
        if (this.ghostHide) clearTimeout(this.ghostHide)
        this.ghostHide = setTimeout(() => { if (this.ghost?.text === text) { this.clearGhost(); this.drawInput(); this.screen.render() } }, 10000)
        this.drawInput()
        this.screen.render()
      }, e => { this.acceptOnArrival = 0; if (!abort.signal.aborted) logger.debug({ e }, 'llm') })
    }, delay)
  }

  private clearGhost() {
    this.ghost = undefined
    this.ghostBox.hide()
    if (this.ghostHide) { clearTimeout(this.ghostHide); this.ghostHide = undefined }
  }

  /** What's shown: the word mid-typing (the missing letters, or the correct word) takes priority over a correction behind it. */
  private ghostView(s: Suggestion): { kind: 'suffix' | 'word' | 'fix'; text: string } | null {
    if (s.word) {
      const { from, to } = s.word
      if (to.toLowerCase().startsWith(from.toLowerCase()) && to.length > from.length) return { kind: 'suffix', text: to.slice(from.length) }
      return { kind: 'word', text: to }
    }
    return s.fix ? { kind: 'fix', text: s.fix.to } : null
  }

  private acceptGhost() {
    const s = this.ghostShown()
    const v = s && this.ghostView(s)
    if (!s || !v) return
    if (v.kind === 'fix') {
      const { start, end, to } = s.fix!
      this.inputValue = this.inputValue.slice(0, start) + to + this.inputValue.slice(end)
    } else {
      this.inputValue = this.inputValue.slice(0, this.inputValue.length - s.word!.from.length) + s.word!.to
    }
    this.cursor = graphemes(this.inputValue).length
    this.accepted = /[\p{L}\p{M}\p{N}'-]$/u.test(this.inputValue) ? this.inputValue : undefined
    this.clearGhost()
    this.promoteActive()
    this.updateSuggestions(0)
    this.drawInput()
    this.screen.render()
  }

  private drawSuggestions() {
    if (!this.suggestions.length) { this.suggest.hide(); return }
    const lines = this.suggestions.map((o, i) => i === this.suggestIndex
      ? `{bold}› ${esc(o.emoji)}  :${esc(o.name)}:{/bold}`
      : `  ${esc(o.emoji)}  :${esc(o.name)}:`)
    // One column of margin on the right, which also serves as padding: blessed wraps the line if a closing tag lands on the last column.
    this.suggest.width = Math.max(...lines.map(visibleWidth)) + 2
    this.suggest.height = lines.length
    this.suggest.top = `100%-${this.bottom + lines.length}`
    this.suggest.setContent(lines.join('\n'))
    this.suggest.show()
  }

  /** The `:prefix` gives way to the chosen emoji, followed by a space. */
  private acceptSuggestion() {
    const o = this.suggestions[this.suggestIndex]!
    const chars = graphemes(this.inputValue)
    const at = Math.min(this.cursor, chars.length)
    const before = [...chars.slice(0, this.suggestStart), o.emoji, ' ']
    this.inputValue = before.join('') + chars.slice(at).join('')
    this.cursor = before.length
    this.suggestions = []
    this.drawSuggestions()
    this.drawInput()
    return this.screen.render()
  }

  private drawInput() {
    // One line at minimum (grows with the text), ">" prompt on the first, text wrapped by word (never mid-word) and indented continuation.
    // When the text has more lines than fit, the ones around the cursor are shown, with the cursor on the bottom one whenever possible. With
    // "chats" open, the same line is used to type the filter. When replying or reacting, the first
    // line says which message, leaving one for the text.
    const w = num(this.input.width) - num(this.input.iwidth) - 1
    const target = this.pickerOpen ? null : this.replyTo ?? this.reactTo ?? this.editing
    const header = !target ? null : this.editing
      ? t('editHeader', this.snippet(target))
      : this.replyTo
        ? `↩ ${target.chat_jid.endsWith('@g.us') && !target.from_me ? `${this.who(target)}: ` : ''}${this.snippet(target)}`
        : t('reactHeader', this.who(target), this.snippet(target))
    // Model suggestion, discreet, in gray italic: the letters missing from the word mid-typing, attached to the cursor
    // (which sits on the first one); a correction, whether of the mid-typed word or of a wrong word further back,
    // floating on the line above the word, starting on its column. Tab accepts.
    const ghost = this.ghostShown()
    const view = ghost ? this.ghostView(ghost) : null
    this.inputHeader = header != null
    const width = Math.max(4, w - 2)
    const chars = graphemes(this.pickerOpen ? this.filter : this.inputValue)
    const cursor = Math.min(this.pickerOpen ? this.filterCursor : this.cursor, chars.length)
    const lines = wrapChars(chars, width)
    // Cursor's line and column: at the end of the text it sits after the last grapheme, and moves to a new line if it doesn't fit.
    let row = 0, start = 0
    while (row < lines.length - 1 && cursor >= start + lines[row]!.length) start += lines[row++]!.length
    let col = cursor - start
    if (col >= lines[row]!.length && wrapWidth(esc(lines[row]!.join(''))) >= width) { lines.push([]); row++; col = 0 }
    // The "\n" or the space that closes a line stay in it, so the cursor counts them, but aren't drawn: one space
    // past the width would make blessed wrap the line. A trailing space that fits is drawn, so the cursor advances with it.
    const text = (l: string[]) => { const t = l.filter(c => c !== '\n').join(''); return strWidth(t) > width ? t.replace(/\s+$/, '') : t }
    // The missing letters go right at the cursor when they fit on its line. Any other suggestion is the whole word
    // as it should be, after "⇢" (the hint that → or Tab accepts), floating right above the word it replaces, the
    // word on the word's column and the arrow two cells to its left (pulled left when it would run past the edge).
    const cursorLine = lines[row]!
    const avail = width - visibleWidth(esc(text(cursorLine))) - 1
    let ghostNext = '', ghostAbove = '', ghostLine = -1, ghostCol = 0
    if (view && col >= cursorLine.length) {
      if (view.kind === 'suffix' && strWidth(view.text) <= avail + 1) ghostNext = view.text
      else {
        const word = view.kind === 'fix' ? ghost!.fix!.to : ghost!.word!.to
        const startUnit = view.kind === 'fix' ? ghost!.fix!.start : this.inputValue.length - ghost!.word!.from.length
        let at = graphemes(this.inputValue.slice(0, startUnit)).length, wl = 0
        while (wl < lines.length - 1 && at >= lines[wl]!.length) at -= lines[wl++]!.length
        ghostAbove = truncate(`⇢ ${word}`, width)
        ghostLine = wl
        ghostCol = Math.max(0, Math.min(strWidth(lines[wl]!.slice(0, at).join('')) - 2, width - strWidth(ghostAbove)))
      }
    }
    // The input grows with the text, up to half the screen; the header (reply, react, edit) takes up one of the lines.
    const extra = header ? 1 : 0
    const rows = Math.max(1, Math.min(lines.length + extra, Math.floor(num(this.screen.height) / 2)))
    if (rows !== this.inputRows) this.resizeInput(rows)
    const rowsAvail = Math.max(1, rows - extra)
    this.inputLines = lines
    this.inputTop = Math.max(0, Math.min(row - (rowsAvail - 1), lines.length - rowsAvail))
    const showCursor = this.focus === 'input' || this.focus === 'picker'
    const render = (line: string[], r: number) => {
      if (!showCursor || r !== row) return esc(text(line))
      const before = esc(text(line.slice(0, col)))
      if (ghostNext) {
        // The cursor sits on the suggestion's first letter, with no empty cell in between; the rest follows in italic.
        const g = graphemes(ghostNext)
        return before + dim(italic('{inverse}' + esc(g[0]!) + '{/inverse}' + esc(g.slice(1).join(''))))
      }
      const under = line[col] == null || line[col] === '\n' ? ' ' : line[col]!
      return before + '{inverse}' + esc(under) + '{/inverse}' + esc(text(line.slice(col + 1)))
    }
    const visible = lines.slice(this.inputTop, this.inputTop + rowsAvail)
    // The prompt says what the line does: ">" types, "/" filters the chats.
    const prompt = this.pickerOpen ? '/ ' : '> '
    const out = visible.map((l, i) => (this.inputTop + i === 0 ? prompt : '  ') + render(l, this.inputTop + i))
    if (header) out.unshift(dim(esc(truncate(header, w))))
    this.input.setContent(out.join('\n'))
    // The correction floats one line above its word's line, when that line is in view: the input starts `rows` from
    // the bottom, the header (if any) takes its first row, the prompt its first two columns, after the padding.
    if (ghostAbove && ghostLine >= this.inputTop && ghostLine < this.inputTop + rowsAvail) {
      this.ghostBox.top = num(this.screen.height) - rows + extra + (ghostLine - this.inputTop) - 1
      this.ghostBox.left = num(this.input.ileft) + 1 + ghostCol
      this.ghostBox.width = strWidth(ghostAbove) + 1
      this.ghostBox.setContent(dim(italic(esc(ghostAbove))))
      this.ghostBox.show()
    } else this.ghostBox.hide()
  }

  /**
   * Launches the animated emoji from its place in the message `pick` identifies. The position is looked up at draw
   * time, once the message (or its reactions line) is already in the panel: its last line in `lineMap`, converted
   * to the real line by blessed's map and to the screen by the scroll; the column is the emoji's in that line,
   * without the color codes. No emoji on the line yet drawn: nothing is returned and the animation asks again.
   */
  private heartFor(pick: (r: MessageRow) => boolean, text: string) {
    const emoji = reaction(text)
    if (!emoji) return
    this.hearts.launch(emoji, () => {
      let idx = -1
      for (let i = this.lineMap.length - 1; i >= 0; i--) { const r = this.lineMap[i]; if (r && pick(r)) { idx = i; break } }
      if (idx < 0) return null
      const real = this.msgBox._clines.ftor[idx]?.[0]
      if (real == null) return null
      const y = real - this.msgBox.childBase
      if (y < 0 || y >= this.innerHeight()) return null
      const line = (this.msgBox._clines[real] ?? '').replace(/\x1b\[[\d;]*m/g, '')
      // The emoji as shown, or the text as received (a smiley like "<3" that stands for it).
      const at = [emoji, text.trim()].map(s => line.indexOf(s)).find(i => i >= 0)
      if (at == null) return null
      return { x: num(this.msgBox.aleft) + num(this.msgBox.ileft) + strWidth(line.slice(0, at)), y: num(this.msgBox.atop) + num(this.msgBox.itop) + y }
    })
  }

  /** Changes the input's height and shifts whatever depends on it: messages, floating bar, suggestions, and picker. */
  private resizeInput(rows: number) {
    this.inputRows = rows
    this.input.height = rows
    this.input.top = `100%-${this.bottom}`
    this.msgBox.height = `100%-${this.bottom + this.barRows}`
    this.picker.height = `100%-${this.bottom + this.barRows + 1}`
    this.dirtyMessages = true
    this.dirtyTabs = true
    if (this.suggestions.length) this.drawSuggestions()
    if (this.pickerOpen) this.refreshPicker()
    this.scheduleRender()
  }

  private imagePathFor(row: MessageRow): string | null {
    const file = mediaFile(row)
    if (file && /^image\//.test(row.media_mime ?? '') && fs.existsSync(file)) return file
    const t = thumbPath(row.chat_jid, row.id)
    return fs.existsSync(t) ? t : null
  }

  private renderMessages() {
    const jid = this.current
    if (!jid) return
    const isGroup = jid.endsWith('@g.us')
    const width = num(this.msgBox.width) - num(this.msgBox.iwidth)
    const lines: string[] = []
    const map: (MessageRow | null)[] = []
    const images: ImageSlot[] = []
    const selectedId = this.selected?.id
    // The selected message gets the background at full width, whoever it's from: the lines arrive here already
    // wrapped to the panel's width, and get padded with spaces up to the edge.
    const decorate = (line: string, row: MessageRow | null) => {
      if (row && row.id === this.drag?.id && this.drag.dx) line = clipTagged(' '.repeat(this.drag.dx) + line, width - 1)
      if (row && row.id === selectedId) line = `{${this.selectedBg}-bg}${line}${' '.repeat(padding(line, width - 1))}{/${this.selectedBg}-bg}`
      return line
    }
    const push = (line: string, row: MessageRow | null) => {
      lines.push(decorate(line, row))
      map.push(row)
    }
    const reactions = new Map<string, ReactionRow[]>()
    for (const r of store.listReactions(jid)) reactions.set(r.msg_id, [...(reactions.get(r.msg_id) ?? []), r])
    const rows = store.listMessages(jid)
    this.rows = rows
    this.selected = rows.find(r => r.id === selectedId) ?? null
    const headers = new Set<number>(), texts = new Map<number, { start: number; end: number }>()
    // The text under the highlight is about to change.
    this.textSel = undefined
    let lastDay = ''

    for (const row of rows) {
      const day = dayKey(row.ts)
      if (day !== lastDay) {
        lastDay = day
        const label = `── ${fmtDay(row.ts)} ──`
        push(dim(`${' '.repeat(Math.max(0, Math.floor((width - strWidth(label)) / 2)))}${label}`), null)
      }
      // My own messages stay flush right: I wrap the lines myself (blessed only wraps from the left) and push each
      // one to the edge; other people's stay on the left, wrapped the same way.
      const mine = row.from_me === 1
      // The ticks always take two cells, so the time sits in the same column whatever the message's state.
      const ticks = !mine ? '' : (row.status ?? 0) >= 4 ? '{cyan-fg}✓✓{/cyan-fg}' : (row.status ?? 0) >= 3 ? '✓✓' : (row.status ?? 0) >= 2 ? '✓ ' : `${dim('○')} `
      const stamp = mine ? `${faint(fmtTime(row.ts))} ${ticks}` : faint(fmtTime(row.ts))
      // One column of margin on the right: blessed wraps the line if a closing tag lands on the last column. Mine
      // stop short of the columns the time and ticks take, with two cells of gap, so no line of theirs (text,
      // quote, reactions) runs into them; the line that carries the time is the only one reaching the edge.
      const textWidth = mine ? Math.max(1, width - 1 - 2 - visibleWidth(stamp)) : width - 1
      // The last line `out` wrote for this message, as given, so the time can be appended to it afterwards.
      let last: { at: number; line: string } | null = null
      const out = (line: string, r: MessageRow | null) => {
        for (const l of wrapTagged(line, textWidth)) { last = { at: map.length, line: l }; push(mine ? alignRight(l, textWidth) : l, r) }
      }
      // No names: mine are on the right, the other side's on the left, both in the default color. Only in groups
      // does the sender's name open the message, in their color. The time closes it (below), so the text lines of
      // consecutive messages read straight down; mine carries the ticks after it. Both lines are the message's
      // "header" for the drag-to-reply and the "☺".
      const header = (line: string) => { const at = map.length; out(line, row); for (let i = at; i < map.length; i++) headers.add(i) }
      if (isGroup && !mine) header(`{${colorFor(row.sender_jid)}-fg}${esc(contactName(row.sender_jid))}{/${colorFor(row.sender_jid)}-fg}`)
      if (row.quoted) {
        const [who, text] = row.quoted.split('\t')
        // Who it was from only matters in groups; one-on-one the other person is obvious, and mine don't carry a name either.
        const author = who === this.yap.me || !row.chat_jid.endsWith('@g.us') ? '' : `${esc(contactName(who ?? ''))}: `
        out(dim(`│ ${author}${esc(truncate(text ?? '', width - 6))}`), row)
      }

      const type = row.type
      const mediaHint = row.media_path ? dim(t('clickToOpen')) : row.media_err ? dim(t('unavailable')) : dim(t('clickToDownload'))
      if (type === 'deleted') out(dim(`⊘ ${t('deleted')}`), row)
      else if (type === 'image' || type === 'sticker' || type === 'gif' || type === 'video') {
        this.pushImage(row, push, images, lines, width, mine)
        last = null
        if (type === 'video' || type === 'gif') out(`{magenta-fg}▶ ${type === 'gif' ? t('gif') : t('video')}{/magenta-fg} ${mediaHint}`, row)
      } else if (type === 'document') {
        out(`{yellow-fg}📎 ${esc(row.media_name ?? t('file'))}{/yellow-fg} ${mediaHint}`, row)
      } else if (type === 'audio' || type === 'voice') {
        out(`{yellow-fg}${type === 'voice' ? '🎤' : '🎵'} ${type === 'voice' ? t('voiceMessage') : t('audio')} ${esc(row.text)}{/yellow-fg} ${row.media_path ? dim(t('clickToListen')) : mediaHint}`, row)
      } else if (type === 'location') out(`{yellow-fg}📍 ${waMarkup(row.text)}{/yellow-fg}`, row)
      else if (type === 'contact') out(`{yellow-fg}👤 ${esc(row.text)}{/yellow-fg}`, row)
      else if (type === 'poll') for (const l of row.text.split('\n')) out(`{yellow-fg}${esc(l)}{/yellow-fg}`, row)
      else if (type !== 'text') out(dim(esc(row.text || `[${type}]`)), row)

      // The time goes at the end of the message's last line, like in a WhatsApp bubble, when it fits there with
      // two cells of gap: the last text line, or, with no text, the note that stands for it (deleted, audio, file…),
      // never an image. Otherwise it gets its own line.
      let stamped = false
      if (row.text && (type === 'text' || type === 'image' || type === 'video' || type === 'gif' || type === 'document')) {
        const wrapped = waMarkup(row.text).split('\n').flatMap(l => wrapTagged(l, textWidth))
        wrapped.forEach((l, i) => {
          const tw = visibleWidth(l)
          const withStamp = i === wrapped.length - 1 && tw + 2 + visibleWidth(stamp) <= width - 1
          const line = withStamp ? `${l}  ${stamp}` : l
          const edge = withStamp ? width - 1 : textWidth
          const at = map.length
          push(mine ? alignRight(line, edge) : line, row)
          const start = mine ? padding(line, edge) : 0
          texts.set(at, { start, end: start + tw })
          if (withStamp) { headers.add(at); stamped = true }
        })
      }
      const note = last as { at: number; line: string } | null
      if (!stamped && note && visibleWidth(note.line) + 2 + visibleWidth(stamp) <= width - 1) {
        const line = `${note.line}  ${stamp}`
        lines[note.at] = decorate(mine ? alignRight(line, width - 1) : line, row)
        headers.add(note.at); stamped = true
      }
      // On its own line the time goes straight in, not through the wrapping, which would drop the space that
      // keeps a single tick in the first tick's column.
      if (!stamped) { const at = map.length; push(mine ? alignRight(stamp, width - 1) : stamp, row); headers.add(at) }
      // Reactions underneath: each emoji with who reacted, or just the count when there were several.
      const rs = reactions.get(row.id)
      if (rs?.length) {
        const byEmoji = new Map<string, string[]>()
        // Only the first name, to keep the line short.
        for (const r of rs) byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r.sender_jid === this.yap.me ? t('me') : contactName(r.sender_jid).split(' ')[0]!])
        const parts = [...byEmoji].map(([emoji, who]) => `${emoji} ${who.length > 1 ? who.length : who[0]}`)
        out(dim(esc(parts.join('  '))), row)
      }
      push('', null)
    }

    this.lineMap = map
    this.headerLines = headers
    this.textLines = texts
    this.images = images
    this.msgBox.setContent(lines.join('\n'))
    if (this.atBottom) this.msgBox.setScrollPerc(100)
  }

  /**
   * Reserves the image's space and draws it if already decoded. The download and decoding only happen once the
   * image becomes visible in the panel (loadVisibleImages), never for all 300 messages at once.
   */
  private pushImage(row: MessageRow, push: (l: string, r: MessageRow | null) => void, images: ImageSlot[], lines: string[], width: number, mine = false) {
    if (this.mode === 'none') { push(dim(`[${row.type}]`), row); return }
    if (row.media_err && !this.imagePathFor(row)) { push(dim(t('mediaUnavailable', row.type)), row); return }
    const path = this.imagePathFor(row)
    const d = path ? cached(path) : undefined
    if (d instanceof Error) { push(dim(t('mediaUnreadable', row.type, esc(d.message))), row); return }
    // Size: from the pixels if we already have them, otherwise from the dimensions the message carries, otherwise a default rectangle.
    const w = d?.w ?? row.media_w ?? 4, h = d?.h ?? row.media_h ?? 3
    // In block mode the image takes up to 40 columns: each cell is a color pair the terminal (and a multiplexer
    // in between) has to paint, and a chat full of photos scrolls at the cost of those cells. In Kitty, with
    // real pixels, its natural size up to 60 columns is enough. The height never exceeds the panel.
    const maxRows = row.type === 'sticker' ? 8 : Math.max(4, this.innerHeight() - 2)
    const { cols, rows } = this.kitty
      ? cellSize(w, h, Math.min(width - 1, 60), Math.min(maxRows, 18))
      : cellSize(w, h, Math.min(width - 1, 40), maxRows, true)
    const pad = mine ? Math.max(0, width - 1 - cols) : 0
    if (!d) {
      images.push({ row, origLine: lines.length, cols, rows, pad })
      push(`${' '.repeat(pad)}${dim(`[${row.type}${path ? ` ${t('loading')}` : row.media_path ? '' : ` ${t('downloading')}`}]`)}`, row)
      for (let i = 1; i < rows; i++) push('', row)
      return
    }
    if (this.kitty) {
      images.push({ row, origLine: lines.length, cols, rows, d, pad, path: path! })
      for (let i = 0; i < rows; i++) push('', row)
    } else {
      for (const l of halfBlocks(d, cols, rows)) push(' '.repeat(pad) + l, row)
    }
  }

  /** Drawn lines [start, end) of an image, and the panel's visible window. */
  private imageSpan(img: ImageSlot): { top: number; bottom: number } | null {
    const top = this.msgBox._clines?.ftor?.[img.origLine]?.[0]
    return top == null ? null : { top, bottom: top + img.rows }
  }

  /** After each frame: downloads and decodes only the images that are in view. */
  private loadVisibleImages() {
    if (!this.current || this.pickerOpen) return
    const base = this.msgBox.childBase, innerH = this.innerHeight()
    for (const img of this.images) {
      if (img.d) continue
      const span = this.imageSpan(img)
      if (!span || span.bottom <= base || span.top >= base + innerH) continue
      const row = store.getMessage(img.row.chat_jid, img.row.id) ?? img.row
      const path = this.imagePathFor(row)
      if (path && !cached(path)) {
        uiLog.info({ id: row.id, path }, 'decode visible image')
        decode(path).then(() => { if (this.current === row.chat_jid) { this.dirtyMessages = true; this.scheduleRender() } })
      }
      // Thumbnail by hand while the full file hasn't arrived; videos and gifs stay with just the thumbnail.
      if (!row.media_path && !row.media_err && row.type !== 'video' && row.type !== 'gif') this.yap.ensureMedia(row)
    }
  }

  /** After each blessed frame: re-places the visible Kitty images in the messages panel. */
  private placeImages() {
    if (!this.kitty) return
    this.kitty.clear()
    if (!this.images.length || !this.current || this.pickerOpen) return
    const clines = this.msgBox._clines
    if (!clines?.ftor) return
    const base = this.msgBox.childBase
    const innerH = this.innerHeight()
    const col = num(this.msgBox.aleft) + num(this.msgBox.ileft) + 1
    for (const img of this.images) {
      if (!img.d || !img.path) continue
      const top = clines.ftor[img.origLine]?.[0]
      if (top == null) continue
      const bottom = top + img.rows
      const visTop = Math.max(top, base), visBottom = Math.min(bottom, base + innerH)
      if (visTop >= visBottom) continue
      const row = num(this.msgBox.atop) + num(this.msgBox.itop) + (visTop - base) + 1
      this.kitty.place(img.path, img.d, col + img.pad, row, img.cols, visBottom - visTop, (visTop - top) / img.rows, (visBottom - top) / img.rows)
    }
  }

  private openMedia(row: MessageRow) {
    const file = mediaFile(row)
    if (!file) {
      if (row.media_err) return this.flash(t('attachmentExpired'))
      this.yap.ensureMedia(row)
      return this.flash(t('downloading'))
    }
    const child = spawn('xdg-open', [file], { detached: true, stdio: 'ignore' })
    child.on('error', e => this.flash(t('cannotOpen', e.message)))
    child.unref()
  }
}
