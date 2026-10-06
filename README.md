# wa

A WhatsApp client for the terminal, inspired by [wechit](https://github.com/LingDong-/wechit). It connects as a
"linked device" through the [baileys](https://github.com/WhiskeySockets/Baileys) library, keeps everything in a local
SQLite database and draws the interface with panels, mouse and images right in the terminal.

## Running

```sh
npm install
./wa            # or: npm start
./wa emma       # opens straight into the chat whose name or number contains "emma"
```

The first time, a QR code appears: on the phone, WhatsApp › Settings › Linked devices › Link a device. The session is
saved and later runs connect directly.

While the terminal is in use the client announces itself "available" to WhatsApp, so the phone does not notify, just
as with WhatsApp Web open. After 2 minutes idle it goes back to "unavailable".

Requirements: Node 22.13 or newer (it uses the SQLite built into Node).

Language: Portuguese or English, from `WA_LANG` or the locale (`LC_ALL`, `LC_MESSAGES`, `LANG`). It sets the interface
texts, the emoji names and the language of the writing suggestions.

## Interface

The tab bar at the top with the connection state on the right, messages across the full width under it, and the
input at the bottom, with the chat's first name as the prompt (`Ema > `). No frames or backgrounds of its own: the
colours are the terminal theme's, and on startup the terminal is asked for its real background colour to pick light
or dark shades.

- **Tabs**: one per open chat, with the unread count in red and an `×` to close. Tab cycles through them; whatever
  is left unsent stays with each chat. While someone is typing, a rainbow runs along their name, in the tab and in
  the prompt. New messages in a chat without a tab open one without activating it, with a passing notice over it
  and the bell.
- **Chats**: `/` opens the list, most recent at the bottom, with an excerpt of the last message; typing filters it,
  ignoring accents and case; Enter, Tab, → or a click opens.
- **Messages**: yours on the right. Mouse wheel or PgUp/PgDn. Clicking an attachment opens it with `xdg-open`,
  downloading it first if needed. ↑ selects a message: typing replies to it, `:` reacts, Delete opens one of yours
  for editing. The `☺` next to a message under the pointer opens its quick reactions; a double click, dragging it to
  the right, or → with it selected, starts a reply.
- **Input**: grows with the text up to half the screen; Enter sends, Shift+Enter or Ctrl+J start a new line, and
  pasting several lines keeps them. Ctrl-U clears, Shift-Backspace deletes a word (with the Kitty keyboard protocol).
  `:` and two letters open the emoji list; ↑/↓, Enter, Tab, → or a click pick one.
- Esc closes, in order: the filter, the list, the active tab. Closing the last tab quits. Ctrl-C quits at once.
- **Several terminals**: the first process is the server with the WhatsApp connection; the next ones connect to it
  through a socket and are interface only, each with its own tabs. If the server ends, another one takes over.
- **Single chat**: `wa <name>` opens only that chat, without the tab bar or notices from others; the `/` list swaps
  it. An emoji on its own, as a message or a reaction, sends a big copy of it floating up the panel, drawn in block
  characters from the system's emoji font (the same glyph and colours the terminal shows); needs `sharp`.

### Herdr

Inside [Herdr](https://herdr.dev) `wa` starts in single-chat mode and each chat is a Herdr tab or pane: in the list,
Enter puts the chat in this pane, → opens it in a new pane beside `wa` and Tab in a new tab (all three focus the one
that already has it), and a message from a chat without one opens it in the background, in a pane when `wa`'s tab is
already split and in a tab otherwise. `wa` shows up in Herdr's agent list under
the chat's name, with `●` when there is something unread: `working` while the other person types, `blocked` with
unread messages, `idle` otherwise; alone in its tab, the tab takes the contact's first name. Outside Herdr the
terminal window title carries the name.

### Formatting and emoji

WhatsApp markup is shown with terminal attributes: `*bold*`, `_italic_`, `~strikethrough~`, `` `code` ``, `> quote`.
When sending, write the markup as on the phone. `:name:` codes are replaced by the emoji as soon as the second `:` is
typed, with names in Portuguese and in English (`:thumbsup:` 👍, `:kissing_heart:` 😘, `:coffee:` ☕ …; the list is in
`src/emoji.ts`), and classic smileys surrounded by spaces too (`:)`, `;)`, `<3` …). The suggestion list only shows the
names in the user's language.

### Images

On startup the client asks the terminal what it can do, assuming nothing from `TERM`. In terminals with the Kitty
graphics protocol (Ghostty, Kitty, WezTerm, Konsole) images, stickers and thumbnails are shown for real inside the
panel; elsewhere, and inside Herdr (which doesn't pass the placements through), they are drawn with coloured
half-blocks. `WA_IMAGES=kitty|blocks|none` forces the mode.

## Writing suggestions

With a local `llama-server` at `http://127.0.0.1:8080` (or `WA_LLM`), model `gemma4-26b` (or `WA_LLM_MODEL`), the
input asks for a suggestion shortly after the last key, with the latest messages as context: the letters missing from
the word being typed, right at the cursor, or the right word after `⇢` above the wrong one. Tab or → accept. The prompt is in
the user's language. `WA_LLM=off` disables it.

## Data

Everything lives in `~/.config/wa` (or `WA_HOME`), readable by this user only (mode 700, umask 077 for whatever is
written):

| Path | Contents |
|---|---|
| `auth/` | Session credentials (delete to link again) |
| `wa.db` | SQLite with chats, contacts, messages and reactions |
| `media/<chat>/` | Downloaded attachments and thumbnails |
| `wa.log` | Log (level with `WA_LOG=info|debug`) |

History starts with what WhatsApp sends to new devices. `WA_FULL_HISTORY=1` asks for the full history when linking.

## Layout

| File | Role |
|---|---|
| `src/wa.ts` | WhatsApp connection: QR, reconnection, messages, reactions, sending, attachments |
| `src/ipc.ts` | Server and client over a Unix socket, so several processes share one connection |
| `src/db.ts` | SQLite schema and queries (`node:sqlite`) |
| `src/ui.ts` | blessed interface: panels, keyboard, mouse, message rendering |
| `src/format.ts` | WhatsApp markup, dates, colours, line wrapping |
| `src/image.ts` | Decoding, half-blocks, Kitty graphics protocol |
| `src/term.ts` | Probing the terminal's capabilities |
| `src/kittykeys.ts`, `src/paste.ts` | Kitty keyboard protocol and bracketed paste, read before blessed |
| `src/herdr.ts` | Agent state, titles and tabs in Herdr |
| `src/hearts.ts` | Animated emoji rising from a single-emoji message or reaction |
| `src/i18n.ts` | Interface strings in Portuguese and English |
| `src/llm.ts` | Writing suggestions from the local `llama-server` |
| `src/emoji.ts`, `src/italic.ts`, `src/rainbow.ts` | `:name:` table, italics in blessed, colours |
