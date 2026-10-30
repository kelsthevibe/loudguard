// planAssignments: decides which listener (main bot or worker bot) sits in which voice channel.
// Pure function, with no Discord objects involved, so it's easy to test.
//
// Rules, in priority order:
//   1. Pinned listeners never move (a mod put them there with /guard join).
//   2. A listener in a channel that still has people stays put (no thrashing).
//   3. Free listeners (idle, or sitting in an empty channel) cover uncovered
//      channels: channels with flagged users first, then the busiest.
//   4. If a channel with a flagged user is still uncovered and no listener is free,
//      steal one from a channel with no flagged users (the smallest such channel).
//   5. Free listeners left over in empty channels leave.
//
// slots:    [{ id, channelId|null, pinned }]
// channels: [{ id, humans, flagged, joinableBy: Set<slotId> }]   (only channels with humans > 0)
// returns:  [{ slotId, action: 'join'|'leave', channelId }]

export function planAssignments(slots, channels) {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const humansIn = (id) => byId.get(id)?.humans ?? 0;
  const flaggedIn = (id) => byId.get(id)?.flagged ?? false;

  const busy = []; // slots that keep their channel
  const free = []; // slots available for reassignment
  for (const s of slots) {
    if (s.pinned || (s.channelId && humansIn(s.channelId) > 0)) busy.push(s);
    else free.push(s);
  }

  const covered = new Set(busy.map((s) => s.channelId).filter(Boolean));
  const uncovered = channels
    .filter((c) => !covered.has(c.id))
    .sort((a, b) => (b.flagged - a.flagged) || (b.humans - a.humans));

  const actions = [];
  // Flexibility = how many uncovered channels a listener could join. Give each channel the
  // LEAST flexible listener that fits, so bots with wide access stay free for restricted channels.
  const flex = new Map(slots.map((s) => [s.id, uncovered.filter((c) => c.joinableBy.has(s.id)).length]));
  const take = (pool, channel) => {
    let best = -1;
    pool.forEach((s, i) => {
      if (channel.joinableBy.has(s.id) && (best === -1 || flex.get(s.id) < flex.get(pool[best].id))) best = i;
    });
    return best === -1 ? null : pool.splice(best, 1)[0];
  };

  for (const ch of uncovered) {
    let slot = take(free, ch);
    if (!slot && ch.flagged) {
      // steal: unpinned, current channel has no flagged users, prefer the smallest audience
      const stealable = busy
        .filter((s) => !s.pinned && !flaggedIn(s.channelId) && ch.joinableBy.has(s.id))
        .sort((a, b) => humansIn(a.channelId) - humansIn(b.channelId));
      slot = stealable[0] ?? null;
      if (slot) busy.splice(busy.indexOf(slot), 1);
    }
    if (!slot) continue;
    if (slot.channelId !== ch.id) actions.push({ slotId: slot.id, action: 'join', channelId: ch.id });
  }

  for (const s of free) {
    if (s.channelId) actions.push({ slotId: s.id, action: 'leave', channelId: s.channelId });
  }
  return actions;
}
