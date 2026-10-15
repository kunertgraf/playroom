// Word Garden: Listen & Tap sight words with Anki-style spaced repetition (srs.js).
// Views: garden (home) → round (intro / quiz turns) → end. Grown-up panel: hold the ⚙ for 3 seconds.
import { store } from '../../shared/store.js';
import { DEFAULT_WORDS, Session, keyOf, stage, dayNumber } from './srs.js';
import {
  unlock, say, stopSpeaking, sfx, recordedKeys, saveClip, deleteClip, startRecording, stopRecording,
  englishVoices, currentVoice, voiceQuality, setVoicePrefs, onVoicesChanged, speakWith,
} from './audio.js';

const save = store.forApp('sightwords');
const root = document.getElementById('app');
const HOLD_MS = 3000;
const PLANT = ['', '🌱', '🌿', '🌷', '🌻'];
const STAGE_NAME = ['Not started', 'Learning', 'Growing', 'Blooming', 'Mastered'];

let view = 'garden';
let session = null;
let turn = null; // { kind, word, choices, missed: Set, graded, startedAt, locked }
let grewThisRound = new Set();
let dayOffset = 0; // test hook: pretend it's another day

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const today = () => dayNumber() + dayOffset;
const words = () => save.get('words', DEFAULT_WORDS);
const cards = () => save.get('cards', {});
const setting = (k, d) => save.get(k, d);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function newLeftToday() {
  const n = save.get('newToday', { day: -1, count: 0 });
  return setting('newPerDay', 3) - (n.day === today() ? n.count : 0);
}

// ---------- Garden (home) ----------
function plot(word, c, { grew = false } = {}) {
  const s = stage(c);
  if (!s) return `<div class="plot soil" aria-hidden="true"><span class="mound"></span></div>`;
  return `
    <button class="plot ${grew ? 'grew' : ''}" data-action="hear" data-word="${esc(word)}">
      <span class="plant s${s}">${PLANT[s]}</span>
      <span class="sign">${esc(word)}</span>
    </button>`;
}

function gardenView() {
  const c = cards();
  const list = words();
  const grown = list.filter((w) => stage(c[keyOf(w)]) >= 3).length;
  return `
    <main class="garden-screen">
      <header class="sky">
        <span class="sun">☀️</span>
        <button class="play" data-action="play" aria-label="Play">▶</button>
        <span class="count" aria-label="${grown} flowers">🌷 ${grown}</span>
      </header>
      <section class="garden">
        ${list.length < 2 ? '<p class="note">A grown-up needs to add at least 2 words.</p>' : list.map((w) => plot(w, c[keyOf(w)])).join('')}
      </section>
      <button class="gear" id="gear" aria-label="Grown-ups: hold for 3 seconds">⚙</button>
    </main>`;
}

// ---------- A round ----------
function seeds() {
  const n = session.length;
  // A miss is graded right away, but the flower only shows once she finds the word.
  const done = session.asked - (turn?.graded && !turn.locked ? 1 : 0);
  return `<div class="seeds">${Array.from({ length: n }, (_, i) => `<span class="${i < done ? 'on' : ''}">${i < done ? '🌸' : ''}</span>`).join('')}</div>`;
}

function introView() {
  return `
    <main class="round">
      ${seeds()}
      <div class="banner">✨ New word! ✨</div>
      <div class="cards one">
        <button class="word" data-action="introTap">${esc(turn.word)}</button>
      </div>
      <button class="ear" data-action="replay" aria-label="Hear it again">🔊</button>
    </main>`;
}

function quizView() {
  return `
    <main class="round">
      ${seeds()}
      <button class="ear big" data-action="replay" aria-label="Hear it again">🔊</button>
      <div class="cards n${turn.choices.length}">
        ${turn.choices
          .map((w) => {
            const cls = turn.missed.has(w) ? 'out' : turn.hint && w === turn.word ? 'hint' : '';
            return `<button class="word ${cls}" data-action="pick" data-word="${esc(w)}">${esc(w)}</button>`;
          })
          .join('')}
      </div>
    </main>`;
}

function endView() {
  const c = cards();
  return `
    <main class="end">
      <h1 class="yay">You did it! 🎉</h1>
      <section class="garden small">
        ${words().map((w) => plot(w, c[keyOf(w)], { grew: grewThisRound.has(keyOf(w)) })).join('')}
      </section>
      <div class="end-buttons">
        <button class="round-btn home" data-action="garden" aria-label="Garden">🏡</button>
        <button class="round-btn again" data-action="play" aria-label="Play again">▶</button>
      </div>
    </main>`;
}

