import { store } from './shared/store.js';

const $ = (id) => document.getElementById(id);
const HOLD_MS = 3000;
// iOS resumes home-screen apps instead of reloading them, so check for updates ourselves.
const AWAY_MS = 30 * 1000; // reload when coming back after this long (if no app is open)
const STALE_MS = 30 * 60 * 1000; // or when leaving an app after the hub has been up this long
const loadedAt = Date.now();

let apps = [];

// ---------- Registry ----------
// apps.json lists app folder ids; each folder carries its own app.json,
// so adding an app (game, story, drawing pad, ...) never requires touching hub code.
async function loadRegistry() {
  const registry = await fetch('apps.json').then((r) => r.json());
  document.title = registry.title;
  $('app-version').textContent = registry.version;
  const loaded = await Promise.all(
    registry.apps.map(async (id) => {
      try {
        const meta = await fetch(`apps/${id}/app.json`).then((r) => r.json());
        return { id, entry: 'index.html', files: [], icon: '✨', color: '#6c63ff', ...meta };
      } catch (err) {
        console.warn(`Skipping app "${id}": bad app.json`, err);
        return null;
      }
    }),
  );
  return loaded.filter(Boolean);
}

// ---------- Hub ----------
function renderHub() {
  const name = store.settings.get('kidName', '');
  $('greeting').textContent = name ? `Hi ${name}!` : 'Hi there!';

  const hidden = new Set(store.settings.get('hiddenApps', []));
  const visible = apps.filter((a) => !hidden.has(a.id));

  $('app-grid').replaceChildren(
    ...visible.map((app) => {
      const stars = store.forApp(app.id).stars();
      const tile = document.createElement('button');
      tile.className = 'tile';
      tile.style.setProperty('--tile', app.color);
      tile.innerHTML = `
        <span class="tile-icon"></span>
        <span class="tile-title"></span>
        ${stars ? `<span class="tile-stars"><span class="star">★</span> ${stars}</span>` : ''}`;
      tile.querySelector('.tile-icon').textContent = app.icon;
      tile.querySelector('.tile-title').textContent = app.title;
      tile.addEventListener('click', () => openApp(app));
      return tile;
    }),
  );
  $('empty').hidden = visible.length > 0;

  // Stars are optional; only show the total once some app has awarded any.
  const total = apps.reduce((sum, a) => sum + store.forApp(a.id).stars(), 0);
  $('star-total').textContent = total;
  $('star-pill').hidden = total === 0;
}

// ---------- Player ----------
function openApp(app) {
  $('app-frame').src = `apps/${app.id}/${app.entry}`;
  $('player').hidden = false;
}

function closeApp() {
  // Been open a long time? Come home to a fresh page so updates show up.
  if (Date.now() - loadedAt > STALE_MS) return location.reload();
  $('player').hidden = true;
  $('app-frame').src = 'about:blank'; // stop any audio/timers in the app
  renderHub();
}

$('home-btn').addEventListener('click', closeApp);

// Apps may also ask to exit: parent.postMessage({ type: 'hub:exit' }, '*')
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data?.type === 'hub:exit') closeApp();
});

// ---------- Parent gate: hold the gear for 3 seconds ----------
const parentBtn = $('parent-btn');
let holdTimer;

function startHold(e) {
  e.preventDefault();
  parentBtn.classList.add('holding');
  holdTimer = setTimeout(() => {
    cancelHold();
    openSettings();
  }, HOLD_MS);
}

function cancelHold() {
  clearTimeout(holdTimer);
  parentBtn.classList.remove('holding');
}

parentBtn.addEventListener('pointerdown', startHold);
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) parentBtn.addEventListener(ev, cancelHold);
parentBtn.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- Settings ----------
function openSettings() {
  $('kid-name').value = store.settings.get('kidName', '');

  const hidden = new Set(store.settings.get('hiddenApps', []));
  $('app-toggles').replaceChildren(
    ...apps.map((app) => {
      const label = document.createElement('label');
      label.className = 'toggle';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !hidden.has(app.id);
      box.dataset.id = app.id;
      label.append(box, `${app.icon} ${app.title}`);
      return label;
    }),
  );

  $('reset-confirm').hidden = true;
  $('settings').showModal();
}

$('settings').addEventListener('close', () => {
  store.settings.set('kidName', $('kid-name').value.trim());
  const hiddenIds = [...$('app-toggles').querySelectorAll('input:not(:checked)')].map((b) => b.dataset.id);
  store.settings.set('hiddenApps', hiddenIds);
  renderHub();
});

$('reset-btn').addEventListener('click', () => {
  if ($('reset-confirm').hidden) {
    $('reset-confirm').hidden = false;
    return;
  }
  store.resetAllApps();
  $('reset-confirm').hidden = true;
  $('reset-confirm').closest('details').open = false;
});

// ---------- Offline support ----------
async function setupOffline() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  // Warm the cache with every app so they all work offline, not just ones already opened.
  const urls = apps.flatMap((app) => {
    const base = `apps/${app.id}/`;
    return [base + 'app.json', base + app.entry, ...app.files.map((f) => base + f)];
  });
  (reg.active ?? navigator.serviceWorker.controller)?.postMessage({ type: 'precache', urls });
}

// ---------- Freshness on resume ----------
let hiddenAt = 0;
function onResume() {
  navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  // Don't yank an app away mid-game; those refresh on the way home (closeApp).
  if ($('player').hidden && (away > AWAY_MS || Date.now() - loadedAt > STALE_MS)) location.reload();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else onResume();
});
// Restored from the back/forward cache (also how iOS can resume a standalone app).
window.addEventListener('pageshow', (e) => {
  if (e.persisted) onResume();
});

// ---------- Boot ----------
apps = await loadRegistry();
renderHub();
setupOffline().catch((err) => console.warn('Offline setup failed', err));
