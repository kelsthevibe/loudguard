// GuildMonitor: one "listener slot", meaning one bot account (main or worker) in one server.
// It sits in one voice channel, listens to every speaker, and runs each person's
// audio through their own LoudnessDetector. Triggers go to onTrigger. The main bot
// does the actual muting, so worker bots only need Connect permission.
import {
  joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType, getVoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import { LoudnessDetector, SAMPLE_RATE, CHANNELS } from './analyzer.js';

export class GuildMonitor {
  constructor({ id, guild, store, onTrigger, onDisconnect }) {
    this.id = id; // 'main' or 'w1', 'w2', ...
    this.guild = guild; // this bot account's view of the server
    this.store = store;
    this.onTrigger = onTrigger;
    this.onDisconnect = onDisconnect;
    this.connection = null;
    this.channelId = null;
    this.pinned = false; // true = a mod told the bot to stay here
    this.detectors = new Map(); // userId -> LoudnessDetector
    this.subs = new Map(); // userId -> {opus, pcm}
  }

  detectorFor(userId) {
    let d = this.detectors.get(userId);
    if (!d) {
      const s = this.store.settings(this.guild.id);
      d = new LoudnessDetector({ thresholdDb: s.thresholdDb, triggerMs: s.triggerMs, clipRatio: s.clipRatio });
      this.detectors.set(userId, d);
    }
    return d;
  }

  applySettings() {
    const s = this.store.settings(this.guild.id);
    for (const d of this.detectors.values()) d.configure({ thresholdDb: s.thresholdDb, triggerMs: s.triggerMs, clipRatio: s.clipRatio });
  }

  async join(channel, { pinned = false } = {}) {
    if (this.channelId === channel.id && this.connection) {
      this.pinned = pinned;
      return;
    }
    this.teardownSubs();
    this.channelId = channel.id;
    this.pinned = pinned;

    if (this.connection) {
      // Already connected in this server: just move channels.
      this.connection.rejoin({ channelId: channel.id, selfDeaf: false, selfMute: true });
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
      console.log(`[voice:${this.id}] moved to #${channel.name} (${this.guild.name})`);
      return;
    }

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false, // must be undeafened to receive audio
      selfMute: true, // the bot never talks
      daveEncryption: true,
    });

    const conn = this.connection;
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Discord sometimes briefly drops and reconnects (e.g. when we're moved)
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (this.connection === conn) this.leave();
        this.onDisconnect?.(this);
      }
    });
    conn.on('error', (e) => console.warn(`[voice ${this.guild.name}]`, e.message));

    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    conn.receiver.speaking.on('start', (userId) => this.subscribe(userId));
    console.log(`[voice:${this.id}] listening in #${channel.name} (${this.guild.name})`);
  }

  subscribe(userId) {
    if (this.subs.has(userId) || !this.connection) return;
    const member = this.guild.members.cache.get(userId);
    if (member?.user.bot) return;

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const pcm = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });
    const detector = this.detectorFor(userId);
    const channelId = this.channelId;

    const done = () => {
      if (this.subs.get(userId)?.opus === opus) this.subs.delete(userId);
      detector.silence();
      opus.unpipe(pcm);
      pcm.destroy();
    };
    opus.on('error', done);
    opus.on('end', done);
    pcm.on('error', () => {}); // a corrupt packet should never crash the bot

    pcm.on('data', (chunk) => {
      if (!this.store.settings(this.guild.id).enabled) return;
      for (const trig of detector.push(chunk)) {
        Promise.resolve(this.onTrigger(userId, channelId, trig)).catch((e) => console.warn('[punish]', e.message));
      }
    });
    opus.pipe(pcm);
    this.subs.set(userId, { opus, pcm });
  }

  teardownSubs() {
    for (const { opus, pcm } of this.subs.values()) {
      opus.destroy();
      pcm.destroy();
    }
    this.subs.clear();
    for (const d of this.detectors.values()) d.silence();
  }

  leave() {
    this.teardownSubs();
    (this.connection ?? getVoiceConnection(this.guild.id))?.destroy();
    this.connection = null;
    this.channelId = null;
    this.pinned = false;
  }

  /** Per-speaker loudness over the last 10 s — for tuning the threshold. */
  meter() {
    const out = [];
    for (const [userId, d] of this.detectors) {
      const m = d.meter();
      if (m) out.push({ userId, ...m });
    }
    return out.sort((a, b) => b.maxDb - a.maxDb);
  }
}
