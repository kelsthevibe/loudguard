// Moderator: decides the punishment, applies it, lifts it later, and logs everything.
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

const fmtDb = (d) => `${d.toFixed(1)} dBFS`;

export class Moderator {
  constructor(store) {
    this.store = store;
    this.timers = new Map(); // `${guildId}:${userId}` -> timeout handle
    this.inFlight = new Set();
  }

  isExempt(member, settings) {
    if (!member || member.user.bot) return true;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (settings.exemptRoleId && member.roles.cache.has(settings.exemptRoleId)) return true;
    return false;
  }

  /** Pick the action from how many strikes the user has in the strike window. */
  decide(strikeNo, s) {
    if (!s.escalate || strikeNo === 1) return { muteSec: s.muteSeconds, timeoutMin: 0, label: `muted ${s.muteSeconds}s` };
    if (strikeNo === 2) return { muteSec: s.muteSeconds * 4, timeoutMin: 0, label: `muted ${s.muteSeconds * 4}s (strike 2)` };
    return { muteSec: s.muteSeconds * 4, timeoutMin: s.timeoutMinutes, label: `timed out ${s.timeoutMinutes}m (strike ${strikeNo})` };
  }

  /** Called by the voice monitor when the detector fires. */
  async punish(guild, userId, channelId, trig) {
    const key = `${guild.id}:${userId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const s = this.store.settings(guild.id);
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member || this.isExempt(member, s)) return;

      const now = Date.now();
      const strikeNo = this.store.strikes(guild.id, userId, now - s.strikeWindowMin * 60_000) + 1;
      const act = this.decide(strikeNo, s);
      const errors = [];

      if (member.voice.channelId) {
        await member.voice.setMute(true, `LoudGuard: too loud (${fmtDb(trig.avgDb)} for ${trig.loudMs} ms)`).catch((e) => errors.push(`mute: ${e.message}`));
      }
      if (act.timeoutMin > 0) {
        await member.timeout(act.timeoutMin * 60_000, `LoudGuard: repeat loud audio (strike ${strikeNo})`).catch((e) => errors.push(`timeout: ${e.message}`));
      }

      const muteUntil = now + act.muteSec * 1000;
      this.store.addIncident({
        guildId: guild.id, userId, channelId, ts: now,
        avgDb: trig.avgDb, peakDb: trig.peakDb, clipRatio: trig.clipRatio, loudMs: trig.loudMs,
        action: errors.length ? `failed: ${act.label}` : act.label,
        muteUntil,
      });
      this.scheduleUnmute(guild, userId, act.muteSec * 1000);

      const embed = new EmbedBuilder()
        .setColor(errors.length ? 0xf0b232 : 0xed4245)
        .setTitle('🔇 Loud audio detected')
        .setDescription(`<@${userId}> in <#${channelId}>`)
        .addFields(
          { name: 'Action', value: act.label, inline: true },
          { name: 'Avg loudness', value: fmtDb(trig.avgDb), inline: true },
          { name: 'Peak', value: fmtDb(trig.peakDb), inline: true },
          { name: 'Loud for', value: `${(trig.loudMs / 1000).toFixed(1)} s`, inline: true },
          { name: 'Clipping', value: `${(trig.clipRatio * 100).toFixed(1)}%`, inline: true },
          { name: 'Strikes (window)', value: String(strikeNo), inline: true },
        )
        .setTimestamp(now);
      if (errors.length) embed.addFields({ name: '⚠️ Could not apply', value: errors.join('\n').slice(0, 1000) });
      await this.log(guild, embed);
    } finally {
      this.inFlight.delete(key);
    }
  }

  scheduleUnmute(guild, userId, ms) {
    const key = `${guild.id}:${userId}`;
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.liftIfExpired(guild, userId).catch(() => {});
    }, ms));
  }

  /**
   * Unmute the user if *our* mute has expired. Safe to call any time — on rejoin,
   * on startup, after the timer. If they're not in voice right now, Discord can't
   * unmute them, so we try again next time they join.
   */
  async liftIfExpired(guild, userId, member = null) {
    const last = this.store.lastMute(guild.id, userId);
    if (!last || last.mute_until > Date.now()) return false;
    member ??= await guild.members.fetch(userId).catch(() => null);
    if (!member?.voice.channelId) return false; // retry on next join
    if (member.voice.serverMute) {
      const ok = await member.voice.setMute(false, 'LoudGuard: mute expired').then(() => true, () => false);
      if (!ok) return false;
    }
    this.store.clearMuteUntil(last.id);
    return true;
  }

  async pardon(guild, userId) {
    const n = this.store.pardon(guild.id, userId);
    const member = await guild.members.fetch(userId).catch(() => null);
    const last = this.store.lastMute(guild.id, userId);
    if (last) this.store.clearMuteUntil(last.id);
    clearTimeout(this.timers.get(`${guild.id}:${userId}`));
    if (member?.voice.channelId && member.voice.serverMute) await member.voice.setMute(false, 'LoudGuard: pardoned').catch(() => {});
    if (member?.isCommunicationDisabled()) await member.timeout(null, 'LoudGuard: pardoned').catch(() => {});
    return n;
  }

  async log(guild, embed) {
    const id = this.store.settings(guild.id).logChannelId;
    if (!id) return;
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}
