// Per-device store shared by the hub and all apps (same origin).
// Backed by localStorage behind a small API so it can later move to
// IndexedDB or a sync backend without touching apps.
//
// App usage (stars are optional — only apps that award them show a count):
//   import { store } from '../../shared/store.js';
//   const s = store.forApp('number-bonds');
//   s.addStars(1);
//   s.set('level', 3); s.get('level', 1);

const PREFIX = 'playroom:'; // distinct from the other hub on the same github.io origin

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: saved state is a nice-to-have, never crash an app.
  }
}

function forApp(appId) {
  const key = `app:${appId}`;
  const load = () => read(key, { stars: 0, data: {} });
  return {
    stars: () => load().stars,
    addStars(n = 1) {
      const s = load();
      s.stars += n;
      s.lastUsed = Date.now();
      write(key, s);
      return s.stars;
    },
    get: (field, fallback) => load().data[field] ?? fallback,
    set(field, value) {
      const s = load();
      s.data[field] = value;
      s.lastUsed = Date.now();
      write(key, s);
    },
  };
}

export const store = {
  forApp,
  settings: {
    get: (field, fallback) => read('settings', {})[field] ?? fallback,
    set(field, value) {
      const s = read('settings', {});
      s[field] = value;
      write('settings', s);
    },
  },
  resetAllApps() {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(PREFIX + 'app:')) localStorage.removeItem(k);
    }
  },
};

// Ask the browser not to evict our data under storage pressure.
navigator.storage?.persist?.();
