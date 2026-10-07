# wassup

A WhatsApp client for the terminal, inspired by [wechit](https://github.com/LingDong-/wechit). It connects as a
"linked device" through the [baileys](https://github.com/WhiskeySockets/Baileys) library, keeps everything in a local
SQLite database and draws the interface with panels, mouse and images right in the terminal.

## Running

```sh
npm install -g github:lucio-ferrao/wassup
wa              # from anywhere
wa emma         # opens straight into the chat whose name or number contains "emma"
```

Without installing, `npx github:lucio-ferrao/wassup` runs it from npm's cache (the first time downloads the
dependencies, about 100 MB). Or, from a clone: `npm install`, then `./wa` (or `npm start`). npm 12 warns that some
dependencies' install scripts were skipped; they are not needed, the warning can be ignored.

The first time, a QR code appears: on the phone, WhatsApp › Settings › Linked devices › Link a device. The session is
saved and later runs connect directly.

While you write in a chat the client announces itself "available" to WhatsApp, so the phone does not notify, just as
with WhatsApp Web open. Only writing counts (typing, deleting, pasting or sending): not opening it, the mouse, other
keys or getting the focus. After 2 minutes without writing it goes back to "unavailable", and at once when its window
or pane loses the focus, in terminals that report it (Herdr does). A message arriving in the chat you have open counts
as read only while you show as online and, in Herdr, its pane has the focus; otherwise it stays unread, and the phone
notifies, until you write, open the chat or come back to the terminal.

Requirements: Node 22.13 or newer (it uses the SQLite built into Node).

Language: Portuguese or English, from `WA_LANG` or the locale (`LC_ALL`, `LC_MESSAGES`, `LANG`). It sets the interface
texts, the emoji names and the language of the writing suggestions.

## Interface

The tab bar at the top with the connection state on the right, messages across the full width under it, and the input
at the bottom, with the chat's first name as the prompt, in the colour the person's name has in groups (`Ema ❯ `, with
👀 over the name on the rule above while they're online, and in a group one per member online, up to five, among the 30
who wrote most recently, and a braille spinner in place of the 👀 while they type; the first two for a contact with
more than two names, or a group's name). No frames or backgrounds of its own: the colours are the terminal theme's,
and on startup the terminal is asked for its real background colour to pick light or dark shades.

- **Tabs**: one per open chat, with the unread count in red and an `×` to close. Tab cycles through them; whatever is
  left unsent stays with each chat. While someone is typing, a braille spinner turns before their name in the tab and
  in place of their 👀 on the rule above the input. New messages in a chat without a tab open one without activating
  it, with a passing notice over it and the bell.
- **Chats**: `/`, or a click on the chat's name in the prompt, opens the list under the app's name, most recent at the
  bottom, under day separators (today, yesterday, this week, older); each row has the name in its colour, 👀 while the
  person is online, the last message (a spinner and "typing…" while someone types, the state of yours, mentions by
  name), how long ago and the unread count. Typing after `wassup ❯` filters it word by word, ignoring accents and
  case, with the matches underlined; Enter, Tab, → or a click opens.
- **Messages**: yours on the right, each in a bubble with WhatsApp Web's colours where the terminal takes 24-bit
  colour (yours, on a dark theme, toned down to the brightness of theirs) and two discreet greys otherwise, with the
  time and its state outside it (and 👀 over the time of the last of yours that was read) and a link's preview image
  inside it above the text; the pictures of images, stickers, videos and GIFs stay out of it, with their caption in
  it, and emoji on their own go bare; each day starts with a separator and a blank line. Mouse wheel or PgUp/PgDn;
  scrolling past the top brings older messages, first the stored ones and then from the phone, and Ctrl+↓ or Ctrl+PgDn
  goes back to the latest. An attachment not downloaded yet shows `⤓`: a click fetches it into the app's media folder,
  where it stays, and the mark goes; once there, a click opens it with `xdg-open`. ↑ selects a message: typing replies
  to it, `:` reacts, Delete opens one of yours for editing. Mentions show the person's first name in their colour
  (`@Ana`); a click on one, or in a group on a member's name, opens the chat with them; a click on a pin (`📌 pinned a
  message`) goes to the message it's about. The `☺` next to a message under the pointer opens its quick reactions; a
  double click, dragging it to the right, or → with it selected, starts a reply.
- **Input**: grows with the text up to half the screen; the rule above it shows 👀 near its right end while you show as
  online, a braille spinner instead while you type; Enter sends, Shift+Enter or Ctrl+J start a new line, and pasting
  several lines keeps them. Ctrl-U clears, Shift-Backspace deletes a word (with the Kitty keyboard protocol). `:` and
  two letters open the emoji list; ↑/↓, Enter, Tab, → or a click pick one.
- Esc closes, in order: the filter, the list, the active tab. Closing the last tab quits. Ctrl-C quits at once;
  Ctrl-R redraws the screen.
- **Several terminals**: the first process is the server with the WhatsApp connection; the next ones connect to it
  through a socket and are interface only, each with its own tabs. If the server ends, another one takes over.
- **Single chat**: `wa <name>` opens only that chat, without the tab bar or notices from others; the `/` list swaps
  it. An emoji on its own, as a message or a reaction, sends a big copy of it floating up the panel, drawn in block
  characters from the system's emoji font (the same glyph and colours the terminal shows); needs `sharp`.

### Herdr

Inside [Herdr](https://herdr.dev) wassup starts in single-chat mode and each chat is a Herdr tab or pane: in the list,
Enter puts the chat in this pane, → opens it in a new pane beside it and Tab in a new tab (all three focus the one
that already has it), and a message from a chat without one opens it in the background, in a pane when its tab is
already split and in a tab otherwise, still unread (so the phone notifies) until you go to it. Tab, with nothing
typed, moves to the next conversation's pane or tab, in the order Herdr shows them. wassup shows up in Herdr's agent
list under the chat's name alone: `working` while the other person types, `done` (blue) from a new message (or when
they stop typing) until you look at its pane, `idle` otherwise; alone in its tab, the tab takes the contact's first
name. Outside Herdr the terminal window title carries the name, with `●` for unread messages or the spinner while they
type.

### Formatting and emoji

WhatsApp markup is shown with terminal attributes: `*bold*`, `_italic_`, `~strikethrough~`, `` `code` ``, `> quote`.
When sending, write the markup as on the phone. `:name:` codes are replaced by the emoji as soon as the second `:` is
typed, with names in Portuguese and in English (`:thumbsup:` 👍, `:kissing_heart:` 😘, `:coffee:` ☕ …; the list is in
`src/emoji.ts`), and classic smileys surrounded by spaces too (`:)`, `;)`, `<3` …). The suggestion list only shows the
names in the user's language. Links are shown without what only tracks who shared them (`fbclid`, `utm_…`, `igsh`,
`si` and the many others in [ClearURLs](https://github.com/ClearURLs/Rules)' rules, redirections through a site
undone) and shortened (`instagram.com/p/DeNKVAJuamr`, a long path cut in the middle); a click copies the whole clean
link.

### Images

On startup the client asks the terminal what it can do, assuming nothing from `TERM`. In terminals with the Kitty
graphics protocol (Ghostty, Kitty, WezTerm, Konsole) images, stickers and thumbnails are shown for real inside the
panel; elsewhere, and inside Herdr (which doesn't pass the placements through), they are drawn with coloured
half-blocks, each the average colour of the area it covers: in 24-bit colour when the terminal confirms it (XTGETTCAP
or DECRQSS; Herdr does), in the 256-colour palette otherwise. `WA_IMAGES=kitty|blocks|none` forces the mode, and
`WA_COLORS=truecolor|256` the colours.

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
| `src/links.ts`, `src/clearurls/` | Links cleaned of tracking and shortened; ClearURLs' rules (LGPL-3.0, from [ClearURLs/Rules](https://github.com/ClearURLs/Rules) at 11086f4, 2026-03-25) |
| `src/image.ts` | Decoding, half-blocks (24-bit or 256 colours), Kitty graphics protocol |
| `src/term.ts` | Probing the terminal's capabilities |
| `src/kittykeys.ts`, `src/paste.ts` | Kitty keyboard protocol and bracketed paste, read before blessed |
| `src/herdr.ts` | Agent state, titles and tabs in Herdr |
| `src/hearts.ts` | Animated emoji rising from a single-emoji message or reaction |
| `src/i18n.ts` | Interface strings in Portuguese and English |
| `src/llm.ts` | Writing suggestions from the local `llama-server` |
| `src/emoji.ts`, `src/italic.ts`, `src/rainbow.ts` | `:name:` table, italics in blessed, colours |