function show(next) {
  if (next) view = next;
  root.innerHTML = { garden: gardenView, intro: introView, quiz: quizView, end: endView }[view]();
  if (view === 'garden') wireGear();
}

function play() {
  stopSpeaking();
  const list = words();
  if (list.length < 2) return;
  session = new Session({
    words: list,
    cards: cards(),
    day: today(),
    length: setting('length', 10),
    newLeft: Math.max(0, newLeftToday()),
  });
  grewThisRound = new Set();
  nextTurn();
}

async function nextTurn() {
  const item = session.next();
  if (!item) return finish();
  turn = { ...item, missed: new Set(), graded: false, hint: false, locked: false, startedAt: 0 };
  show(item.kind === 'intro' ? 'intro' : 'quiz');
  const me = turn;
  await wait(350);
  if (turn !== me) return;
  if (item.kind === 'intro') {
    sfx.sparkle();
    await wait(500);
    if (turn === me) await say(item.word);
    await wait(500);
    if (turn === me) await say(item.word);
  } else {
    await say(item.word);
  }
  if (turn === me) me.startedAt = Date.now();
}

// Persist the session's cards after every answer, so quitting mid-round keeps progress.
function persist() {
  const before = cards();
  for (const [k, c] of Object.entries(session.cards)) {
    if (stage(c) > stage(before[k])) grewThisRound.add(k);
  }
  save.set('cards', session.cards);
}

async function introTap(btn) {
  if (turn.locked) return;
  turn.locked = true;
  btn.classList.add('right');
  sfx.yes();
  session.intro(turn.word);
  persist();
  const n = save.get('newToday', { day: -1, count: 0 });
  save.set('newToday', { day: today(), count: (n.day === today() ? n.count : 0) + 1 });
  await wait(900);
  nextTurn();
}

async function pick(btn) {
  const word = btn.dataset.word;
  if (turn.locked || turn.missed.has(word)) return;
  if (word === turn.word) {
    turn.locked = true;
    if (!turn.graded) {
      const ms = turn.startedAt ? Date.now() - turn.startedAt : 0;
      session.answer(turn.word, true, ms);
      persist();
    }
    btn.classList.add('right');
    burst(btn);
    sfx.yes();
    const seedsEl = root.querySelector('.seeds');
    if (seedsEl) seedsEl.outerHTML = seeds();
    await wait(1100);
    nextTurn();
    return;
  }
  // Wrong: the card wiggles and fades, and she hears the word again. Only the first miss counts.
  if (!turn.graded) {
    turn.graded = true;
    session.answer(turn.word, false);
    persist();
  }
  turn.missed.add(word);
  sfx.oops();
  btn.classList.add('wrong');
  const me = turn;
  await wait(450);
  if (turn !== me) return;
  // After two misses (or when only the answer is left), make the right card glow.
  if (turn.missed.size >= 2 || turn.missed.size >= turn.choices.length - 1) turn.hint = true;
  show('quiz');
  say(turn.word);
}

function finish() {
  turn = null;
  save.set('sessions', save.get('sessions', 0) + 1);
  save.addStars(1);
  show('end');
  sfx.fanfare();
  // The plants that grew pop one after another.
  root.querySelectorAll('.plot.grew').forEach((el, i) => setTimeout(() => {
    el.classList.add('pop');
    sfx.pop();
  }, 700 + i * 350));
}

// Flower petals burst out of the right card.
function burst(el) {
  const r = el.getBoundingClientRect();
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('span');
    p.className = 'petal';
    p.textContent = ['🌸', '✨', '🌼', '⭐'][i % 4];
    const a = (i / 10) * Math.PI * 2 + Math.random() * 0.5;
    const d = 110 + Math.random() * 90;
    p.style.left = `${r.left + r.width / 2}px`;
    p.style.top = `${r.top + r.height / 2}px`;
    p.style.setProperty('--dx', `${Math.cos(a) * d}px`);
    p.style.setProperty('--dy', `${Math.sin(a) * d}px`);
    document.body.append(p);
    setTimeout(() => p.remove(), 900);
  }
}

// ---------- Input ----------
root.addEventListener('pointerdown', unlock);
root.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const act = btn.dataset.action;
  if (act === 'play') play();
  else if (act === 'garden') show('garden');
  else if (act === 'hear') {
    btn.classList.remove('wiggle');
    void btn.offsetWidth;
    btn.classList.add('wiggle');
    say(btn.dataset.word);
  } else if (act === 'replay') say(turn.word);
  else if (act === 'introTap') introTap(btn);
  else if (act === 'pick') pick(btn);
});

