import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAssignments } from '../src/planner.js';

const all = (...ids) => new Set(ids);
const ch = (id, humans, flagged = false, joinableBy = all('main', 'w1', 'w2')) => ({ id, humans, flagged, joinableBy });
const slot = (id, channelId = null, pinned = false) => ({ id, channelId, pinned });

test('idle listeners spread over channels: flagged first, then busiest', () => {
  const plan = planAssignments(
    [slot('main'), slot('w1')],
    [ch('small', 2), ch('big', 9), ch('trouble', 1, true)],
  );
  assert.deepEqual(plan, [
    { slotId: 'main', action: 'join', channelId: 'trouble' },
    { slotId: 'w1', action: 'join', channelId: 'big' },
  ]);
});

test('listeners in occupied channels stay put', () => {
  const plan = planAssignments([slot('main', 'a'), slot('w1', 'b')], [ch('a', 3), ch('b', 1), ch('c', 20)]);
  assert.deepEqual(plan, []);
});

test('listener in an emptied channel moves to an uncovered one', () => {
  const plan = planAssignments([slot('main', 'a'), slot('w1', 'gone')], [ch('a', 3), ch('c', 4)]);
  assert.deepEqual(plan, [{ slotId: 'w1', action: 'join', channelId: 'c' }]);
});

test('extra idle listeners leave empty channels', () => {
  const plan = planAssignments([slot('main', 'a'), slot('w1', 'empty')], [ch('a', 3)]);
  assert.deepEqual(plan, [{ slotId: 'w1', action: 'leave', channelId: 'empty' }]);
});

test('flagged user in an uncovered channel steals the listener from the smallest calm channel', () => {
  const plan = planAssignments(
    [slot('main', 'big'), slot('w1', 'tiny')],
    [ch('big', 10), ch('tiny', 1), ch('trouble', 2, true)],
  );
  assert.deepEqual(plan, [{ slotId: 'w1', action: 'join', channelId: 'trouble' }]);
});

test('never steal from a channel that has its own flagged user, or a pinned listener', () => {
  const plan = planAssignments(
    [slot('main', 'a', true), slot('w1', 'b')],
    [ch('a', 1), ch('b', 1, true), ch('trouble', 2, true)],
  );
  assert.deepEqual(plan, []);
});

test('pinned listener in an empty channel stays', () => {
  assert.deepEqual(planAssignments([slot('main', 'empty', true)], [ch('x', 5)]), []);
});

test('respects which bots can join which channel', () => {
  const plan = planAssignments(
    [slot('main'), slot('w1')],
    [ch('staff', 3, false, all('main')), ch('public', 8, false, all('main', 'w1'))],
  );
  // w1 can only reach public, so it takes public and main covers staff: both channels covered
  assert.deepEqual(plan, [
    { slotId: 'w1', action: 'join', channelId: 'public' },
    { slotId: 'main', action: 'join', channelId: 'staff' },
  ]);
});
