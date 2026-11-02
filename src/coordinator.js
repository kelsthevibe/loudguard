// Coordinator: owns every listener slot (main bot + worker bots) in every server and
// decides, via planAssignments, which voice channel each one sits in.
import { ChannelType, EmbedBuilder } from 'discord.js';
import { GuildMonitor } from './voice.js';
import { planAssignments } from './planner.js';

export class Coordinator {
  /**
   * @param {object} o
   * @param {import('discord.js').Client} o.main       the main bot (has Mute/Timeout perms, owns commands)
   * @param {import('discord.js').Client[]} o.workers  extra bot accounts that only listen
   */
  constructor({ main, workers = [], store, moderator, onTrigger }) {
    this.main = main;
    this.accounts = [{ id: 'main', client: main }, ...workers.map((client, i) => ({ id: `w${i + 1}`, client }))];
    this.store = store;
    this.moderator = moderator;
    // What to do when any listener hears something too loud: open a case (flag mode) or mute (auto mode)
    this.handleTrigger = onTrigger ?? ((guild, userId, channelId, trig) => moderator.punish(guild, userId, channelId, trig));
    this.slots = new Map(); // guildId -> Map(slotId -> GuildMonitor)
    this.paused = new Set(); // guilds where a mod ran /guard leave
    this.timers = new Map();
    this.chains = new Map();
  }

  ownUserIds() {
    return new Set(this.accounts.map((a) => a.client.user?.id).filter(Boolean));
  }

  /** All listener slots for a server, one per bot account that is actually in that server. */
  slotsFor(guildId) {
    let map = this.slots.get(guildId);
    if (!map) this.slots.set(guildId, (map = new Map()));
    for (const { id, client } of this.accounts) {
      const guild = client.isReady() ? client.guilds.cache.get(guildId) : null;
      if (!guild || map.has(id)) continue;
      map.set(id, new GuildMonitor({
        id,
        guild,
        store: this.store,
        onTrigger: (userId, channelId, trig) => {
          // Always act through the MAIN bot: it has the permissions and posts the messages.
          const mainGuild = this.main.guilds.cache.get(guildId);
          return mainGuild && this.handleTrigger(mainGuild, userId, channelId, trig);
        },
        onDisconnect: () => this.schedule(guildId, 2000),
      }));
    }
    return map;
  }

  /** Debounced + serialized rebalance, so a burst of joins causes one plan, not twenty. */
  schedule(guildId, delay = 750) {
    clearTimeout(this.timers.get(guildId));
    this.timers.set(guildId, setTimeout(() => {
      const prev = this.chains.get(guildId) ?? Promise.resolve();
      this.chains.set(guildId, prev.then(() => this.rebalance(guildId)).catch((e) => console.warn('[rebalance]', e.message)));
    }, delay));
  }

  async rebalance(guildId) {
    const guild = this.main.guilds.cache.get(guildId);
    if (!guild || this.paused.has(guildId)) return;
    const s = this.store.settings(guildId);
    const slots = this.slotsFor(guildId);

    const humans = (vc) => vc.members.filter((m) => !m.user.bot);
    const channels = [];
    for (const vc of guild.channels.cache.values()) {
      if (vc.type !== ChannelType.GuildVoice) continue;
      const people = humans(vc);
      if (!people.size) continue;
      const joinableBy = new Set();
      for (const [id, mon] of slots) if (mon.guild.channels.cache.get(vc.id)?.joinable) joinableBy.add(id);
      channels.push({
        id: vc.id,
        humans: people.size,
        flagged: people.some((m) => this.store.suspicion(guildId, m.id) >= 1),
        joinableBy,
      });
    }

    const view = [...slots.values()].map((m) => ({ id: m.id, channelId: m.channelId, pinned: m.pinned }));
    let actions = planAssignments(view, channels);
    // Auto-follow off or bot disabled: never join on our own, only tidy up empty channels.
    if (!s.enabled || !s.autoFollow) actions = actions.filter((a) => a.action === 'leave');

    for (const a of actions) {
      const mon = slots.get(a.slotId);
      if (a.action === 'leave') {
        mon.leave();
        continue;
      }
      const vc = mon.guild.channels.cache.get(a.channelId);
      try {
        await mon.join(vc);
        const info = channels.find((c) => c.id === a.channelId);
        if (info?.flagged) {
          const who = humans(guild.channels.cache.get(a.channelId))
            .filter((m) => this.store.suspicion(guildId, m.id) >= 1)
            .map((m) => `<@${m.id}>`).join(', ');
          await this.moderator.log(guild, new EmbedBuilder().setColor(0x5865f2)
            .setDescription(`👁️ Listener **${mon.id}** now watching <#${a.channelId}>, flagged: ${who}`));
        }
      } catch (e) {
        console.warn(`[join ${a.slotId}]`, e.message);
        mon.leave();
      }
    }
  }

  /** /guard join: put a listener in this channel and pin it if asked. */
  async join(guild, vc, { pinned = false } = {}) {
    this.paused.delete(guild.id);
    const slots = this.slotsFor(guild.id);
    const mon = [...slots.values()].find((m) => m.channelId === vc.id) ?? slots.get('main');
    await mon.join(mon.guild.channels.cache.get(vc.id), { pinned });
    this.schedule(guild.id); // other listeners may want to cover the channel main just left
    return mon;
  }

  leaveAll(guildId) {
    this.paused.add(guildId);
    for (const m of this.slotsFor(guildId).values()) m.leave();
  }

  resume(guildId) {
    this.paused.delete(guildId);
    this.schedule(guildId, 0);
  }

  /** One of OUR bots changed voice state (a mod dragged or kicked it). */
  ownVoiceState(slotId, newState) {
    const mon = this.slotsFor(newState.guild.id).get(slotId);
    if (!mon) return;
    if (!newState.channelId) {
      if (mon.channelId) mon.leave();
    } else if (newState.channelId !== mon.channelId && mon.connection) {
      mon.teardownSubs();
      mon.channelId = newState.channelId;
    }
  }

  status(guildId) {
    return [...this.slotsFor(guildId).values()].map((m) => ({ id: m.id, channelId: m.channelId, pinned: m.pinned }));
  }

  meter(guildId) {
    const rows = [...this.slotsFor(guildId).values()].flatMap((m) => m.meter().map((r) => ({ ...r, slot: m.id, channelId: m.channelId })));
    return rows.sort((a, b) => b.maxDb - a.maxDb);
  }

  applySettings(guildId) {
    for (const m of this.slotsFor(guildId).values()) m.applySettings();
    this.schedule(guildId);
  }

  shutdown() {
    for (const map of this.slots.values()) for (const m of map.values()) m.leave();
  }
}
