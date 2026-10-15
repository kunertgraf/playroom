# Kids' iPad Hub (Playroom)

A static, offline-capable PWA "home screen" for a kid's iPad. It hosts any number of self-contained
apps (games, stories, tools). Sister project of `../mathcraft` (same shell, separate apps).

## Tech stack
- Vanilla HTML/CSS/ES modules. No build step, no dependencies, no third-party scripts.
- Static hosting (GitHub Pages target). **All paths must be relative** so it works under a subpath.
- Service worker (`sw.js`): network-first with a 3s timeout and cache fallback, so updates arrive on the next
  launch when online, and everything works offline.
  It fetches with `cache: 'no-cache'` because GitHub Pages sends `max-age=600` (otherwise updates lag ~10 min).
- iOS resumes home-screen apps rather than reloading them, so `hub.js` reloads itself when it comes back after
  30+ s away (only while no app is open), or when leaving an app after the hub has been up 30+ min.

## Layout
- `index.html`, `hub.js`, `hub.css`: the launcher. Apps open in a full-screen iframe and the hub owns the home button.
- `apps.json`: hub title, version, and the ordered list of app folder ids.
- `apps/<id>/app.json`: `{ title, icon (emoji), color, entry = "index.html", files = [] }`.
  `files` lists extra assets to precache for offline use.
- `shared/base.css`: touch-first baseline (no zoom, selection or long-press menus) for the hub and apps.
- `shared/store.js`: per-device storage (`store.forApp(id)`: `stars/addStars/get/set`, plus `store.settings`).
  Stars are optional; the hub shows counts only when an app awards them.
- `scripts/make_icons.py`: regenerates placeholder PNG icons (iOS needs PNG for apple-touch-icon).

## Adding an app
1. Create `apps/<id>/index.html` + `apps/<id>/app.json`. Any self-contained HTML page works unmodified.
2. Add `<id>` to `apps.json`.
3. Optionally import `../../shared/base.css` and `../../shared/store.js`. To exit from inside an app:
   `parent.postMessage({ type: 'hub:exit' }, '*')`.

## Deploy
- Public repo `kunertgraf/playroom`; GitHub Pages serves `main` at https://kunertgraf.github.io/playroom/
- It shares the `kunertgraf.github.io` origin with mathcraft, so localStorage keys use the `playroom:` prefix
  and the service worker only touches `playroom-*` caches. Keep it that way.
- Pushing to `main` deploys automatically (about a minute). The iPad picks up changes on its next online launch.

## Apps
Apps here are for a 5-year-old: big touch targets, little or no reading, audio/visual feedback.
- `apps/sightwords/` — **Word Garden**, Listen & Tap sight words. The iPad says a word; she taps it among 2–4 cards
  (2 while learning, look-alike distractors once solid). Anki-style scheduling in `srs.js` (pure, Node-tested):
  learning steps → review intervals × ease, slow answers = hard, misses lapse back to learning; a capped number of
  new words per day. Each word is a plant that grows with its interval. Grown-up panel (hold ⚙ 3 s): edit/reorder
  the word list, record your own voice per word (IndexedDB, falls back to the iPad's speech voice), progress table.
  `audio.js` handles speech, recordings and sound effects. `?test` exposes `window.__words` (`setDay(offset)` time-travels).
- `apps/demo/` — minimal example of the app contract (not listed in `apps.json`).

## Commands
- Run locally: `python3 -m http.server 8932 --bind 127.0.0.1`, then open http://127.0.0.1:8932/
- Unit tests (Node 22+, no deps): `node --test`
- Regenerate icons: `python3 scripts/make_icons.py`
- After changing the shell file list in `sw.js`, bump `CACHE` there. Bump `version` in `apps.json` on releases.

## Notes
- The home-screen name comes from static `<meta apple-mobile-web-app-title>` and `manifest.webmanifest`,
  not `apps.json`. Rename in all three places.
- **Never load anything from another site** (fonts, CDNs, analytics, external links). The iPad may use a Screen Time
  "Only Allowed Websites" allowlist containing just the hub's address, so external resources would silently fail.
- The hub iframe allows `microphone` (Word Garden recordings).
- Grown-up settings open by holding the bottom-right gear for 3 seconds.
