# Glimmerfell Configurator

A 3D room configurator that runs in the browser: visitors tap items in a real-looking apartment, swap
models and finishes, see an indicative total, and leave with a PDF, a link and a short code that
reopen the same room. Everything is driven by one file, `config.json`; a client version is a new
config plus their assets, not new code.

It lives in the Glimmerfell repository at `tools/configurator/` and GitHub Pages serves it at
**https://glimmerfell.com/tools/configurator/**. It is **not released yet**: nothing on the site links to
it, and the pages carry `noindex` so search engines leave it alone (section 2, "At launch").

```
tools/configurator/          the published site (what visitors load)
  index.html, app/           built from _source (don't edit by hand)
  config.json, codes.json    the data you edit
  assets/ textures/ thumbs/ sky/ brand/ embed.html
  _source/                   the code; Jekyll skips folders starting with "_", so it isn't published
```

In the text below, **the data folder** means `tools/configurator/` (in the original working folder
`03_web` it is `public/`).

---

## Contents

1. [Run it on your computer](#1-run-it-on-your-computer)
2. [Publish it](#2-publish-it)
3. [Everyday changes](#3-everyday-changes) (prices, names, defaults, badges, order)
4. [Looks and their thumbnails](#4-looks-and-their-thumbnails)
5. [Configuration codes](#5-configuration-codes)
6. [Enquiry buttons and the glimmerfell.com form](#6-enquiry-buttons-and-the-glimmerfellcom-form)
7. [Links you can send](#7-links-you-can-send)
8. [Embedding on another site](#8-embedding-on-another-site)
9. [New 3D models, finishes or a new bake](#9-new-3d-models-finishes-or-a-new-bake)
10. [Before you publish: checklist](#10-before-you-publish-checklist)
11. [Folder map](#11-folder-map)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Run it on your computer

Needs [Node.js](https://nodejs.org) 20 or newer and a clone of the repository.

```bash
cd tools/configurator/_source
npm ci
npm run dev
```

Open http://localhost:5183. The page reloads by itself when you save a file. `npm ci` is only needed
the first time (and after `package.json` changes). The dev server reads the data folder
(`tools/configurator/`) directly, so edit `tools/configurator/config.json`, not a copy.

The browser console (F12) has a helper object, `configurator`, used by the tasks below. Two of its
commands (`makeLookThumbs`, `saveCodeVersion`) write files into the data folder and only exist while
`npm run dev` is running.

## 2. Publish it

**Only data changed** (`config.json`, `codes.json`, thumbnails, models, textures): commit and push.
GitHub Pages republishes within a minute or two.

**Code changed** (anything in `_source/src`, `_source/index.html`, styles):

```bash
cd tools/configurator/_source
npm run build
```

This type-checks the code and writes `index.html` and `app/` into `tools/configurator/` (the previous
`app/` is cleared first). Commit those together with your source change and push.

- Share links, QR codes and codes use the address the page is served from. To force a fixed address,
  set `"shareBase": "https://glimmerfell.com/tools/configurator/"` in `config.json`; leave it `""` otherwise.
- `node_modules/` is not committed (`_source/.gitignore`).
- **GitHub Pages can't serve Git LFS files**, so models and textures are committed as normal files
  (about 100 MB now). Each re-bake that replaces them adds to the repository's history; keep an eye on the
  repository size (GitHub recommends under 1 GB) and avoid committing trial bakes.
- **Jekyll** builds the site and silently drops any file or folder whose name starts with `_`, `.`, `#`
  or `~`. The build never makes such names; don't give data files such names either.
- **Bandwidth:** a first visit downloads about 22 MB. GitHub Pages has a soft limit of 100 GB a month,
  roughly 4,500 first visits. Fine for a showcase; a client version wants its own hosting or a CDN.

**At launch:** remove `<meta name="robots" content="noindex, nofollow">` from `_source/index.html`
(then build) and from `embed.html`, add `tools/configurator/` to the site's `sitemap.xml`, and link to it
from the site.

## 3. Everyday changes

All in `config.json` in the data folder. Save, and the dev page reloads. Prices are **placeholders**; the summary
and PDF say so.

| To change | Where in `config.json` |
|---|---|
| Price of a model | `slots[].options[].price` |
| Price of a finish | `finishes.<id>.price` (curated finishes); generated ones: `catalogue.families.<family>.price` per category, times `catalogue.premium.<set>` |
| Name on the button / on the summary | `options[].label` / `options[].name`; finishes: `finishes.<id>.label` |
| What a room starts with | `slots[].default` (model) and `parts[].default` (finish) |
| A small label on a swatch or card ("Designer pick", "Bestseller", "New") | `"badge": "…"` on a finish in `finishes`, or on an option. Keep it to one or two per list. |
| Order of items in an area (rail and Next / Previous) | `"order": 1, 2, …` on `elements[]`; items without `order` follow, in file order |
| Why a tap is greyed out | `ruleReasons.<host slot>.<host option>` (text, or `{ "<tap>": text, "*": text }`) |
| Calls to action | `cta` (section 6) |

After changing **defaults, looks, options or finish lists**, save a new code version (section 5).

## 4. Looks and their thumbnails

Looks are complete styled rooms shown as cards on the overview ("Start from a look"). One tap sets
every slot at once.

```json
"looks": [
  { "id": "warm-oak", "label": "Warm Oak", "line": "Light oak, white walls, soft linen",
    "state": { "fronts": "veneer-oak.veneer-oak", "sofa": "peru3.fabric-linen.metal-brass", "…": "…" } }
]
```

- `state` uses the same values as a share link: `<option>.<finish>.<finish>` for models,
  `<finish>.<finish>` for surfaces, finishes in the order of the option's parts. Slots left out take
  their default. The easiest way to write one: set the room up in the browser, then copy the values
  from the address bar.
- Optional `camera` (a camera id) is used when the look is opened by link without `view=`.

**Update the thumbnails** after adding or changing a look (they are static pictures, so the page
doesn't have to load every look at start):

1. `npm run dev` and open http://localhost:5183 in a desktop-sized window.
2. Open the console (F12) and run:
   ```js
   await configurator.makeLookThumbs()
   ```
   It applies each look, waits for it to settle, takes a picture from the overview camera and saves
   it as `thumbs/looks/<id>.jpg` in the data folder (480 × 300). It returns the ids it saved and then puts your room
   back. About 3 seconds per look.
3. Reload to see the new cards. Commit the JPGs.

A look without a thumbnail shows a plain card; nothing breaks. You can also drop your own picture in
at `thumbs/looks/<id>.jpg`, or point `thumb` in the look at any image.

Then save a code version (section 5): looks are part of it.

## 5. Configuration codes

Every room gets a short code such as `GF1-8A` or `GF1-C000-58D`. It is shown in the summary
("Quote this code in store") and on the PDF, can be typed back into the summary's **Enter a code**
field, and opens by link: `?code=GF1-8A`. The full link stays the main way to share; the code is for
reading out, writing down and typing in.

**How it works (no server).** A code stores which slots differ from the defaults or from a look, as
positions in the option and finish lists. Those lists are saved per **catalogue version** in
`codes.json` (data folder). The `1` in `GF1-` is the version. A code always opens with the version it was
made with, so later changes to the catalogue never break old codes, as long as old versions stay in
the file. The last character is a check character: a mistyped code is rejected, not misread. `O` and
`I`/`L` are read as `0` and `1`, and case doesn't matter.

Typical length: a look is 6 characters, a look with a few changes 10–15, a heavily changed room up to
about 23.

**After you change the catalogue** (defaults, looks, options, finishes, a new manifest, new slots):

1. `npm run dev`, open the page, open the console. A yellow warning says
   `the catalogue changed since the last saved code version`.
2. Run:
   ```js
   await configurator.saveCodeVersion()
   ```
   It adds the next version to `codes.json` (or says `unchanged`). New codes use it; old ones
   keep working.
3. Commit `codes.json`.

If you forget, the page still works: rooms that use something the saved version doesn't know show no
code (the link and PDF still work), and everything else gets a code from the last version.

**Never delete or edit versions in `codes.json`**: that breaks every code made with them.

> **Revisit before a client hosts this.** Codes without a server are fine for the showcase. For a client
> on their own webspace, a small store (for example a Cloudflare Worker with KV) that maps a 6-character
> code to the share link would give shorter, fixed-length codes and no `codes.json` to maintain, at the
> cost of a hosted service. Decide per client (see `DECISIONS.md`, "v4 UX", A4).

## 6. Enquiry buttons and the glimmerfell.com form

The summary ends with calls to action from `cta` in `config.json`. The `primary` one is the big
black button and also printed on the PDF; the others are links underneath.

```json
"cta": [
  { "id": "quote", "label": "Request a quote", "kind": "url", "primary": true,
    "href": "https://glimmerfell.com/?enquiry={summary}#enquire", "pdfText": "glimmerfell.com/#enquire" },
  { "id": "measure", "label": "Book a measure-up", "kind": "mailto", "href": "mailto:manny@glimmerfell.com",
    "subject": "Measure-up booking ({code})", "body": "…{summary}…{items}…" },
  { "id": "showroom", "label": "Visit the showroom", "kind": "url", "href": "https://glimmerfell.com" }
]
```

- `kind`: `url` opens `href` in a new tab · `mailto` opens an e-mail · `event` does nothing by itself
  and only tells the embedding page (section 8), so a client's site can open its own form.
- Placeholders in `href`, `subject` and `body`: `{summary}` (a few lines: code, total, link), `{code}`,
  `{total}`, `{url}` (the share link), `{items}` (the item list, shortened).
- `copy: true` also copies `{summary}` to the clipboard and says "Configuration copied: paste it into
  the message", for a form that can't be prefilled (a client's site, for example).
- To rebrand for an exhibitor, change only this list.

**The glimmerfell.com enquiry form is prefilled.** "Request a quote" opens
`https://glimmerfell.com/?enquiry=<code, total, link>#enquire`. The homepage's contact-form script
(`index.html` in the repository root, end of the "Contact form" script in the `#enquire` section) reads
`?enquiry=`, puts the text in the message box and removes it from the address bar:

```js
var enquiry = new URLSearchParams(location.search).get('enquiry');
if (enquiry && !val('gf-message')) {
  $('gf-message').value = enquiry.slice(0, 5000);
  if (history.replaceState) history.replaceState(null, '', location.pathname + location.hash);
}
```

It only acts when the address carries `?enquiry=`, which only the configurator's button adds. The
site's ordinary "Enquire" / "Request a demonstration" links (`#enquire`) leave the form empty, and
text a visitor has already typed is never replaced.

## 7. Links you can send

| Address ending | Opens |
|---|---|
| `?p=kitchen` (`flooring`, `living`, `blinds`, `beds`, `bathroom`) | An area, sometimes with a change (`presets` in config) |
| `?look=dark-walnut` | A look (`warm-oak`, `dark-walnut`, `coastal-white`, `stone-brass`) |
| `?code=GF1-8A` | A saved configuration by code |
| `?view=kitchen` / `?el=sink` | An area camera / an item with its options open |
| the full address after any change | Exactly that room (the address updates as you go) |

These combine, e.g. `?look=stone-brass&view=kitchen`. Slot values written in the address win over a
look or code. Old links (v2 `floor=`, `view=window`) still work.

## 8. Embedding on another site

`embed.html` (served at `…/tools/configurator/embed.html`) shows the one-line iframe snippet
and lists the events the frame sends to the page around it: `presetLoaded`, `optionChanged`,
`lookApplied`, `quoteRequested` (PDF downloaded) and `cta` (a summary button used, with `id`, `url`,
`total` and the full `state`).

## 9. New 3D models, finishes or a new bake

The 3D side (Blender scene, baking, export) is not in this folder; it lives in the project's
`02_3d` folder and is described in its `PIPELINE.md` and the project README. Its results land here:

| From the pipeline | Lands in (data folder) |
|---|---|
| Baked room and options (GLB + lightmaps) | `assets/<pass>/` |
| Cameras, anchors, colliders, tap rules | `assets/scene.json` (never edit by hand) |
| Finish texture sets + list | `textures/pbr/<id>/`, `textures/pbr/manifest.json` |
| Option thumbnails | `thumbs/*.jpg` |

After a new model: add it as an option to its slot in `config.json` (`"dir": "assets/<pass>"`, `label`,
`name`, `price`, `thumb`). After new finishes: they show up by themselves through the category rules
(`catalogue.families`). Either way, save a new code version (section 5) and check the looks still
look right (`makeLookThumbs`, section 4).

## 10. Before you publish: checklist

- [ ] `npm run build` passes (it type-checks first).
- [ ] Console (F12) is clean on a fresh load, apart from the code-version warning if you meant to skip it.
- [ ] Desktop and phone size (DevTools device bar, 375 × 812): pick a look, step through the kitchen
      with **Next**, open the summary, try each button, download the PDF.
- [ ] Reopen from the PDF's link and from its code.
- [ ] An old link still opens: `?p=kitchen`, `?view=window`.
- [ ] Changed looks or catalogue? Thumbnails redone (section 4) and code version saved (section 5).

## 11. Folder map

```
tools/configurator/
  index.html, app/       built page and code (npm run build writes these)
  config.json            everything the configurator offers (edit this)
  codes.json             catalogue versions for configuration codes (only add, never edit)
  assets/                baked models + scene.json (from the 3D pipeline)
  textures/pbr/          finish texture sets + manifest.json (from the 3D pipeline)
  thumbs/                option thumbnails; looks/ = look thumbnails
  sky/, brand/           sky panorama; logo and favicon
  embed.html             how to embed it, with a live example
  _source/               the code (not published):
src/main.ts           start-up, events to the embedding page, console helpers
src/configurator.ts   what is in the room, loading, applying looks, share links
src/ui.ts             areas, rail, options panel, looks, summary, calls to action
src/code.ts           configuration codes
src/pdf.ts            the PDF
src/viewer.ts, rig.ts, hotspots.ts, finishes.ts, catalogue.ts   3D view, camera, hotspots, materials, finish lists
index.html            page skeleton (the source of the built index.html)
vite.config.ts        dev server and build (+ the two dev-only save helpers)
```

The 3D pipeline and the original working folder (`03_web`, with the data under `public/`) live in the
project folder `D:\_ACTIVE\WebConfigurator`. The same code runs in both layouts.

## 12. Troubleshooting

| Problem | Cause / fix |
|---|---|
| A look card has no picture | No `thumbs/looks/<id>.jpg`: run `makeLookThumbs()` (section 4). |
| `makeLookThumbs` / `saveCodeVersion` is "not a function" | Only available under `npm run dev`, not on the built site. |
| The summary shows no code | The room uses something the last code version doesn't know: `saveCodeVersion()` (section 5). |
| "That code was not recognised" | Typo (the check character caught it) or a version missing from `codes.json`. |
| A finish doesn't appear in a list | Its texture set isn't in `manifest.json` (the console names it), or the part's family excludes its category. |
| A look sets something else than written | A value that doesn't exist falls back to the default, or a tap the vanity doesn't take is replaced by the vanity's default tap. |
| Old share link opens the default room | A slot or option was renamed; add the old name to `legacyParams` / `viewAliases`. |
| The page reloads by itself on a phone | The phone ran out of graphics memory. Phones and tablets get a low-memory mode (below); check that the new models or textures aren't much larger than the existing ones. |

**Phones and tablets (low-memory mode).** On touch screens the browser gets far less graphics
memory, and iOS Safari reloads the tab when it runs out. There, textures load at 512 px and baked
light at 1024 px (`look.lowMemoryTextureSize` / `look.lowMemoryLightmapSize` in `config.json`), and
models and finish textures that are no longer on screen are released shortly after a change.
Measured on an iPhone-sized screen: about 260 MB right after loading and about 300 MB after trying
every look, against about 600 MB and 1.2 GB (still growing) without it. Add `?mem=low` or `?mem=high`
to the address to force either mode when testing on a computer.
