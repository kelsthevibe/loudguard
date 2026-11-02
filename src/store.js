// SQLite storage: settings, cases + votes, activity (XP), incidents (mutes), voice log, flags.
// No audio is ever stored, only numbers (loudness, timestamps, IDs).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { levelFromXp } from './levels.js';

export const DEFAULT_SETTINGS = {
  enabled: true,
  mode: 'flag', // 'flag' = open a case for mods (default) · 'auto' = mute instantly (old behaviour)

  // detector
  thresholdDb: -8, // RMS dBFS a frame must hit to count as loud
  triggerMs: 1500, // loud time needed before flagging
  clipRatio: 0.05, // fraction of clipped samples that counts as distorted

  // community vote
  voteThreshold: 4, // weighted yes minus weighted no needed to confirm
  minVoters: 2, // and at least this many different people saying yes
  voteMinutes: 3, // vote stays open this long
  minTenureHours: 24, // must have been in the server this long to vote
  minAccountDays: 7, // Discord account must be this old to vote
  reportCooldownSec: 120, // per reporter
  levelRoles: {}, // { roleId: bonus } for level roles from other bots

  // mod queue
  modChannelId: null, // where cases go (falls back to logChannelId)
  modPingRoleId: null, // pinged when the community confirms a case
  modMuteMinutes: 5, // "Mute" button length
  modTimeoutMinutes: 10, // "Timeout" button length

  // auto mode only
  muteSeconds: 30,
  escalate: true,
  timeoutMinutes: 10,
  strikeWindowMin: 60,

  // tracking
  hopLimit: 5,
  hopWindowSec: 120,
  autoFollow: true,
  logChannelId: null,
  exemptRoleId: null,
};

