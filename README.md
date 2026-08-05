# With Authority! — Rebuilt (First Playable Build)

This is a real, working build of the offline recreation — running the actual
extracted card database (1,121 real cards) through the actual script
interpreter and rules engine we built, live in a browser. No build step, no
bundler — plain ES modules, which is exactly what makes this trivial to host
on GitHub Pages.

## What this build is (and isn't)

**Is:** A live, watchable match viewer. Kane vs. Kane 2nd Edition (their two
real starter decks), playing itself out using the real card scripts, real
momentum/combat/submission/pin/DQ/count-out rules, and the real per-card
AI_PlayPage scoring — Step through it one exchange at a time, or hit Run to
watch it play out automatically. Proves the whole pipeline works end to end:
real data → real interpreter → real rules → real browser.

**Isn't yet:** Manual play (you can't choose your own moves yet — both
sides are AI-controlled), card art (stats/log only, no images wired in this
build), or a superstar/deck picker (Kane vs. Kane 2E is hardcoded for now).
Those are the natural next steps once this foundation is confirmed working
for you.

## Deploying to GitHub Pages

1. Create a new repo (or use an existing one).
2. Copy everything in this folder into the repo root (or into a `/docs`
   folder if you'd rather keep it separate from other repo contents).
3. In the repo's Settings → Pages, set the source to the branch/folder you
   used (e.g. `main` / `/docs` or `main` / `/ (root)`).
4. Wait a minute for GitHub to build it, then visit the URL GitHub gives you.

That's it — no `npm install`, no build command. It's static files serving
static files.

## Running it locally first (recommended)

Because this uses ES module imports (`import ... from './src/...'`),
opening `index.html` directly via `file://` won't work — browsers block
module imports from the local filesystem for security reasons. You need to
serve it over HTTP, even locally:

```
cd wa-site
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a browser. (Once it's actually on
GitHub Pages, this isn't a concern — it's served over real HTTP there.)

## File structure

```
index.html          — the page itself
main.js              — wires the engine to the UI
src/                 — the actual rules engine (parser, interpreter,
                        momentum, combat, submission, pins, DQ, count-out,
                        deck rules — everything built and tested this session)
data/cards.json      — all 1,121 real extracted cards
data/decks.json       — Kane's two real starter deck compositions
```

## Verified before delivery

This was actually loaded and played in a real headless browser (not just
reviewed as code) before being handed off:
- 1,121 real cards load with zero console errors
- Stepped through real exchanges: momentum plays, real moves connecting
  with real damage, a real submission hold applying and releasing
- Ran a full match to completion via auto-play: ended in a real win
  ("Kane wins by count out!")
- New Match correctly resets and re-shuffles
- Checked at real mobile viewport dimensions (390×844)
