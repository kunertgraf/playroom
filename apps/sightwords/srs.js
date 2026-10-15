// Spaced repetition for sight words, modelled on Anki (SM-2 style), with no DOM or storage
// so it can be tested in Node.
//
// A card is one word:
//   state 'learning' → must be picked correctly STEPS times in a row (within or across sessions)
//   state 'review'   → due again after `ivl` days; each on-time correct answer multiplies ivl by `ease`
// A wrong pick on a review card is a lapse: ease drops and the word goes back to learning.
// Sight words are about instant recognition, so a slow correct answer counts as "hard".

export const DEFAULT_WORDS = ['like', 'they', 'is', 'she', 'we', 'he', 'go', 'you', 'it', 'a', 'have', 'the', 'see', 'can', 'I'];

export const STEPS = 2; // correct-in-a-row picks to graduate from learning
export const SLOW_MS = 6000; // correct, but slower than this from the prompt = hard
const START_EASE = 2.5;
const MIN_EASE = 1.3;
const HARD_FACTOR = 1.2;
const LAPSE_KEEP = 0.3; // after relearning, a lapsed word comes back at 30% of its old interval

// Words are matched without case ("I" and "i" are the same card); the list keeps its own spelling.
export const keyOf = (word) => word.trim().toLowerCase();

// Local calendar day number, so "due tomorrow" flips at the family's midnight, not UTC's.
export const dayNumber = (date = new Date()) => Math.floor((date.getTime() - date.getTimezoneOffset() * 60000) / 86400000);

export function newCard(day) {
  return { state: 'learning', step: 0, ease: START_EASE, ivl: 0, due: day, lapseIvl: 1, right: 0, wrong: 0, lapses: 0, last: day };
}

export const isDue = (card, day) => card.state === 'learning' || card.due <= day;

// Garden growth: 0 not started, 1 sprout (learning), 2 leafy (<1 week), 3 tulip (1–3 weeks), 4 sunflower (3+ weeks).
export function stage(card) {
  if (!card) return 0;
  if (card.state === 'learning') return 1;
  if (card.ivl >= 21) return 4;
  if (card.ivl >= 7) return 3;
  return 2;
}

// Apply one answer. `scheduled` is false for extra practice on a review card that isn't due yet:
// a correct pick then leaves the schedule alone, but a miss still counts.
// Returns a new card; never mutates.
export function answer(card, { correct, ms = 0, day, scheduled = true }) {
  const c = { ...card, last: day };
  if (correct) c.right += 1;
  else c.wrong += 1;

  if (c.state === 'learning') {
    if (!correct) return { ...c, step: 0 };
    c.step += 1;
    if (c.step < STEPS) return c;
    return { ...c, state: 'review', step: 0, ivl: c.lapseIvl, due: day + c.lapseIvl };
  }

  if (!correct) {
    return {
      ...c,
      state: 'learning',
      step: 0,
      lapses: c.lapses + 1,
      ease: Math.max(MIN_EASE, c.ease - 0.2),
      lapseIvl: Math.max(1, Math.round(c.ivl * LAPSE_KEEP)),
      due: day,
    };
  }
  if (!scheduled || c.due > day) return c;

  const late = Math.max(0, day - c.due); // reviewed late and still remembered: credit part of the gap
  if (ms > SLOW_MS) {
    const ivl = Math.max(c.ivl + 1, Math.round((c.ivl + late / 4) * HARD_FACTOR));
    return { ...c, ease: Math.max(MIN_EASE, c.ease - 0.15), ivl, due: day + ivl };
  }
  const ivl = Math.max(c.ivl + 1, Math.round((c.ivl + late / 2) * c.ease));
  return { ...c, ivl, due: day + ivl };
}

// ---------- Choosing look-alike or different-looking distractors ----------
export function similarity(a, b) {
  a = keyOf(a);
  b = keyOf(b);
  const shared = [...new Set(a)].filter((ch) => b.includes(ch)).length;
  return shared + (a[0] === b[0] ? 2 : 0) + (a.at(-1) === b.at(-1) ? 1 : 0) - Math.abs(a.length - b.length);
}

// How many cards to show: 2 while learning, 3 for young words, 4 once a word is solid.
export function choiceCount(card, total) {
  const n = !card || card.state === 'learning' ? 2 : card.ivl < 7 ? 3 : 4;
  return Math.min(n, total);
}