const OPEN = "('open','confirmed')";

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

      CREATE TABLE IF NOT EXISTS cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, target_id TEXT, channel_id TEXT,
        source TEXT, reporter_id TEXT, reason TEXT,
        status TEXT DEFAULT 'open',          -- open | confirmed | cleared | expired | actioned | dismissed
        created_ts INTEGER, expires_ts INTEGER, closed_ts INTEGER,
        detector_hits INTEGER DEFAULT 0, peak_db REAL, avg_db REAL, loud_ms INTEGER,
        vote_ch_id TEXT, vote_msg_id TEXT, mod_ch_id TEXT, mod_msg_id TEXT,
        handled_by TEXT, action TEXT);
      CREATE INDEX IF NOT EXISTS case_target ON cases (guild_id, target_id, created_ts);
      CREATE TABLE IF NOT EXISTS votes (
        case_id INTEGER, voter_id TEXT, value INTEGER, weight REAL, ts INTEGER,
        PRIMARY KEY (case_id, voter_id));
      CREATE TABLE IF NOT EXISTS activity (
        guild_id TEXT, user_id TEXT, xp INTEGER DEFAULT 0, voice_ms INTEGER DEFAULT 0,
        messages INTEGER DEFAULT 0, last_msg_xp_ts INTEGER DEFAULT 0,
        PRIMARY KEY (guild_id, user_id));
    `);
    this.cache = new Map();
  }

  // ---------- settings ----------
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

  // ---------- activity / levels ----------
  activity(guildId, userId) {
    const row = this.db.prepare('SELECT * FROM activity WHERE guild_id = ? AND user_id = ?').get(guildId, userId)
      ?? { xp: 0, voice_ms: 0, messages: 0, last_msg_xp_ts: 0 };
    return { ...row, level: levelFromXp(row.xp) };
  }

  /** 1 XP per message, at most once a minute (so spamming doesn't level you up). */
  messageXp(guildId, userId, now = Date.now()) {
    const a = this.activity(guildId, userId);
    const earn = now - a.last_msg_xp_ts >= 60_000 ? 1 : 0;
    this.db.prepare(`INSERT INTO activity (guild_id, user_id, xp, messages, last_msg_xp_ts) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = xp + ?, messages = messages + 1,
      last_msg_xp_ts = CASE WHEN ? = 1 THEN ? ELSE last_msg_xp_ts END`)
      .run(guildId, userId, earn, earn ? now : 0, earn, earn, now);
  }

  /** 1 XP per full minute in voice. */
  voiceXp(guildId, userId, ms) {
    if (ms <= 0) return;
    const xp = Math.floor(ms / 60_000);
    this.db.prepare(`INSERT INTO activity (guild_id, user_id, xp, voice_ms) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = xp + ?, voice_ms = voice_ms + ?`)
      .run(guildId, userId, xp, ms, xp, ms);
  }

  // ---------- cases + votes ----------
  createCase(c) {
    const info = this.db.prepare(`INSERT INTO cases
      (guild_id, target_id, channel_id, source, reporter_id, reason, status, created_ts, expires_ts, detector_hits, peak_db, avg_db, loud_ms)
      VALUES (@guildId, @targetId, @channelId, @source, @reporterId, @reason, 'open', @createdTs, @expiresTs, @detectorHits, @peakDb, @avgDb, @loudMs)`)
      .run({ reporterId: null, reason: null, detectorHits: 0, peakDb: null, avgDb: null, loudMs: null, ...c });
    return this.getCase(info.lastInsertRowid);
  }

  getCase(id) {
    return this.db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  }

  updateCase(id, patch) {
    const cols = Object.keys(patch);
    if (!cols.length) return this.getCase(id);
    this.db.prepare(`UPDATE cases SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...patch, id });
    return this.getCase(id);
  }

  /** The case a new flag/report should merge into: open/confirmed, or still awaiting a mod. */
  activeCase(guildId, targetId) {
    return this.db.prepare(`SELECT * FROM cases WHERE guild_id = ? AND target_id = ?
      AND (status IN ${OPEN} OR (status = 'expired' AND source = 'detector' AND handled_by IS NULL AND closed_ts > ?))
      ORDER BY id DESC LIMIT 1`).get(guildId, targetId, Date.now() - 15 * 60_000);
  }

  lastDismissed(guildId, targetId) {
    return this.db.prepare("SELECT * FROM cases WHERE guild_id = ? AND target_id = ? AND status IN ('dismissed','cleared') ORDER BY closed_ts DESC LIMIT 1")
      .get(guildId, targetId);
  }

  lastReportBy(guildId, reporterId) {
    return this.db.prepare('SELECT * FROM cases WHERE guild_id = ? AND reporter_id = ? ORDER BY created_ts DESC LIMIT 1').get(guildId, reporterId);
  }

  dueCases(now = Date.now()) {
    return this.db.prepare("SELECT * FROM cases WHERE status = 'open' AND expires_ts <= ?").all(now);
  }

  listCases(guildId, { open = false, limit = 10 } = {}) {
    return open
      ? this.db.prepare(`SELECT * FROM cases WHERE guild_id = ? AND (status IN ${OPEN} OR (status = 'expired' AND source = 'detector' AND handled_by IS NULL)) ORDER BY id DESC LIMIT ?`).all(guildId, limit)
      : this.db.prepare('SELECT * FROM cases WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(guildId, limit);
  }

  priorCases(guildId, targetId, sinceMs) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM cases WHERE guild_id = ? AND target_id = ? AND created_ts >= ? AND status IN ('confirmed','actioned')")
      .get(guildId, targetId, sinceMs).n;
  }

  vote(caseId, voterId, value, weight, ts = Date.now()) {
    this.db.prepare(`INSERT INTO votes VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(case_id, voter_id) DO UPDATE SET value = excluded.value, weight = excluded.weight, ts = excluded.ts`)
      .run(caseId, voterId, value, weight, ts);
  }

  votes(caseId) {
    return this.db.prepare('SELECT * FROM votes WHERE case_id = ?').all(caseId);
  }

  // ---------- incidents (auto mode + mod button mutes) ----------
  addIncident(i) {
    this.db
      .prepare(`INSERT INTO incidents (guild_id, user_id, channel_id, ts, avg_db, peak_db, clip_ratio, loud_ms, action, mute_until)
                VALUES (@guildId, @userId, @channelId, @ts, @avgDb, @peakDb, @clipRatio, @loudMs, @action, @muteUntil)`)
      .run({ avgDb: null, peakDb: null, clipRatio: null, loudMs: null, muteUntil: null, ...i });
  }

  strikes(guildId, userId, sinceMs) {
    return this.db
      .prepare("SELECT COUNT(*) AS n FROM incidents WHERE guild_id = ? AND user_id = ? AND ts >= ? AND action != 'pardoned' AND action NOT LIKE 'mod%'")
      .get(guildId, userId, sinceMs).n;
  }

  incidents(guildId, userId = null, limit = 10) {
    return userId
      ? this.db.prepare('SELECT * FROM incidents WHERE guild_id = ? AND user_id = ? ORDER BY ts DESC LIMIT ?').all(guildId, userId, limit)
      : this.db.prepare('SELECT * FROM incidents WHERE guild_id = ? ORDER BY ts DESC LIMIT ?').all(guildId, limit);
  }

  lastMute(guildId, userId) {
    return this.db
      .prepare('SELECT * FROM incidents WHERE guild_id = ? AND user_id = ? AND mute_until IS NOT NULL ORDER BY ts DESC LIMIT 1')
      .get(guildId, userId);
  }

  clearMuteUntil(id) {
    this.db.prepare('UPDATE incidents SET mute_until = NULL WHERE id = ?').run(id);
  }

  pardon(guildId, userId) {
    const a = this.db.prepare("UPDATE incidents SET action = 'pardoned' WHERE guild_id = ? AND user_id = ?").run(guildId, userId).changes;
    const b = this.db.prepare(`UPDATE cases SET status = 'dismissed', action = 'pardoned', closed_ts = ? WHERE guild_id = ? AND target_id = ?
      AND status NOT IN ('dismissed','cleared')`).run(Date.now(), guildId, userId).changes;
    return a + b;
  }

  // ---------- tracking ----------
  logVoice(guildId, userId, fromCh, toCh, ts = Date.now()) {
    this.db.prepare('INSERT INTO voice_events VALUES (?, ?, ?, ?, ?)').run(guildId, userId, fromCh, toCh, ts);
  }

  addFlag(guildId, userId, kind, detail, ts = Date.now()) {
    this.db.prepare('INSERT INTO flags VALUES (?, ?, ?, ?, ?)').run(guildId, userId, ts, kind, detail);
  }

  /**
   * Suspicion score over the last 24 h:
   *   3 per community-confirmed or mod-actioned case, or auto-mode mute
   *   (mod-button mutes are stored as incidents too, but tagged 'mod...' so they aren't double-counted)
   *   1 per unconfirmed detector case, 1 per channel-hopping flag
   *   0 for cases mods dismissed or the community cleared
   */
  suspicion(guildId, userId, now = Date.now()) {
    return this.watchlist(guildId, 1, now, userId)[0]?.score ?? 0;
  }

  watchlist(guildId, limit = 10, now = Date.now(), onlyUser = null) {
    const since = now - 86_400_000;
    const userFilter = onlyUser ? 'WHERE user_id = @u' : '';
    return this.db.prepare(`
      SELECT user_id, SUM(pts) AS score, SUM(conf) AS confirmed, SUM(flagged) AS flagged, SUM(hops) AS hops FROM (
        SELECT user_id, 3 AS pts, 1 AS conf, 0 AS flagged, 0 AS hops FROM incidents
          WHERE guild_id = @g AND ts >= @since AND action != 'pardoned' AND action NOT LIKE 'mod%'
        UNION ALL
        SELECT target_id, 3, 1, 0, 0 FROM cases
          WHERE guild_id = @g AND created_ts >= @since AND status IN ('confirmed','actioned')
        UNION ALL
        SELECT target_id, 1, 0, 1, 0 FROM cases
          WHERE guild_id = @g AND created_ts >= @since AND source = 'detector' AND status IN ('open','expired')
        UNION ALL
        SELECT user_id, 1, 0, 0, 1 FROM flags WHERE guild_id = @g AND ts >= @since
      ) ${userFilter} GROUP BY user_id HAVING score > 0 ORDER BY score DESC LIMIT @limit`)
      .all({ g: guildId, since, limit, u: onlyUser });
  }

  trail(guildId, userId, limit = 15) {
    return this.db.prepare('SELECT * FROM voice_events WHERE guild_id = ? AND user_id = ? ORDER BY ts DESC LIMIT ?').all(guildId, userId, limit);
  }

  prune(days = 7) {
    const cutoff = Date.now() - days * 86_400_000;
    this.db.prepare('DELETE FROM voice_events WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM flags WHERE ts < ?').run(cutoff);
  }
}
