// Run from the repo root: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORDS, STEPS, SLOW_MS, Session, answer, newCard, stage, pickChoices, keyOf, similarity, dayNumber,
} from '../apps/sightwords/srs.js';

// Deterministic RNG so sessions are reproducible.
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

// Play a whole session, answering with `isRight(word)`.
function play(session, isRight = () => true, ms = 1500) {
  const log = [];
  for (let item = session.next(); item; item = session.next()) {
    log.push(item);
    if (item.kind === 'intro') session.intro(item.word);
    else session.answer(item.word, isRight(item.word), ms);
  }
  return log;
}

test('learning card graduates after STEPS correct picks in a row', () => {
  let c = newCard(10);
  for (let i = 0; i < STEPS - 1; i++) c = answer(c, { correct: true, day: 10 });
  assert.equal(c.state, 'learning');
  c = answer(c, { correct: true, day: 10 });
  assert.equal(c.state, 'review');
  assert.equal(c.ivl, 1);
  assert.equal(c.due, 11);
});

test('a miss while learning resets the steps', () => {
  let c = answer(newCard(0), { correct: true, day: 0 });
  c = answer(c, { correct: false, day: 0 });
  assert.equal(c.step, 0);
  assert.equal(c.state, 'learning');
});

test('on-time correct reviews grow the interval by ease', () => {
  let c = { ...newCard(0), state: 'review', ivl: 4, due: 10 };
  c = answer(c, { correct: true, day: 10 });
  assert.equal(c.ivl, 10);
  assert.equal(c.due, 20);
  assert.equal(c.ease, 2.5);
});

test('slow correct answers count as hard', () => {
  const c = answer({ ...newCard(0), state: 'review', ivl: 4, due: 10 }, { correct: true, day: 10, ms: SLOW_MS + 1 });
  assert.equal(c.ivl, 5);
  assert.ok(c.ease < 2.5);
});

test('a lapse drops ease, relearns, then returns at a fraction of the old interval', () => {
  let c = { ...newCard(0), state: 'review', ivl: 20, due: 30 };
  c = answer(c, { correct: false, day: 30 });
  assert.equal(c.state, 'learning');
  assert.equal(c.lapses, 1);
  assert.equal(c.ease, 2.3);
  for (let i = 0; i < STEPS; i++) c = answer(c, { correct: true, day: 30 });
  assert.equal(c.state, 'review');
  assert.equal(c.ivl, 6);
});

test('correct practice before the due date does not move the schedule', () => {
  const c = { ...newCard(0), state: 'review', ivl: 5, due: 20 };
  const after = answer(c, { correct: true, day: 17 });
  assert.equal(after.due, 20);
  assert.equal(after.right, 1);
});

test('garden stages follow the interval', () => {
  assert.equal(stage(undefined), 0);
  assert.equal(stage(newCard(0)), 1);
  assert.equal(stage({ state: 'review', ivl: 3 }), 2);
  assert.equal(stage({ state: 'review', ivl: 7 }), 3);
  assert.equal(stage({ state: 'review', ivl: 30 }), 4);
});

test('choices: target included once, no duplicates, size grows with mastery', () => {
  const rng = seeded(3);
  for (const word of DEFAULT_WORDS) {
    for (const card of [undefined, { state: 'review', ivl: 2 }, { state: 'review', ivl: 10 }]) {
      const ch = pickChoices(word, DEFAULT_WORDS, card, rng);
      assert.equal(ch.filter((w) => w === word).length, 1);
      assert.equal(new Set(ch.map(keyOf)).size, ch.length);
      assert.equal(ch.length, !card ? 2 : card.ivl < 7 ? 3 : 4);
    }
  }
  assert.deepEqual(pickChoices('a', ['a', 'I'], undefined, rng).sort(), ['I', 'a']);
});

test('look-alikes score higher than different-looking words', () => {
  assert.ok(similarity('he', 'she') > similarity('he', 'can'));
  assert.ok(similarity('the', 'they') > similarity('the', 'go'));
});