export function pickChoices(target, words, card, rng = Math.random) {
  const others = words.filter((w) => keyOf(w) !== keyOf(target));
  const n = choiceCount(card, others.length + 1) - 1;
  const ranked = shuffle(others, rng).sort((x, y) => similarity(target, y) - similarity(target, x));
  // While learning, use words that look different; later, mix in the look-alikes (he/she/the, is/it).
  const easy = !card || card.state === 'learning';
  const from = easy ? ranked.slice(Math.floor(ranked.length / 2)) : ranked.slice(0, Math.max(n + 2, 4));
  const picked = shuffle(from, rng).slice(0, n);
  while (picked.length < n) picked.push(others.find((w) => !picked.includes(w)));
  return shuffle([target, ...picked], rng);
}

export function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- A play session ----------
// Builds a queue of due words (learning first, then most overdue reviews), introduces up to
// `newLeft` new words, and re-queues learning or missed words a few turns later, like Anki's
// learning steps. Once nothing is due it tops up with extra practice so a round is always `length` long.
export class Session {
  constructor({ words, cards, day, length = 10, newLeft = 3, maxLearning = 4, rng = Math.random }) {
    this.words = words;
    this.cards = { ...cards };
    this.day = day;
    this.length = length;
    this.rng = rng;
    this.asked = 0;
    this.introduced = [];
    this.seen = new Set(); // words already scheduled this session (one schedule update per word per round)
    this.last = null;

    const started = words.filter((w) => this.cards[keyOf(w)]);
    const due = started
      .filter((w) => isDue(this.cards[keyOf(w)], day))
      .sort((x, y) => this.order(x) - this.order(y));
    this.queue = due.map((word) => ({ word, kind: 'quiz' }));

    // New words go in early, each followed by its first quiz after one other turn.
    const learning = started.filter((w) => this.cards[keyOf(w)].state === 'learning').length;
    const fresh = words.filter((w) => !this.cards[keyOf(w)]).slice(0, Math.max(0, Math.min(newLeft, maxLearning - learning)));
    fresh.forEach((word, i) => {
      const at = Math.min(this.queue.length, i * 3);
      this.queue.splice(at, 0, { word, kind: 'intro' });
    });
  }

  order(w) {
    const c = this.cards[keyOf(w)];
    return c.state === 'learning' ? -1e6 + c.step : c.due - c.ivl / 100;
  }

  get done() {
    return this.asked >= this.length;
  }

  get progress() {
    return Math.min(1, this.asked / this.length);
  }

  // The next turn: { kind: 'intro', word } or { kind: 'quiz', word, choices }.
  next() {
    if (this.done) return null;
    let i = this.queue.findIndex((q) => q.word !== this.last);
    if (i < 0) {
      const extra = this.practiceWord();
      if (extra) this.queue.unshift({ word: extra, kind: 'quiz' });
      else if (!this.last) return null; // nothing started and nothing new to show
      else if (!this.queue.length) this.queue.push({ word: this.last, kind: 'quiz' }); // only one word started
      i = 0;
    }
    const item = this.queue.splice(i, 1)[0];
    this.last = item.word;
    if (item.kind === 'intro') return item;
    const card = this.cards[keyOf(item.word)];
    return { ...item, choices: pickChoices(item.word, this.words, card, this.rng) };
  }

  // Extra practice: started words not yet asked this round, soonest due first, then any other started word.
  // Never quizzes a word she hasn't been shown yet.
  practiceWord() {
    const pool = this.words.filter((w) => this.cards[keyOf(w)] && w !== this.last);
    if (!pool.length) return null;
    const unasked = pool.filter((w) => !this.seen.has(keyOf(w)));
    if (unasked.length) return unasked.sort((x, y) => this.cards[keyOf(x)].due - this.cards[keyOf(y)].due)[0];
    return pool[Math.floor(this.rng() * pool.length)];
  }

  // She looked at a new word: it becomes a learning card and gets quizzed after one other turn.
  intro(word) {
    this.cards[keyOf(word)] = newCard(this.day);
    this.introduced.push(word);
    this.requeue(word, 1);
  }

  // Record a quiz result. Returns the updated card.
  answer(word, correct, ms) {
    const k = keyOf(word);
    const before = this.cards[k];
    // Practice of a review word that isn't due (or was already scheduled this round) doesn't move it later.
    const scheduled = before.state === 'learning' || (!this.seen.has(k) && before.due <= this.day);
    const after = answer(before, { correct, ms, day: this.day, scheduled });
    this.cards[k] = after;
    this.seen.add(k);
    this.asked += 1;
    if (after.state === 'learning') this.requeue(word, correct ? 3 : 2);
    return after;
  }

  requeue(word, gap) {
    this.queue = this.queue.filter((q) => q.word !== word || q.kind === 'intro');
    this.queue.splice(Math.min(gap, this.queue.length), 0, { word, kind: 'quiz' });
  }
}
