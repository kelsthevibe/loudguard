// SQLite storage: per-server settings, incidents (mutes), voice movement log, flags.
// No audio is ever stored — only numbers (loudness, timestamps, channel IDs).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_SETTINGS = {
  enabled: true,
  thresholdDb: -8, // RMS dBFS a frame must hit to count as loud
  triggerMs: 1500, // loud time needed before muting
  clipRatio: 0.05, // fraction of clipped samples that counts as distorted
  muteSeconds: 30, // first offence mute length
  escalate: true, // 2nd offence 4x longer, 3rd+ -> timeout
  timeoutMinutes: 10, // timeout length for 3rd+ offence within strikeWindowMin
  strikeWindowMin: 60,
  hopLimit: 5, // channel joins/moves ...
  hopWindowSec: 120, // ... inside this many seconds = hopper flag
  autoFollow: true, // bot moves to channels where flagged users go
  logChannelId: null,
  exemptRoleId: null,
};

export class Store {
  constructor(path = 'data/loudguard.db') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (guild_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, user_id TEXT, channel_id TEXT,
        ts INTEGER, avg_db REAL, peak_db REAL, clip_ratio REAL, loud_ms INTEGER, action TEXT, mute_until INTEGER);
      CREATE INDEX IF NOT EXISTS inc_user ON incidents (guild_id, user_id, ts);
      CREATE TABLE IF NOT EXISTS voice_events (
        guild_id TEXT, user_id TEXT, from_ch TEXT, to_ch TEXT, ts INTEGER);
      CREATE INDEX IF NOT EXISTS ve_user ON voice_events (guild_id, user_id, ts);
      CREATE TABLE IF NOT EXISTS flags (
        guild_id TEXT, user_id TEXT, ts INTEGER, kind TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS fl_user ON flags (guild_id, user_id, ts);
    `);
    this.cache = new Map();
  }

  settings(guildId) {
    if (this.cache.has(guildId)) return this.cache.get(guildId);
    const row = this.db.prepare('SELECT json FROM settings WHERE guild_id = ?').get(guildId);
    const s = { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.json) : {}) };
    this.cache.set(guildId, s);
    return s;
  }

  updateSettings(guildId, patch) {
    const s = { ...this.settings(guildId), ...patch };
    this.db
      .prepare('INSERT INTO settings (guild_id, json) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET json = excluded.json')
      .run(guildId, JSON.stringify(s));
    this.cache.set(guildId, s);
    return s;
  }

  addIncident(i) {
    this.db
      .prepare(`INSERT INTO incidents (guild_id, user_id, channel_id, ts, avg_db, peak_db, clip_ratio, loud_ms, action, mute_until)
                VALUES (@guildId, @userId, @channelId, @ts, @avgDb, @peakDb, @clipRatio, @loudMs, @action, @muteUntil)`)
      .run(i);
  }

  strikes(guildId, userId, sinceMs) {
    return this.db
      .prepare('SELECT COUNT(*) AS n FROM incidents WHERE guild_id = ? AND user_id = ? AND ts >= ? AND action != ?')
      .get(guildId, userId, sinceMs, 'pardoned').n;
  }

  incidents(guildId, userId = null, limit = 10) {
    return userId
      ? this.db.prepare('SELECT * FROM incidents WHERE guild_id = ? AND user_id = ? ORDER BY ts DESC LIMIT ?').all(guildId, userId, limit)
      : this.db.prepare('SELECT * FROM incidents WHERE guild_id = ? ORDER BY ts DESC LIMIT ?').all(guildId, limit);
  }

  /** Most recent mute this bot applied (used to lift mutes that outlived a restart or a disconnect). */
  lastMute(guildId, userId) {
    return this.db
      .prepare("SELECT * FROM incidents WHERE guild_id = ? AND user_id = ? AND mute_until IS NOT NULL ORDER BY ts DESC LIMIT 1")
      .get(guildId, userId);
  }

  clearMuteUntil(id) {
    this.db.prepare('UPDATE incidents SET mute_until = NULL WHERE id = ?').run(id);
  }

  pardon(guildId, userId) {
    return this.db.prepare("UPDATE incidents SET action = 'pardoned' WHERE guild_id = ? AND user_id = ?").run(guildId, userId).changes;
  }

  logVoice(guildId, userId, fromCh, toCh, ts = Date.now()) {
    this.db.prepare('INSERT INTO voice_events VALUES (?, ?, ?, ?, ?)').run(guildId, userId, fromCh, toCh, ts);
  }

  addFlag(guildId, userId, kind, detail, ts = Date.now()) {
    this.db.prepare('INSERT INTO flags VALUES (?, ?, ?, ?, ?)').run(guildId, userId, ts, kind, detail);
  }

  /** Suspicion score over the last 24 h: each mute = 3 points, each hop flag = 1. */
  suspicion(guildId, userId, now = Date.now()) {
    const since = now - 86_400_000;
    const inc = this.db
      .prepare("SELECT COUNT(*) AS n FROM incidents WHERE guild_id = ? AND user_id = ? AND ts >= ? AND action != 'pardoned'")
      .get(guildId, userId, since).n;
    const fl = this.db.prepare('SELECT COUNT(*) AS n FROM flags WHERE guild_id = ? AND user_id = ? AND ts >= ?').get(guildId, userId, since).n;
    return inc * 3 + fl;
  }

  watchlist(guildId, limit = 10, now = Date.now()) {
    const since = now - 86_400_000;
    return this.db
      .prepare(`
        SELECT user_id, SUM(pts) AS score, SUM(mutes) AS mutes, SUM(hops) AS hops FROM (
          SELECT user_id, 3 AS pts, 1 AS mutes, 0 AS hops FROM incidents
            WHERE guild_id = ? AND ts >= ? AND action != 'pardoned'
          UNION ALL
          SELECT user_id, 1, 0, 1 FROM flags WHERE guild_id = ? AND ts >= ?
        ) GROUP BY user_id ORDER BY score DESC LIMIT ?`)
      .all(guildId, since, guildId, since, limit);
  }

  /** Last N voice moves for a user (for the /guard trail command). */
  trail(guildId, userId, limit = 15) {
    return this.db.prepare('SELECT * FROM voice_events WHERE guild_id = ? AND user_id = ? ORDER BY ts DESC LIMIT ?').all(guildId, userId, limit);
  }

  prune(days = 7) {
    const cutoff = Date.now() - days * 86_400_000;
    this.db.prepare('DELETE FROM voice_events WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM flags WHERE ts < ?').run(cutoff);
  }
}
