// Sound for Word Garden: say a word (a grown-up's recording if there is one, else the iPad's voice),
// record words from the grown-up panel, and small sound effects. Everything plays through one
// WebAudio context that is unlocked on the first tap (iOS won't play sound before a touch).
import { keyOf } from './srs.js';

let ctx = null;
export function unlock() {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
  // iOS also needs speech started from a touch once; an empty utterance does it silently.
  if (!unlock.spoke && window.speechSynthesis) {
    speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    unlock.spoke = true;
  }
}

// ---------- Recordings (IndexedDB: one audio Blob per word) ----------
const DB = 'playroom-sightwords';
let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('clips');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('clips', mode);
    const req = fn(t.objectStore('clips'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

const buffers = new Map(); // key → decoded, trimmed AudioBuffer
export const recordedKeys = () => tx('readonly', (s) => s.getAllKeys()).catch(() => []);
export async function saveClip(word, blob) {
  buffers.delete(keyOf(word));
  await tx('readwrite', (s) => s.put(blob, keyOf(word)));
}
export async function deleteClip(word) {
  buffers.delete(keyOf(word));
  await tx('readwrite', (s) => s.delete(keyOf(word)));
}

async function clipBuffer(word) {
  const k = keyOf(word);
  if (buffers.has(k)) return buffers.get(k);
  const blob = await tx('readonly', (s) => s.get(k)).catch(() => null);
  if (!blob || !ctx) return null;
  try {
    const buf = trim(await decode(await blob.arrayBuffer()));
    buffers.set(k, buf);
    return buf;
  } catch {
    return null;
  }
}

// Older Safari only has the callback form of decodeAudioData.
const decode = (data) => new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject));

// Cut the silence before and after the word, so the button tap and "stop" tap aren't heard.
function trim(buf) {
  const data = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  const gate = peak * 0.08;
  let start = 0, end = data.length - 1;
  while (start < end && Math.abs(data[start]) < gate) start++;
  while (end > start && Math.abs(data[end]) < gate) end--;
  const pad = Math.floor(buf.sampleRate * 0.08);
  start = Math.max(0, start - pad);
  end = Math.min(data.length, end + pad * 2);
  if (end - start < buf.sampleRate * 0.1) return buf;
  const out = ctx.createBuffer(buf.numberOfChannels, end - start, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(start, end), c);
  return out;
}

let recorder = null;
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = ['audio/mp4', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.done = new Promise((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: rec.mimeType || type || 'audio/mp4' }));
    };
  });
  rec.start();
  recorder = rec;
}
export async function stopRecording() {
  const rec = recorder;
  recorder = null;
  if (!rec) return null;
  rec.stop();
  return rec.done;
}

// ---------- Saying a word ----------
let current = null; // whatever is speaking now, so a new word cuts off the old one
export function stopSpeaking() {
  try {
    current?.stop?.();
  } catch {}
  current = null;
  window.speechSynthesis?.cancel();
}

// Resolves when the word has finished (or after a safety timeout).
export async function say(word) {
  stopSpeaking();
  const buf = await clipBuffer(word);
  if (buf && ctx) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    current = src;
    return new Promise((resolve) => {
      src.onended = resolve;
      src.start();
      setTimeout(resolve, buf.duration * 1000 + 300);
    });
  }
  return speak(word);
}

function speak(text) {
  const synth = window.speechSynthesis;
  if (!synth) return Promise.resolve();
  return new Promise((resolve) => {
    // The full stop gives the word a natural falling "statement" tone instead of a flat read-out.
    const u = new SpeechSynthesisUtterance(`${text}.`);
    const voice = bestVoice();
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? 'en-US';
    u.rate = prefs.rate;
    u.onend = u.onerror = resolve;
    synth.speak(u);
    setTimeout(resolve, 3000);
  });
}

// The grown-up panel can pick a voice by name and a speed; otherwise we choose the best-sounding one.
const prefs = { voice: '', rate: 0.85 };
export function setVoicePrefs({ voice = prefs.voice, rate = prefs.rate } = {}) {
  prefs.voice = voice;
  prefs.rate = rate;
  chosen = null;
}

// English voices on this device, best first. "Enhanced"/"Premium" ones appear after a grown-up downloads
// them in iPad Settings → Accessibility → Spoken Content → Voices → English.
const norm = (lang) => (lang ?? '').replace('_', '-');
const quality = (v) => (/premium/i.test(v.name) ? 2 : /enhanced/i.test(v.name) ? 1 : 0);
export function englishVoices() {
  const voices = window.speechSynthesis?.getVoices().filter((v) => norm(v.lang).startsWith('en')) ?? [];
  const score = (v) =>
    quality(v) * 4 +
    (norm(v.lang) === 'en-US' ? 3 : 0) +
    (/samantha|ava|allison|susan|nicky|zoe|evan|nathan|joelle|tom/i.test(v.name) ? 2 : 0) +
    (v.localService ? 1 : 0) -
    (/bells|boing|bubbles|cellos|wobble|jester|organ|trinoids|zarvox|whisper|bad news|good news|bahh|superstar|albert|fred|junior|ralph|grandma|grandpa|rocko/i.test(v.name) ? 20 : 0);
  return voices.map((v) => ({ v, s: score(v) })).sort((a, b) => b.s - a.s).map(({ v }) => v);
}

let chosen = null;
function bestVoice() {
  if (chosen) return chosen;
  const voices = englishVoices();
  chosen = voices.find((v) => v.name === prefs.voice) ?? voices[0] ?? null;
  return chosen;
}
export const currentVoice = () => bestVoice();
// The iPad voice only (skips any recording), for trying voices in the grown-up panel.
export function speakWith(word) {
  stopSpeaking();
  return speak(word);
}
export const voiceQuality = (v) => ['', 'Enhanced', 'Premium'][quality(v)];
const voiceListeners = new Set();
export const onVoicesChanged = (fn) => voiceListeners.add(fn);
window.speechSynthesis?.addEventListener?.('voiceschanged', () => {
  chosen = null;
  voiceListeners.forEach((fn) => fn());
});

// ---------- Sound effects ----------
function tone(freq, dur, { vol = 0.15, type = 'sine', at = 0, slide = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  yes: () => [784, 1047, 1319].forEach((f, i) => tone(f, 0.28, { at: i * 0.09, vol: 0.12 })),
  oops: () => tone(220, 0.25, { type: 'triangle', slide: 0.7, vol: 0.18 }),
  pop: () => tone(600, 0.12, { slide: 2, vol: 0.12 }),
  sparkle: () => [1319, 1568, 2093, 2637].forEach((f, i) => tone(f, 0.18, { at: i * 0.06, vol: 0.07 })),
  fanfare: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.3, { at: i * 0.14, vol: 0.12, type: 'triangle' })),
};
