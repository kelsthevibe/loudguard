import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voteWeight, tally, levelFromXp } from '../src/levels.js';
import { Store } from '../src/store.js';
import { Moderator } from '../src/moderation.js';
import { HopTracker } from '../src/tracker.js';
import { CaseManager } from '../src/cases.js';

const DAY = 86_400_000;
const S = { minTenureHours: 24, minAccountDays: 7, voteThreshold: 4, minVoters: 2 };
const now = Date.now();

// ---------------- weights + tally ----------------
test('vote weight: tenure and level add up, capped at 4', () => {
  const vet = voteWeight({ joinedAt: now - 45 * DAY, accountCreatedAt: now - 900 * DAY, level: 6 }, S, now);
  assert.equal(vet.weight, 2.9); // 1 + 1 (30-180 days) + 0.9 (level 6)
  const max = voteWeight({ joinedAt: now - 400 * DAY, accountCreatedAt: now - 900 * DAY, level: 40 }, S, now);
  assert.equal(max.weight, 4);
  const role = voteWeight({ joinedAt: now - 10 * DAY, accountCreatedAt: now - 900 * DAY, level: 1, roleBonus: 1.2 }, S, now);
  assert.equal(role.weight, 2.7); // highest of level (0.15) and role (1.2) counts
});

test('vote weight: brand-new accounts and members cannot vote', () => {
  assert.equal(voteWeight({ joinedAt: now - 30 * DAY, accountCreatedAt: now - 2 * DAY }, S, now).eligible, false);
  assert.equal(voteWeight({ joinedAt: now - 3_600_000, accountCreatedAt: now - 900 * DAY }, S, now).eligible, false);
});

test('tally: one heavy voter cannot confirm alone; a channel can clear', () => {
  assert.equal(tally([{ value: 1, weight: 4 }], S).state, 'open');
  assert.equal(tally([{ value: 1, weight: 2.5 }, { value: 1, weight: 1.5 }], S).state, 'confirmed');
  assert.equal(tally([{ value: 1, weight: 4 }, { value: -1, weight: 2 }, { value: 1, weight: 1 }], S).state, 'open');
  assert.equal(tally([{ value: -1, weight: 2 }, { value: -1, weight: 2 }], S).state, 'cleared');
});

test('levels from XP, and message XP is rate-limited to 1/min', () => {
  assert.deepEqual([0, 49, 50, 200, 1250, 5000].map(levelFromXp), [0, 0, 1, 2, 5, 10]);
  const st = new Store(':memory:');
  st.messageXp('g', 'u', 1_000_000);
  st.messageXp('g', 'u', 1_010_000); // 10 s later: no XP
  st.messageXp('g', 'u', 1_070_000);
  st.voiceXp('g', 'u', 125 * 60_000);
  const a = st.activity('g', 'u');
  assert.equal(a.xp, 127);
  assert.equal(a.messages, 3);
  assert.equal(a.level, 1);
});