test('first session: introduces 3 words, quizzes only those, runs the full length', () => {
  const s = new Session({ words: DEFAULT_WORDS, cards: {}, day: 100, length: 10, newLeft: 3, rng: seeded(7) });
  const log = play(s);
  const intros = log.filter((i) => i.kind === 'intro').map((i) => i.word);
  assert.deepEqual(intros, ['like', 'they', 'is']);
  const quizzes = log.filter((i) => i.kind === 'quiz');
  assert.equal(quizzes.length, 10);
  for (const q of quizzes) {
    assert.ok(intros.includes(q.word), `quizzed unseen word ${q.word}`);
    assert.ok(q.choices.includes(q.word));
  }
  // Each word is shown before it is quizzed.
  for (const w of intros) assert.ok(log.findIndex((i) => i.word === w && i.kind === 'intro') < log.findIndex((i) => i.word === w && i.kind === 'quiz'));
  for (const w of intros) assert.equal(s.cards[keyOf(w)].state, 'review');
  // Never the same word twice in a row when another is available.
  for (let i = 1; i < quizzes.length; i++) assert.notEqual(quizzes[i].word, quizzes[i - 1].word);
});

test('a single word still makes a playable session', () => {
  const s = new Session({ words: ['go', 'see'], cards: {}, day: 0, length: 4, newLeft: 1, rng: seeded(2) });
  const log = play(s);
  assert.equal(log.filter((i) => i.kind === 'quiz').length, 4);
  assert.ok(log.every((i) => i.word === 'go'));
});

test('missed words come back in the same session', () => {
  const s = new Session({ words: DEFAULT_WORDS, cards: {}, day: 0, length: 10, newLeft: 3, rng: seeded(5) });
  let missedOnce = false;
  const log = play(s, (w) => {
    if (w === 'they' && !missedOnce) return !(missedOnce = true);
    return true;
  });
  const theyQuizzes = log.filter((i) => i.kind === 'quiz' && i.word === 'they').length;
  assert.ok(theyQuizzes >= STEPS + 1);
});

test('due reviews come first; caught-up days still give a full practice round', () => {
  const cards = {};
  DEFAULT_WORDS.forEach((w, i) => (cards[keyOf(w)] = { ...newCard(0), state: 'review', ivl: 3, due: 50 + i }));
  // Day 52: three words due (like, they, is).
  const s = new Session({ words: DEFAULT_WORDS, cards, day: 52, length: 10, newLeft: 3, rng: seeded(9) });
  const log = play(s);
  assert.deepEqual(log.slice(0, 3).map((i) => i.word).sort(), ['is', 'like', 'they']);
  assert.equal(log.length, 10);
  // Only the 3 due words moved.
  const moved = DEFAULT_WORDS.filter((w) => s.cards[keyOf(w)].due !== cards[keyOf(w)].due);
  assert.deepEqual(moved.sort(), ['is', 'like', 'they']);
});

test('new words are held back while too many are still being learned', () => {
  const cards = {};
  ['like', 'they', 'is', 'she'].forEach((w) => (cards[w] = newCard(0)));
  const s = new Session({ words: DEFAULT_WORDS, cards, day: 1, newLeft: 3, maxLearning: 4, rng: seeded(1) });
  assert.equal(s.queue.filter((q) => q.kind === 'intro').length, 0);
});

test('nothing started and no new words allowed → empty session', () => {
  const s = new Session({ words: DEFAULT_WORDS, cards: {}, day: 0, newLeft: 0 });
  assert.equal(s.next(), null);
});

test('dayNumber uses local midnight', () => {
  const a = new Date(2026, 9, 15, 0, 1);
  const b = new Date(2026, 9, 15, 23, 59);
  assert.equal(dayNumber(a), dayNumber(b));
  assert.equal(dayNumber(new Date(2026, 9, 16, 0, 1)), dayNumber(a) + 1);
});

test('long simulation: a kid who knows every word gets intervals beyond 3 weeks', () => {
  let cards = {};
  for (let day = 0; day < 60; day++) {
    const s = new Session({ words: DEFAULT_WORDS, cards, day, newLeft: 3, rng: seeded(day + 1) });
    play(s);
    cards = s.cards;
  }
  assert.equal(Object.keys(cards).length, DEFAULT_WORDS.length);
  assert.ok(Object.values(cards).every((c) => c.ivl >= 21), JSON.stringify(Object.values(cards).map((c) => c.ivl)));
});