// ---------- Grown-up panel ----------
function wireGear() {
  const gear = document.getElementById('gear');
  let timer;
  const cancel = () => {
    clearTimeout(timer);
    gear.classList.remove('holding');
  };
  gear.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    gear.classList.add('holding');
    timer = setTimeout(() => {
      cancel();
      openPanel();
    }, HOLD_MS);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) gear.addEventListener(ev, cancel);
  gear.addEventListener('contextmenu', (e) => e.preventDefault());
}

const panel = document.getElementById('panel');
let recordingWord = null;

function due(c) {
  if (!c) return '—';
  if (c.state === 'learning') return 'next round';
  const d = c.due - today();
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
}

async function renderPanel(msg = '') {
  const c = cards();
  const rec = new Set(await recordedKeys());
  const list = words();
  const sel = (name, opts, cur) =>
    `<select data-setting="${name}">${opts.map((o) => `<option value="${o}" ${o === cur ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  panel.innerHTML = `
    <form method="dialog" class="panel-inner">
      <header class="panel-head">
        <h2>Word Garden — grown-ups</h2>
        <button class="done" value="done">Done</button>
      </header>
      ${msg ? `<p class="msg">${esc(msg)}</p>` : ''}
      <p class="help">New words are introduced in this order. Tap 🎤 to record yourself saying a word
        (tap again to stop); words without a recording use the iPad's voice.</p>
      <table class="words">
        <thead><tr><th></th><th>Word</th><th>Stage</th><th>Next review</th><th>✓ / ✗</th><th>Your voice</th><th></th></tr></thead>
        <tbody>
          ${list
            .map((w, i) => {
              const k = keyOf(w), card = c[k], s = stage(card), recNow = recordingWord === k;
              return `<tr>
                <td class="pl">${PLANT[s] || '·'}</td>
                <td class="w">${esc(w)}</td>
                <td>${STAGE_NAME[s]}${card ? ` <small>(${card.state === 'review' ? `${card.ivl}d` : `step ${card.step}`})</small>` : ''}</td>
                <td>${due(card)}</td>
                <td>${card ? `${card.right} / ${card.wrong}` : ''}</td>
                <td class="voice">
                  <button type="button" class="mic ${recNow ? 'rec' : ''}" data-panel="rec" data-word="${esc(w)}">${recNow ? '■ Stop' : '🎤'}</button>
                  ${rec.has(k) ? `<button type="button" data-panel="hear" data-word="${esc(w)}">▶</button><button type="button" data-panel="unrec" data-word="${esc(w)}" aria-label="Delete recording">🗑</button>` : `<button type="button" data-panel="hear" data-word="${esc(w)}" class="tts" aria-label="Hear iPad voice">🤖</button>`}
                </td>
                <td class="ord">
                  <button type="button" data-panel="up" data-i="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button>
                  <button type="button" data-panel="remove" data-i="${i}" aria-label="Remove">✕</button>
                </td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
      <div class="add">
        <input id="new-word" placeholder="Add a word" autocomplete="off" autocapitalize="none" spellcheck="false">
        <button type="button" data-panel="add">Add</button>
      </div>
      <div class="opts">
        <label>New words per day ${sel('newPerDay', [1, 2, 3, 4, 5], setting('newPerDay', 3))}</label>
        <label>Questions per round ${sel('length', [6, 10, 15, 20], setting('length', 10))}</label>
        <span>Rounds played: ${save.get('sessions', 0)}</span>
      </div>
      <section class="voice-test">
        <h3>iPad voice</h3>
        <p class="help">Used for any word you haven't recorded. For more natural voices, download one on this iPad:
          in Settings → Accessibility, open <b>Read &amp; Speak</b> (called <b>Spoken Content</b> on older iPads) → Voices → English,
          or search Settings for "Voices". Pick a voice marked <b>Enhanced</b> or <b>Premium</b> (e.g. Ava, Zoe, Evan).
          Reopen Word Garden and it will appear here.</p>
        <div class="voice-row">
          <select id="voice-pick">${voiceOptions()}</select>
          <label>Speed <input id="voice-rate" type="range" min="0.6" max="1.1" step="0.05" value="${setting('rate', 0.85)}"></label>
          <select id="voice-word">${list.map((w) => `<option>${esc(w)}</option>`).join('')}</select>
          <button type="button" data-panel="try">▶ Try</button>
        </div>
      </section>
      <details class="danger-zone">
        <summary>Reset</summary>
        <p>Start every word over from scratch (recordings and the word list are kept).</p>
        <button type="button" class="danger" data-panel="reset">Reset progress</button>
      </details>
    </form>`;
}

function voiceOptions() {
  const voices = englishVoices();
  if (!voices.length) return '<option value="">(no voices found yet)</option>';
  const cur = currentVoice()?.name;
  return voices
    .map((v) => {
      const q = voiceQuality(v);
      return `<option value="${esc(v.name)}" ${v.name === cur ? 'selected' : ''}>${esc(v.name.replace(/\s*\((enhanced|premium|english.*)\)$/i, ''))}${q ? ` ★ ${q}` : ''} · ${esc(v.lang)}</option>`;
    })
    .join('');
}

// iOS fills in its voice list a moment after load.
onVoicesChanged(() => {
  const pick = document.getElementById('voice-pick');
  if (pick && panel.open) pick.innerHTML = voiceOptions();
});

async function openPanel() {
  stopSpeaking();
  await renderPanel();
  panel.showModal();
}

panel.addEventListener('change', (e) => {
  const s = e.target.dataset.setting;
  if (s) save.set(s, Number(e.target.value));
  if (e.target.id === 'voice-pick' || e.target.id === 'voice-rate') {
    save.set('voice', document.getElementById('voice-pick').value);
    save.set('rate', Number(document.getElementById('voice-rate').value));
    setVoicePrefs({ voice: setting('voice', ''), rate: setting('rate', 0.85) });
    tryVoice();
  }
});

// Say the chosen test word with the iPad voice (even if there's a recording for it).
function tryVoice() {
  unlock();
  speakWith(document.getElementById('voice-word')?.value ?? 'like');
}

panel.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'new-word') {
    e.preventDefault();
    addWord();
  }
});

function addWord() {
  const input = document.getElementById('new-word');
  const w = input.value.trim().replace(/\s+/g, ' ');
  if (!w) return;
  const list = words();
  if (list.some((x) => keyOf(x) === keyOf(w))) return renderPanel(`"${w}" is already on the list.`);
  save.set('words', [...list, w]);
  renderPanel().then(() => document.getElementById('new-word')?.focus());
}

panel.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-panel]');
  if (!b) return;
  unlock();
  const act = b.dataset.panel;
  const list = words();
  const i = Number(b.dataset.i);
  if (act === 'add') return addWord();
  if (act === 'try') return tryVoice();
  if (act === 'up') {
    [list[i - 1], list[i]] = [list[i], list[i - 1]];
    save.set('words', list);
  } else if (act === 'remove') {
    // Its progress is kept, so re-adding the word picks up where it left off.
    list.splice(i, 1);
    save.set('words', list);
  } else if (act === 'hear') {
    say(b.dataset.word);
    return;
  } else if (act === 'unrec') {
    await deleteClip(b.dataset.word);
  } else if (act === 'rec') {
    const k = keyOf(b.dataset.word);
    if (recordingWord === k) {
      recordingWord = null;
      const blob = await stopRecording();
      if (blob?.size) {
        await saveClip(k, blob);
        await renderPanel();
        say(b.dataset.word);
        return;
      }
    } else {
      if (recordingWord) await stopRecording();
      try {
        await startRecording();
        recordingWord = k;
      } catch {
        recordingWord = null;
        return renderPanel('The microphone is not available. Check that Safari is allowed to use it.');
      }
    }
  } else if (act === 'reset') {
    if (b.dataset.confirm !== 'yes') {
      b.dataset.confirm = 'yes';
      b.textContent = 'Tap again to reset';
      return;
    }
    save.set('cards', {});
    save.set('newToday', { day: -1, count: 0 });
  }
  renderPanel();
});

panel.addEventListener('close', async () => {
  if (recordingWord) {
    recordingWord = null;
    await stopRecording();
  }
  show('garden');
});

// ---------- Boot ----------
setVoicePrefs({ voice: setting('voice', ''), rate: setting('rate', 0.85) });
show('garden');
if (new URLSearchParams(location.search).has('test')) {
  window.__words = {
    session: () => session,
    turn: () => turn,
    show,
    play,
    openPanel,
    setDay: (offset) => (dayOffset = offset),
    tap: (word) => root.querySelector(`[data-word="${CSS.escape(word)}"], [data-action="introTap"]`)?.click(),
  };
}