// ---------------- fake Discord ----------------
let nextId = 1;
function fakeChannel(id) {
  const msgs = new Map();
  const ch = {
    id, sent: [],
    isTextBased: () => true,
    send: async (p) => {
      const m = { id: `m${nextId++}`, payload: p, edit: async (p2) => { m.payload = { ...m.payload, ...p2 }; return m; } };
      msgs.set(m.id, m);
      ch.sent.push(m);
      return m;
    },
    messages: { fetch: async (mid) => msgs.get(mid) },
  };
  return ch;
}
function fakeMember(id, { days = 100, accountDays = 900, vc = 'vc1', mod = false } = {}) {
  const m = {
    id, user: { id, bot: false, username: id, createdTimestamp: now - accountDays * DAY },
    joinedTimestamp: now - days * DAY,
    roles: { cache: new Map() },
    permissions: { has: () => mod },
    muted: false, disconnected: false, timedOutMs: 0,
    voice: {
      channelId: vc, serverMute: false,
      setMute: async (v) => { m.muted = v; m.voice.serverMute = v; },
      disconnect: async () => { m.disconnected = true; m.voice.channelId = null; },
    },
    timeout: async (ms) => { m.timedOutMs = ms; },
    isCommunicationDisabled: () => false,
  };
  m.voice.channel = vc ? { id: vc, toString: () => `<#${vc}>` } : null;
  m.toString = () => `<@${id}>`;
  return m;
}
function world({ settings = {} } = {}) {
  const store = new Store(':memory:');
  store.updateSettings('g', { modChannelId: 'mods', modPingRoleId: 'modrole', ...settings });
  const channels = new Map([['vc1', fakeChannel('vc1')], ['mods', fakeChannel('mods')]]);
  const members = new Map();
  const guild = {
    id: 'g', name: 'Test',
    channels: { fetch: async (id) => channels.get(id) },
    members: { fetch: async (id) => members.get(id) ?? Promise.reject(new Error('unknown')) },
  };
  const add = (id, o) => { const m = fakeMember(id, o); members.set(id, m); return m; };
  const moderator = new Moderator(store);
  const cases = new CaseManager({ store, moderator, tracker: new HopTracker() });
  return { store, guild, channels, add, cases, vc: channels.get('vc1'), mods: channels.get('mods') };
}
function click(guild, member, customId) {
  const calls = { reply: [], update: [], followUp: [] };
  const i = {
    customId, guildId: 'g', guild, member, user: member.user,
    memberPermissions: { has: () => member.permissions.has() },
    reply: async (p) => calls.reply.push(p),
    update: async (p) => calls.update.push(p),
    followUp: async (p) => calls.followUp.push(p),
  };
  return { i, calls };
}
const trig = { avgDb: -1.5, peakDb: -0.1, clipRatio: 0.6, loudMs: 1100 };
const buttonsDisabled = (payload) => payload.components[0].components.every((b) => b.data.disabled);

// ---------------- flows ----------------
test('detector → vote in the voice chat + unconfirmed report in the mod queue (no ping yet)', async () => {
  const w = world();
  w.add('troll');
  const c = await w.cases.fromDetector(w.guild, 'troll', 'vc1', trig);
  assert.equal(c.status, 'open');
  assert.equal(w.vc.sent.length, 1, 'vote posted in voice channel chat');
  assert.equal(w.mods.sent.length, 1, 'mod report posted');
  assert.equal(w.mods.sent[0].payload.content, undefined, 'no ping for unconfirmed');
  assert.match(w.mods.sent[0].payload.embeds[0].data.title, /Unconfirmed/);
  assert.equal(w.troll?.muted ?? false, false, 'nobody is muted automatically');
});

test('repeat detections merge into the same case', async () => {
  const w = world();
  w.add('troll');
  await w.cases.fromDetector(w.guild, 'troll', 'vc1', trig);
  const c = await w.cases.fromDetector(w.guild, 'troll', 'vc1', { ...trig, peakDb: 0 });
  assert.equal(c.detector_hits, 2);
  assert.equal(w.store.listCases('g').length, 1);
  assert.equal(w.mods.sent.length, 1);
});

