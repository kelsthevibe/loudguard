// HopTracker: spots people bouncing between voice channels.
// Every time someone joins or switches a voice channel we record a "hop".
// Too many hops inside a short window = flagged as a channel hopper.

export class HopTracker {
  constructor() {
    this.hops = new Map(); // `${guildId}:${userId}` -> [timestamps]
    this.lastFlag = new Map(); // same key -> timestamp of last flag (cooldown)
  }

  /**
   * Record a hop. Returns {count, windowSec} if this hop crosses the limit, else null.
   */
  record(guildId, userId, { hopLimit = 5, windowSec = 120 } = {}, now = Date.now()) {
    const key = `${guildId}:${userId}`;
    const cutoff = now - windowSec * 1000;
    const list = (this.hops.get(key) ?? []).filter((t) => t >= cutoff);
    list.push(now);
    this.hops.set(key, list);

    if (list.length < hopLimit) return null;
    const last = this.lastFlag.get(key) ?? -Infinity;
    if (now - last < windowSec * 1000) return null; // already flagged this window
    this.lastFlag.set(key, now);
    return { count: list.length, windowSec };
  }

  recentHops(guildId, userId, windowSec = 120, now = Date.now()) {
    const list = this.hops.get(`${guildId}:${userId}`) ?? [];
    return list.filter((t) => t >= now - windowSec * 1000).length;
  }

  /** Drop stale entries so memory doesn't grow forever. */
  sweep(maxAgeMs = 3_600_000, now = Date.now()) {
    for (const [k, list] of this.hops) {
      const kept = list.filter((t) => t >= now - maxAgeMs);
      if (kept.length) this.hops.set(k, kept);
      else this.hops.delete(k);
    }
  }
}
