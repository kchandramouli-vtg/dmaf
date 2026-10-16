# Editing the text in DMAF

This guide tells you where every piece of text in the app lives, how to change it safely, and what to do so the
change shows up. You don't need to know JavaScript for most edits — you change words between HTML tags or inside
quotes and leave everything else alone.

---

## 1. The short version

1. **Find the words.** Search the project for a phrase you can see on screen (in VS Code: <kbd>⌘</kbd><kbd>⇧</kbd><kbd>F</kbd>,
   or in Terminal: `grep -rn "phrase you see" index.html js server tools`). Search for a distinctive part of the
   sentence — dynamic text is split around values like amounts and names.
2. **Change only the words.** Keep tags (`<b>…</b>`), quotes, backticks, `${…}` placeholders, `id="…"`, `data-…="…"`
   and `class="…"` exactly as they are.
3. **Make it show.** Save, then reload the browser tab (<kbd>⌘</kbd><kbd>⇧</kbd><kbd>R</kbd>). There's no build step for the
   page. Exceptions are in [§4](#4-when-a-change-shows-up).

---

## 2. What you need

| You need | Why |
|---|---|
| A code editor — [VS Code](https://code.visualstudio.com/) is fine | Search across files, see the HTML/JS colours so you don't break a quote |
| The dev server running (`npm run serve`) and the app at http://localhost:5173 | To see your change. Opening `index.html` directly also works for static text (demo mode) |
| For use-case template text only: `npm install` done once | `npm run templates` regenerates that text (see §5.6) |
| Nothing else | No compiler, bundler or database needed to change text |

---

## 3. Where text lives

| Kind of text | File | What it looks like |
|---|---|---|
| Fixed text on each screen: headings, intros, labels, buttons, help lines | `index.html` | `<h2>Sign in</h2>`, `<p class="help">At least 8 characters.</p>` |
| Text built while the app runs: status rows, tables, cards, messages | `js/*.js` | `` `Signed in as ${name}` `` (a *template string*) |
| Pop-up messages at the bottom of the screen ("toasts") | `js/*.js` | `toast("Agreement is live — plays will use the direct split")` |
| Error messages from the dev server (packaging, sign-in, library) | `server/*.mjs` | `throw err(401, "Email or password is incorrect")` |
| The six use-case cards in the Studio | `tools/build-mco-templates.mjs` → generates `js/mco-templates.js` | `"Record label with a direct deal with streaming services."` |
| Reuse licences (Studio step 4) | `js/api.js` (`mockDB.contracts`) | `{ name: "Licensed sample", blurb: "Creators may reuse…" }` |
| Lines `npm run serve` prints in Terminal | `tools/serve.mjs` | `` `✓ IPFS  Kubo ${version} …` `` |
| Documentation | `README.md`, `docs/*.md`, `mpeg21/*.md` | Markdown |

### Reading a template string

Text in backticks can contain `${…}` placeholders that the app fills in:

```js
`Signed in as ${esc(A.user.artistName)} · files you add appear in My Library`
```

Change *Signed in as* and *· files you add appear in My Library* freely. Leave `${esc(A.user.artistName)}` exactly as
it is — `esc(…)` makes names safe to show on the page. Strings in `"double"` or `'single'` quotes are plain text; if you
need an apostrophe inside `'…'`, switch the quotes to `"…"` (or write `\'`).

### HTML characters

In `index.html` (and HTML inside template strings) write `&amp;` for **&**, `&lt;` for **<**. Typographic characters
(— · ’ “ ” …) can be typed directly; the files are UTF-8.

---

## 4. When a change shows up

| You edited | Do this |
|---|---|
| `index.html`, `css/dmaf.css`, anything in `js/` | Reload the tab (<kbd>⌘</kbd><kbd>⇧</kbd><kbd>R</kbd>) |
| `server/*.mjs`, `tools/serve.mjs` | Stop `npm run serve` (<kbd>Ctrl</kbd><kbd>C</kbd>) and start it again, then reload |
| `tools/build-mco-templates.mjs` (use-case cards) | `npm run templates`, then reload. Never edit `js/mco-templates.js` by hand — it's overwritten |
| Text inside a saved agreement (titles, party names, labels you typed in the Studio) | That's data, not code: edit it in the Studio (or start a new agreement). Old agreements keep the text they were created with |
| Text inside something already published (asset title, metadata, IMAF track names) | It's on IPFS and the chain and can't change; publish again |

---

## 5. Screen by screen

Search for the **id** or **function** named in the table; the text sits next to it.

### 5.1 On every page

| What you see | File | Where |
|---|---|---|
| Browser tab title | `index.html` | `<title>` near the top |
| "DMAF" + "Decentralised Media Application Framework" (top left) | `index.html` | `<a class="brand">` in `<header>` |
| Menu: Discover · My Library · Studio · Publish · Royalties | `index.html` | `<nav id="topnav">` — change the link text, keep `href`, `data-nav` and `hidden` (the gated links appear once you're signed in) |
| "Sign in" in the menu (becomes your artist name) | `js/account.js` | `render()` — `"Sign in"` and the `nameOf()` fallback order |
| "Connect MetaMask" / balance chip | `index.html` (`id="mm-btn"`) and `js/web3.js` | `renderChip()` |
| Footer © line | `index.html` | `<footer>` |
| Footer grey note about demo data | `js/app.js` | first lines (`mocknote`) |
| Footer engine labels (IMAF Engine, DASH Engine…) | `index.html` | `<div class="engines">` |

### 5.2 Sign in (`#/login`)

| What you see | File | Where |
|---|---|---|
| "Welcome to DMAF" + intro | `index.html` | `<section id="view-login">` |
| Sign-in and Create-account forms (labels, help lines, button text) | `index.html` | `id="auth-forms"` |
| The MetaMask explanation under "Sign in with MetaMask" | `index.html` | the `<p class="help">` after `id="btn-siwe"` |
| "Demo sign-in. PostgreSQL isn't configured…" notice | `js/account.js` | `render()` → `mode.innerHTML` |
| "Sign in to open the Studio — you'll go straight there afterwards…" | `js/app.js` | `gateNote()`; the page names ("the Studio", "this track"…) are in `GATED_NAMES` |
| "Your session has ended — sign in again to continue" | `js/account.js` | `A.sessionEnded` |
| "Sign in to play" on Discover cards (signed out) | `js/media.js` | `assetCard()` |
| Account card rows (Name, Artist name, Email, Payout wallet, Account) | `js/account.js` | `render()` → `row(…)` calls |
| Account card buttons | `index.html` | `id="account-card"` |
| Toasts: "Signed in as…", "Account created", "Wallet … linked" | `js/account.js` | bottom of the file (`toast(…)`) |
| The message MetaMask asks you to sign | `js/account.js` | `signedMessage()` — only change the sentence after the first blank line; the first two lines and the `URI:`/`Version:`/`Chain ID:`/`Nonce:`/`Issued At:` lines are checked by the server |
| Sign-in errors ("Email or password is incorrect", "Use a password of at least 8 characters"…) | `server/auth.mjs` | `throw err(…, "…")` — restart `npm run serve` |

### 5.3 My Library (`#/library`)

| What you see | File | Where |
|---|---|---|
| Title, intro, "＋ New agreement", section headings | `index.html` | `<section id="view-library">` |
| Published cards (title, pills, buttons) | `js/media.js` | `assetCard()` |
| "1 asset published by…", "Nothing published from this wallet yet…" | `js/media.js` | `renderAssetGrid()` |
| IPFS files: toolbar, column headings, empty states, notes | `js/library.js` | `draw()`, `row()`, `window.renderIpfsLibrary` |
| File type names (Stem mix (MP3), IMAF package, Smart-contract token…) | `js/library.js` | `KIND` at the top |
| Filter names (Media & documents, Audio & mixes…) | `js/library.js` | `FILTERS` at the top |
| Unpin warning ("Asset #… uses it — once your node garbage-collects it…") | `js/library.js` | `row()` |
| Agreements list cards | `js/agreement.js` | `agCard()` |

### 5.4 Discover (`#/discover`)

| What you see | File | Where |
|---|---|---|
| Title, intro, "On-chain" heading and its help line | `index.html` | `<section id="view-discover">` |
| Cards and empty/offline messages | `js/media.js` | `assetCard()`, `renderAssetGrid()` |

### 5.5 Asset page (`#/asset/1`)

| What you see | File | Where |
|---|---|---|
| Card headings: Listen, Revenue split, Stems, IPFS & contract, Access log | `index.html` | `<section id="view-asset">` |
| Subtitle line, pills, "N paid plays" | `js/media.js` | `drawHeader()` |
| "Pay & play · 0.001 ETH", "Paused by the publisher" | `js/media.js` | `payBtnIdle()` |
| Payment box ("Paid … — play recorded on-chain", payouts, "held for withdraw") | `js/media.js` | `payAndPlay()` |
| Revenue split note and table | `js/media.js` | `drawSplit()` |
| Stems card note, "Couldn't load the stem waveforms" | `js/media.js` | `drawStems()` |
| Stem lane captions ("the MP3 you hear", "· 60% in the mix"), "Click a lane to jump." | `js/stemviz.js` | `mount()` |
| IPFS & contract rows (Audio, IMAF package, Smart Contract for Media…) | `js/media.js` | `drawRefs()` |
| "Read it back" results | `js/media.js` | `verifyScm()`, `verifyImaf()`, `verifyAudio()` |
| Access log table, *Verify* / *Hide* buttons, "Couldn't check this play" | `js/media.js` | `drawLog()` |
| Payout check results (✓/✕ lines, party labels, "The listener's wallet is also a payee…") | `js/media.js` | `verifyHtml()` |
| "Check every wallet's balance on-chain" (after paying) | `js/media.js` | `payAndPlay()` |
| "Your connected wallet … is a payee" note | `js/media.js` | `drawSplit()` |
| `npm run verify:payouts` output | `tools/verify-payouts.mjs` | `print()` |

### 5.6 Studio (`#/studio`)

**Step 1 · Agreement**

| What you see | File | Where |
|---|---|---|
| Step names in the stepper (Agreement, Stems, Package, Reuse licence, Publish) | `index.html` | `id="studio-stepper"` |
| Section headings 1–7, field labels, help lines, buttons | `index.html` | `id="wstep-1"` |
| Use-case grid row/column names (On-demand stream, Big label…) | `js/agreement.js` | `renderTemplates()` → `models`, `tiers` |
| Use-case card descriptions ("Record label with a direct deal…") | `tools/build-mco-templates.mjs` | `META` → then `npm run templates` |
| "Template: CONTRACT 2 - …" line | from the standard's template files (shown as is, minus service names) | `cleanLabel()` in `js/agreement.js` |
| Role, action and status names in dropdowns/pills | `js/agreement.js` | `ROLE_TYPES`, `ACTIONS`, `STATUS` near the top — change only the **last** item of each entry (the label); the first is the MCO/MVCO term (roles, actions) or a style name (statuses) |
| Quick-add stem names, stem formats, currencies | `js/agreement.js` | `QUICK_STEMS`, `FORMATS`, `UNITS` near the top |
| Demo organisation names (Any DSP, PRS for Music, Low Orbit Records…) | `js/agreement.js` | `DEMO_NAMES` |
| Checklist messages ("Name every party…", "would share one wallet…") | `js/agreement.js` | `checks()` |
| Chain box after registering ("Deployed as an ISO/IEC 21000-23…", "Agreement live — plays settle by direct split") | `js/agreement.js` | `renderSigs()` |
| "Agreement active — go make the music" panel | `index.html` (heading) and `js/agreement.js` (`renderSigs()`, the sentence) |

**Step 2 · Stems**

| What you see | File | Where |
|---|---|---|
| Heading, hint box, drop-zone text, table headings | `index.html` | `id="wstep-2"` |
| "on the dev server · 48 kHz · 24-bit…", "not on the dev server", "uploading…" | `js/agreement.js` | `stemCell()` |
| "5 of 5 required stems delivered · ffmpeg … ready to mix and package" | `js/agreement.js` | `renderStems()` |
| Group names (Vocals, Rhythm, Lead, Keys, Strings, FX) | `js/agreement.js` | `GROUPS` — these names are also written into the IMAF file and colour the visualiser lanes (`js/stemviz.js` `GROUP_COLORS`) |

**Step 3 · Package** — preset checkboxes, listener-rule options and DASH line: `index.html`, `id="wstep-3"`.
Preset names appear in three places; keep them in step: the checkbox labels (`index.html`), `PRESET_NAMES` in `js/app.js`
(review summary) and `PRESET_DEFS` in `server/imaf.mjs` (the names written into the IMAF file — restart the server).

**Step 4 · Reuse licence** — the cards come from `mockDB.contracts` in `js/api.js` (`name`, `blurb`, `terms`, `price`, `priceNote`).

**Step 5 · Review, package and publish**

| What you see | File | Where |
|---|---|---|
| Summary labels, the packaging explanation, buttons | `index.html` | `id="wstep-5"` (the explanation also appears in `js/app.js` `resetPackage()` — change both) |
| Result rows (Mix, IMAF package, Groups, Presets, Muxed by, Waveforms…) | `js/app.js` | the `#btn-package` click handler → `row(…)` calls |
| Packaging errors ("ffmpeg isn't usable…", "not delivered to the dev server yet…") | `server/stems.mjs` | restart `npm run serve` |

### 5.7 Publish (`#/publish`)

| What you see | File | Where |
|---|---|---|
| Title, intro, card headings, field labels, help lines | `index.html` | `<section id="view-publish">` |
| Status rows (MetaMask, Network, Local chain, Registry contract, ISO/IEC 21000-23 API, Account, IPFS node) | `js/media.js` | `renderServices()` |
| Settlement picker and split explanations ("Each play pays…", "Derived from the agreement's payment obligations…") | `js/media.js` | `renderSplits()` |
| Split warnings/errors ("…have no wallet in the agreement…") | `js/media.js` | `directSplit()`, `scmSplit()`; payTo reasons in `js/scm.js` `payToIssues()` |
| "From the Studio: …" banner | `js/media.js` | `attachPackage()` |
| Step names (Upload the MP3 to IPFS…) | `js/media.js` | `STEPS` |
| Step details, the done box | `js/media.js` | `publishNow()` |
| "Ready — MetaMask will ask you to confirm…" | `js/media.js` | `updateGo()` |

### 5.8 Royalties (`#/royalties`)

| What you see | File | Where |
|---|---|---|
| Title, intro, "Demo data" heading | `index.html` | `<section id="view-royalties">` |
| Live on-chain card (stats, rows, Withdraw) | `js/media.js` | `window.renderLiveRoyalties` |
| Demo stats and rows | `js/app.js` `renderRoyalties()` + `js/api.js` `mockDB` |

### 5.9 Player (`#/player`) — still simulated

Headings in `index.html` (`id="view-player"`), preset buttons in `js/app.js` (`PRESETS`).

---

## 6. Messages and errors

| Message | File | Where |
|---|---|---|
| Toasts | any `js/*.js` | search for `toast(` |
| Wallet / chain / IPFS errors ("Cancelled in MetaMask", "The IPFS node isn't running…", "MetaMask still remembers the previous chain…") | `js/web3.js` | `errMsg()` — the patterns on the left decide *which* message; change only the sentences |
| Dev-server errors (sign-in, My Library, packaging, ISO/IEC 21000-23 API) | `server/auth.mjs`, `server/library.mjs`, `server/stems.mjs`, `server/scm-api.mjs` | `throw …(…, "message")` — restart `npm run serve` |
| Terminal lines from `npm run serve` | `tools/serve.mjs` | the `console.log` calls at the bottom |

---

## 7. Leave these alone

* `id="…"`, `data-…="…"`, `class="…"`, `for="…"` — the code finds elements by them. Renaming one silently breaks a button or a section.
* `${…}`, `esc(…)` and anything outside quotes in the JS files.
* The **left** side of `key: "label"` pairs and the **first** item of `["mvco:Producer", "Producer"]` entries — those are keys,
  standard vocabulary or style names; only the label (right side / last item) is display text.
* `js/mco-templates.js` (generated), `js/chain-config.js` (written by `npm run deploy`), `mpeg21/test/fixtures/` (the standard's own files),
  `mpeg21/lib/vocab.mjs` and `mpeg21/lib/lut.mjs` (standard vocabulary).
* Hash routes (`#/library`, `#/studio`…) — the menu text can change, the `href` can't (unless you also change `routes` in `js/app.js`).
* The first two lines and the `URI` / `Version` / `Chain ID` / `Nonce` / `Issued At` lines of the MetaMask sign-in message.

---

## 8. Worked examples

**Rename the "My Library" menu item to "My Music".** In `index.html` find `<a href="#/library" data-nav="library" hidden>My Library</a>`
and change only the words: `<a href="#/library" data-nav="library" hidden>My Music</a>`. Also change `library: "My Library"` in
`GATED_NAMES` (`js/app.js`), which the sign-in notice uses. Change the page heading too
(`<h1>My Library</h1>` in `<section id="view-library">`). Reload.

**Change a use-case description.** In `tools/build-mco-templates.mjs`, edit the last string of the line for the template, e.g.
`"stream-big-label": [… , "Record label with a direct deal with streaming services."]`. Run `npm run templates`, reload.

**Change the "IPFS node isn't running" message.** In `js/web3.js` → `errMsg()`, change the sentence after `return`; keep the
`if (/…/.test(text))` part. Reload.

**Change the sign-in error text.** In `server/auth.mjs`, find `"Email or password is incorrect"`, change it, restart
`npm run serve`.

**Change the footer note.** In `js/app.js`, the sentence at the top that starts `"Sign-in, signatures and the Royalties overview…"`.

---

## 9. Checking your change

* Reload and look at the screen — at desktop width and at phone width (browser dev tools ▸ device toolbar), long words can wrap.
* Open the browser console (<kbd>⌥</kbd><kbd>⌘</kbd><kbd>J</kbd>): a red error after your edit usually means a missing quote
  or backtick in a `js/` file — undo the last edit and try again.
* `npm test` runs the contract, conformance and server tests; they don't depend on UI wording, so they should still pass.
* House style: British spelling (*decentralised*, *licence* as a noun, *licensed* as a verb), sentence case for headings and
  buttons, "—" for asides, "·" between short facts.