test('voting: outsiders, the target and new members are refused; two regulars confirm and mods get pinged', async () => {
  const w = world();
  const troll = w.add('troll');
  const outsider = w.add('outsider', { vc: 'other' });
  const newbie = w.add('newbie', { days: 0.2 });
  const vet1 = w.add('vet1', { days: 200 }); // 1 + 1.5 = 2.5
  const vet2 = w.add('vet2', { days: 40 }); //  1 + 1   = 2
  const c = await w.cases.fromDetector(w.guild, 'troll', 'vc1', trig);

  for (const [who, expect] of [[outsider, /Only people in/], [troll, /own case/], [newbie, /can't vote yet/]]) {
    const { i, calls } = click(w.guild, who, `lg:v:${c.id}:y`);
    await w.cases.onButton(i);
    assert.match(calls.reply[0].content, expect);
  }

  let r = click(w.guild, vet1, `lg:v:${c.id}:y`);
  await w.cases.onButton(r.i);
  assert.match(r.calls.followUp[0].content, /×2.5/);
  assert.equal(w.store.getCase(c.id).status, 'open');

  r = click(w.guild, vet2, `lg:v:${c.id}:y`);
  await w.cases.onButton(r.i);
  assert.equal(w.store.getCase(c.id).status, 'confirmed');
  assert.ok(buttonsDisabled(r.calls.update[0]), 'vote buttons disabled once confirmed');
  assert.match(w.mods.sent[0].payload.embeds[0].data.title, /Confirmed/);
  assert.match(w.mods.sent.at(-1).payload.content, /<@&modrole>/, 'mod role pinged');
});

test('mod buttons: only mods; Mute mutes; a second click says it is already handled', async () => {
  const w = world();
  const troll = w.add('troll');
  const pleb = w.add('pleb');
  const mod = w.add('mod', { mod: true });
  const c = await w.cases.fromDetector(w.guild, 'troll', 'vc1', trig);

  let r = click(w.guild, pleb, `lg:m:${c.id}:mute`);
  await w.cases.onButton(r.i);
  assert.match(r.calls.reply[0].content, /permission/);
  assert.equal(troll.muted, false);

  r = click(w.guild, mod, `lg:m:${c.id}:mute`);
  await w.cases.onButton(r.i);
  assert.equal(troll.muted, true);
  const done = w.store.getCase(c.id);
  assert.equal(done.status, 'actioned');
  assert.equal(done.handled_by, 'mod');
  assert.ok(buttonsDisabled(r.calls.update[0]));
  assert.ok(w.store.lastMute('g', 'troll').mute_until > Date.now(), 'mute will be lifted automatically');

  r = click(w.guild, mod, `lg:m:${c.id}:timeout`);
  await w.cases.onButton(r.i);
  assert.match(r.calls.reply[0].content, /Already handled/);
  assert.equal(troll.timedOutMs, 0);
});

test('dismiss = false alarm: no new detector case for 10 minutes, and no suspicion points', async () => {
  const w = world();
  w.add('loudlaugher');
  const mod = w.add('mod', { mod: true });
  const c = await w.cases.fromDetector(w.guild, 'loudlaugher', 'vc1', trig);
  const r = click(w.guild, mod, `lg:m:${c.id}:dismiss`);
  await w.cases.onButton(r.i);
  assert.equal(w.store.getCase(c.id).status, 'dismissed');
  assert.equal(await w.cases.fromDetector(w.guild, 'loudlaugher', 'vc1', trig), null);
  assert.equal(w.store.suspicion('g', 'loudlaugher'), 0);
});

test('/report: same channel only, vote first, mods only see it once confirmed, cooldown', async () => {
  const w = world();
  const troll = w.add('troll');
  const away = w.add('away', { vc: 'other' });
  const rep = w.add('rep', { days: 200 });
  const vet = w.add('vet', { days: 50 });

  assert.match(await w.cases.fromReport(w.guild, away, troll, 'Trolling'), /need to be in/);
  const msg = await w.cases.fromReport(w.guild, rep, troll, 'Trolling');
  assert.match(msg, /Case #\d+ opened/);
  assert.equal(w.mods.sent.length, 0, 'not sent to mods yet');

  const c = w.store.listCases('g')[0];
  const r = click(w.guild, vet, `lg:v:${c.id}:y`);
  await w.cases.onButton(r.i);
  assert.equal(w.store.getCase(c.id).status, 'confirmed'); // 2.5 (reporter) + 2 = 4.5
  assert.equal(w.mods.sent.length, 1);

  const troll2 = w.add('troll2');
  assert.match(await w.cases.fromReport(w.guild, rep, troll2, 'Trolling'), /report again/);
});

test('expiry: detector cases stay in the queue as unconfirmed, report cases quietly close', async () => {
  const w = world();
  w.add('a');
  const b = w.add('b');
  const rep = w.add('rep', { days: 200 });
  const det = await w.cases.fromDetector(w.guild, 'a', 'vc1', trig);
  await w.cases.fromReport(w.guild, rep, b, 'Other');
  const repCase = w.store.listCases('g')[0];
  for (const c of [det, repCase]) w.store.updateCase(c.id, { expires_ts: Date.now() - 1 });

  await w.cases.expireDue(() => w.guild);
  assert.equal(w.store.getCase(det.id).status, 'expired');
  assert.equal(w.store.getCase(repCase.id).status, 'expired');
  assert.match(w.mods.sent[0].payload.embeds[0].data.title, /not enough votes/);
  assert.equal(w.mods.sent.length, 1, 'expired report case never bothers mods');
  assert.equal(w.store.listCases('g', { open: true }).length, 1, 'expired detector case still awaits a mod');
});
