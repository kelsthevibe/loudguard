import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType } from 'discord.js';
import { Coordinator } from '../src/coordinator.js';
import { Store } from '../src/store.js';

// Minimal fakes: just enough of discord.js for the coordinator to plan with.
const person = (id) => [id, { id, user: { bot: false } }];
function fakeWorld(channelSpec) {
  const make = (userId) => {
    const channels = new Collection();
    for (const [id, members, joinable = true] of channelSpec) {
      channels.set(id, { id, type: ChannelType.GuildVoice, joinable, members: new Collection(members.map(person)) });
    }
    const guild = { id: 'g', name: 'Test', channels: { cache: channels } };
    return { user: { id: userId }, isReady: () => true, guilds: { cache: new Collection([['g', guild]]) } };
  };
  return { main: make('bot-main'), workers: [make('bot-w1')] };
}

function setup(spec, settings = {}) {
  const { main, workers } = fakeWorld(spec);
  const store = new Store(':memory:');
  store.updateSettings('g', settings);
  const logs = [];
  const punished = [];
  const moderator = { log: async (_g, e) => logs.push(e) };
  const coord = new Coordinator({ main, workers, store, moderator, onTrigger: async (g, u) => punished.push([g, u]) });
  // Replace real voice joins with bookkeeping
  for (const mon of coord.slotsFor('g').values()) {
    mon.join = async (vc, { pinned = false } = {}) => { mon.channelId = vc.id; mon.pinned = pinned; mon.connection = {}; };
    mon.leave = () => { mon.channelId = null; mon.pinned = false; mon.connection = null; };
  }
  return { coord, store, logs, punished, main };
}
const where = (coord) => Object.fromEntries(coord.status('g').map((s) => [s.id, s.channelId]));

test('two listeners cover the two busiest channels', async () => {
  const { coord } = setup([['a', ['u1']], ['b', ['u2', 'u3', 'u4']], ['c', ['u5', 'u6']]]);
  await coord.rebalance('g');
  assert.deepEqual(new Set(Object.values(where(coord))), new Set(['b', 'c']));
});

test('a flagged user pulls a listener and the mod log says so', async () => {
  const { coord, store, logs } = setup([['a', ['u1', 'u2', 'u3']], ['b', ['u4', 'u5']], ['c', ['troll']]]);
  store.addFlag('g', 'troll', 'hopping', 'test');
  await coord.rebalance('g');
  assert.ok(Object.values(where(coord)).includes('c'));
  assert.equal(logs.length, 1);
  assert.match(logs[0].data.description, /troll/);
});

test('auto_follow off: listeners never join on their own', async () => {
  const { coord } = setup([['a', ['u1']]], { autoFollow: false });
  await coord.rebalance('g');
  assert.deepEqual(where(coord), { main: null, w1: null });
});

test('/guard leave pauses everything until resume', async () => {
  const { coord } = setup([['a', ['u1']]]);
  await coord.rebalance('g');
  coord.leaveAll('g');
  await coord.rebalance('g');
  assert.deepEqual(where(coord), { main: null, w1: null });
  coord.paused.delete('g');
  await coord.rebalance('g');
  assert.ok(Object.values(where(coord)).includes('a'));
});

test('a worker trigger is handled through the MAIN bot', async () => {
  const { coord, punished, main } = setup([['a', ['u1']]]);
  const w1 = coord.slotsFor('g').get('w1');
  await w1.onTrigger('u1', 'a', { avgDb: -1, peakDb: 0, clipRatio: 0.5, loudMs: 1000 });
  assert.equal(punished[0][0], main.guilds.cache.get('g'));
  assert.equal(punished[0][1], 'u1');
});

test('/guard join pins main in the channel', async () => {
  const { coord } = setup([['a', ['u1']], ['b', ['u2']]]);
  const mon = await coord.join({ id: 'g' }, { id: 'b' }, { pinned: true });
  assert.equal(mon.id, 'main');
  assert.deepEqual(coord.status('g').find((s) => s.id === 'main'), { id: 'main', channelId: 'b', pinned: true });
});
