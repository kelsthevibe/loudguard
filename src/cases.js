// CaseManager: turns detections and member reports into cases that people review.
//
//   detector fires ──► case opens ──► vote posted in the voice channel's chat
//                                 └─► report posted to the mod queue right away (🟡 unconfirmed)
//   /report        ──► case opens ──► vote posted (reporter's vote counts as the first 👍)
//                                     (mods only hear about it if the vote passes)
//
//   vote passes  ──► 🔴 confirmed: mod queue report updated (or created) + mod role pinged
//   vote says no ──► 🟢 cleared
//   time runs out ──► ⌛ expired: detector cases stay in the queue as unconfirmed
//
//   Mods click: 🔇 Mute · ⏳ Timeout · 🔌 Disconnect · ✅ Dismiss. Nothing happens to the
//   member until a human clicks.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, MessageFlags,
} from 'discord.js';
import { voteWeight, tally } from './levels.js';

const COLORS = { open: 0xf0b232, confirmed: 0xed4245, cleared: 0x57f287, expired: 0x99aab5, actioned: 0x5865f2, dismissed: 0x4f545c };
const LABELS = {
  open: '🟡 Unconfirmed: community vote running',
  confirmed: '🔴 Confirmed by the voice channel',
  cleared: '🟢 Channel says it was fine',
  expired: '⚪ Unconfirmed: not enough votes',
  actioned: '🔵 Handled',
  dismissed: '⚫ Dismissed',
};
const rel = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const NO_PINGS = { parse: [] };

export class CaseManager {
  constructor({ store, moderator, tracker }) {
    this.store = store;
    this.moderator = moderator;
    this.tracker = tracker;
  }

  // ---------- weights ----------
  weightFor(guild, member) {
    const s = this.store.settings(guild.id);
    const act = this.store.activity(guild.id, member.id);
    let roleBonus = 0;
    for (const roleId of member.roles.cache.keys()) roleBonus = Math.max(roleBonus, s.levelRoles[roleId] ?? 0);
    const w = voteWeight({
      joinedAt: member.joinedTimestamp ?? Date.now(),
      accountCreatedAt: member.user.createdTimestamp,
      level: act.level,
      roleBonus,
    }, s);
    return { ...w, level: act.level, roleBonus };
  }

  // ---------- opening cases ----------
  async fromDetector(guild, userId, channelId, trig) {
    const s = this.store.settings(guild.id);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || this.moderator.isExempt(member, s)) return null;

    const existing = this.store.activeCase(guild.id, userId);
    if (existing) {
      const c = this.store.updateCase(existing.id, {
        detector_hits: existing.detector_hits + 1,
        peak_db: Math.max(existing.peak_db ?? -100, trig.peakDb),
        avg_db: Math.max(existing.avg_db ?? -100, trig.avgDb),
        loud_ms: (existing.loud_ms ?? 0) + trig.loudMs,
      });
      await this.refreshModReport(guild, c);
      return c;
    }
    const dismissed = this.store.lastDismissed(guild.id, userId);
    if (dismissed && Date.now() - dismissed.closed_ts < 10 * 60_000) return null; // mods/channel just said it's fine

    const now = Date.now();
    let c = this.store.createCase({
      guildId: guild.id, targetId: userId, channelId, source: 'detector', reason: 'Very loud audio (auto-detected)',
      createdTs: now, expiresTs: now + s.voteMinutes * 60_000,
      detectorHits: 1, peakDb: trig.peakDb, avgDb: trig.avgDb, loudMs: trig.loudMs,
    });
    c = await this.postVote(guild, c);
    return this.refreshModReport(guild, c, { create: true });
  }

  /** Returns a message for the reporter (ephemeral). */
  async fromReport(guild, reporter, target, reason) {
    const s = this.store.settings(guild.id);
    if (target.user.bot) return "You can't report a bot.";
    if (target.id === reporter.id) return "You can't report yourself.";
    if (this.moderator.isExempt(target, s)) return "That member is staff or exempt. Contact a mod directly.";
    const vc = target.voice.channel;
    if (!vc) return `${target} isn't in a voice channel right now.`;
    if (reporter.voice.channelId !== vc.id) return `You need to be in ${vc} with them to report what's happening there.`;

    const w = this.weightFor(guild, reporter);
    if (!w.eligible) return `You can't report yet: ${w.reason}.`;

    const existing = this.store.activeCase(guild.id, target.id);
    if (existing && existing.status === 'open') {
      this.store.vote(existing.id, reporter.id, 1, w.weight);
      await this.afterVote(guild, existing.id);
      return `There's already a vote on ${target} (case #${existing.id}). Your 👍 was added, worth ×${w.weight}.`;
    }
    if (existing) return `${target} already has case #${existing.id} waiting for mods.`;

    const last = this.store.lastReportBy(guild.id, reporter.id);
    if (last && Date.now() - last.created_ts < s.reportCooldownSec * 1000) {
      return `You can report again ${rel(last.created_ts + s.reportCooldownSec * 1000)}.`;
    }

    const now = Date.now();
    let c = this.store.createCase({
      guildId: guild.id, targetId: target.id, channelId: vc.id, source: 'report', reporterId: reporter.id, reason,
      createdTs: now, expiresTs: now + s.voteMinutes * 60_000,
    });
    this.store.vote(c.id, reporter.id, 1, w.weight);
    c = await this.postVote(guild, c);
    if (!c.vote_msg_id) {
      // Couldn't post in the voice chat: go straight to mods instead
      c = this.store.updateCase(c.id, { status: 'confirmed', closed_ts: Date.now() });
      await this.refreshModReport(guild, c, { create: true, ping: true });
      return `Case #${c.id} sent straight to the mods (I couldn't post a vote in ${vc}).`;
    }
    await this.afterVote(guild, c.id);
    return `Case #${c.id} opened. People in ${vc} can now vote. Your 👍 counts ×${w.weight}.`;
  }

  // ---------- buttons ----------
  async onButton(interaction) {
    const [, kind, idStr, choice] = interaction.customId.split(':');
    const c = this.store.getCase(Number(idStr));
    if (!c || c.guild_id !== interaction.guildId) return interaction.reply({ content: 'Case not found.', flags: MessageFlags.Ephemeral });
    if (kind === 'v') return this.onVote(interaction, c, choice === 'y' ? 1 : -1);
    if (kind === 'm') return this.onModAction(interaction, c, choice);
  }

  async onVote(interaction, c, value) {
    const guild = interaction.guild;
    const member = interaction.member;
    const say = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    if (c.status !== 'open') return say('This vote is closed.');
    if (member.id === c.target_id) return say("You can't vote on your own case.");
    if (member.voice?.channelId !== c.channel_id) return say(`Only people in <#${c.channel_id}> can vote, because they're the ones who heard it.`);
    const w = this.weightFor(guild, member);
    if (!w.eligible) return say(`You can't vote yet: ${w.reason}.`);

    this.store.vote(c.id, member.id, value, w.weight);
    const updated = await this.evaluate(guild, c.id);
    await interaction.update(this.voteMessage(updated));
    const why = [`${Math.floor(w.days)} days here`, w.level ? `level ${w.level}` : null, w.roleBonus ? 'level role' : null].filter(Boolean).join(', ');
    return interaction.followUp({ content: `${value > 0 ? '👍' : '👎'} Counted. Your vote weighs **×${w.weight}** (${why}).`, flags: MessageFlags.Ephemeral });
  }

  async onModAction(interaction, c, action) {
    const guild = interaction.guild;
    const s = this.store.settings(guild.id);
    const perms = interaction.memberPermissions;
    const need = { mute: PermissionFlagsBits.MuteMembers, timeout: PermissionFlagsBits.ModerateMembers, kick: PermissionFlagsBits.MoveMembers, dismiss: PermissionFlagsBits.MuteMembers }[action];
    if (!need || !perms?.has(need)) return interaction.reply({ content: "You don't have permission for that.", flags: MessageFlags.Ephemeral });
    if (c.handled_by) return interaction.reply({ content: `Already handled by <@${c.handled_by}>: ${c.action}.`, flags: MessageFlags.Ephemeral });

    const modTag = interaction.user.username;
    const target = await guild.members.fetch(c.target_id).catch(() => null);
    let label;
    try {
      if (action === 'dismiss') {
        label = 'dismissed as a false alarm';
      } else if (!target) {
        throw new Error('they left the server');
      } else if (action === 'mute') {
        await this.moderator.muteFor(guild, target, s.modMuteMinutes * 60, { modTag, caseId: c.id, channelId: c.channel_id });
        label = `muted ${s.modMuteMinutes}m`;
      } else if (action === 'timeout') {
        await target.timeout(s.modTimeoutMinutes * 60_000, `LoudGuard case #${c.id}: ${modTag}`);
        label = `timed out ${s.modTimeoutMinutes}m`;
      } else if (action === 'kick') {
        if (!target.voice.channelId) throw new Error('they are not in voice right now');
        await target.voice.disconnect(`LoudGuard case #${c.id}: ${modTag}`);
        label = 'disconnected from voice';
      }
    } catch (e) {
      return interaction.reply({ content: `Couldn't do that: ${e.message}`, flags: MessageFlags.Ephemeral });
    }

    const wasOpen = c.status === 'open';
    const updated = this.store.updateCase(c.id, {
      status: action === 'dismiss' ? 'dismissed' : 'actioned',
      handled_by: interaction.user.id, action: `mod: ${label}`, closed_ts: Date.now(),
    });
    await interaction.update(this.modMessage(guild, updated));
    if (wasOpen) await this.editVote(guild, updated);
  }

  // ---------- state changes ----------
  async afterVote(guild, caseId) {
    const c = await this.evaluate(guild, caseId);
    await this.editVote(guild, c);
    return c;
  }

  /** Re-tally a case and handle confirm/clear transitions. Returns the fresh case. */
  async evaluate(guild, caseId) {
    let c = this.store.getCase(caseId);
    if (c.status !== 'open') return c;
    const t = tally(this.store.votes(c.id), this.store.settings(guild.id));
    if (t.state === 'confirmed') {
      c = this.store.updateCase(c.id, { status: 'confirmed', closed_ts: Date.now() });
      await this.refreshModReport(guild, c, { create: true, ping: true });
    } else if (t.state === 'cleared') {
      c = this.store.updateCase(c.id, { status: 'cleared', closed_ts: Date.now() });
      await this.refreshModReport(guild, c);
    }
    return c;
  }

  async expireDue(getGuild) {
    for (const due of this.store.dueCases()) {
      const guild = getGuild(due.guild_id);
      if (!guild) continue;
      const c = this.store.updateCase(due.id, { status: 'expired', closed_ts: Date.now() });
      await this.editVote(guild, c);
      await this.refreshModReport(guild, c); // detector cases stay visible as unconfirmed
    }
  }

  // ---------- messages ----------
  async postVote(guild, c) {
    const vc = await guild.channels.fetch(c.channel_id).catch(() => null);
    if (!vc?.isTextBased?.()) return c;
    const msg = await vc.send({ ...this.voteMessage(c), allowedMentions: NO_PINGS }).catch(() => null);
    return msg ? this.store.updateCase(c.id, { vote_ch_id: vc.id, vote_msg_id: msg.id }) : c;
  }

  async editVote(guild, c) {
    if (!c.vote_msg_id) return;
    const ch = await guild.channels.fetch(c.vote_ch_id).catch(() => null);
    const msg = await ch?.messages?.fetch(c.vote_msg_id).catch(() => null);
    await msg?.edit(this.voteMessage(c)).catch(() => {});
  }

  voteMessage(c) {
    const s = this.store.settings(c.guild_id);
    const t = tally(this.store.votes(c.id), s);
    const filled = Math.max(0, Math.min(10, Math.round((t.net / s.voteThreshold) * 10)));
    const status = {
      open: `Closes ${rel(c.expires_ts)}`,
      confirmed: '✅ **Flagged by the channel. Mods have been notified.**',
      cleared: '👍 **The channel says this was fine.**',
      expired: '⌛ Vote closed: not enough votes.',
      actioned: `🔵 Handled by a mod (${(c.action ?? '').replace('mod: ', '')}).`,
      dismissed: '⚫ A mod dismissed this.',
    }[c.status];
    const embed = new EmbedBuilder()
      .setColor(COLORS[c.status])
      .setTitle(`🗳️ Case #${c.id}: was this disruptive?`)
      .setDescription([
        `<@${c.target_id}>: ${c.reason}`,
        c.source === 'report' ? `Reported by <@${c.reporter_id}>` : '',
        '',
        `**Progress:** ${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${t.net.toFixed(1)} / ${s.voteThreshold}`,
        `👍 ${t.yesVoters} · 👎 ${t.noVoters}`,
        '',
        status,
        c.status === 'open' ? '-# Only people in this voice channel can vote. Members who have been here longer and have higher levels count more. Nothing happens until a mod reviews it.' : '',
      ].filter((l) => l !== null).join('\n'));
    const open = c.status === 'open';
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`lg:v:${c.id}:y`).setLabel('Yes, disruptive').setEmoji('👍').setStyle(ButtonStyle.Danger).setDisabled(!open),
      new ButtonBuilder().setCustomId(`lg:v:${c.id}:n`).setLabel("No, it's fine").setEmoji('👎').setStyle(ButtonStyle.Secondary).setDisabled(!open),
    );
    return { embeds: [embed], components: [row] };
  }

  modMessage(guild, c) {
    const s = this.store.settings(guild.id);
    const t = tally(this.store.votes(c.id), s);
    const embed = new EmbedBuilder()
      .setColor(COLORS[c.status])
      .setTitle(`🚩 Case #${c.id}: ${LABELS[c.status]}`)
      .setDescription(`<@${c.target_id}> in <#${c.channel_id}>`)
      .addFields(
        { name: 'Source', value: c.source === 'detector' ? '🎙️ Auto-detected loud audio' : `🙋 Reported by <@${c.reporter_id}>: ${c.reason}`, inline: false },
        ...(c.detector_hits ? [{
          name: 'Detector',
          value: `${c.detector_hits} hit${c.detector_hits > 1 ? 's' : ''} · avg ${c.avg_db?.toFixed(1)} dBFS · peak ${c.peak_db?.toFixed(1)} dBFS · ${((c.loud_ms ?? 0) / 1000).toFixed(1)}s loud`,
          inline: false,
        }] : []),
        { name: 'Community vote', value: `👍 ${t.yesVoters} (×${t.yes.toFixed(1)}) · 👎 ${t.noVoters} (×${t.no.toFixed(1)}) · net ${t.net.toFixed(1)} / ${s.voteThreshold}`, inline: false },
        { name: 'Channel hops (10 min)', value: String(this.tracker.recentHops(guild.id, c.target_id, 600)), inline: true },
        { name: 'Suspicion (24 h)', value: String(this.store.suspicion(guild.id, c.target_id)), inline: true },
        { name: 'Confirmed cases (7 d)', value: String(this.store.priorCases(guild.id, c.target_id, Date.now() - 7 * 86_400_000)), inline: true },
        ...(c.handled_by ? [{ name: 'Handled by', value: `<@${c.handled_by}>: ${c.action.replace('mod: ', '')} ${rel(c.closed_ts)}`, inline: false }] : []),
      )
      .setFooter({ text: 'Trail: /guard trail · Clear history: /guard pardon' })
      .setTimestamp(c.created_ts);
    const done = !!c.handled_by;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`lg:m:${c.id}:mute`).setLabel(`Mute ${s.modMuteMinutes}m`).setEmoji('🔇').setStyle(ButtonStyle.Danger).setDisabled(done),
      new ButtonBuilder().setCustomId(`lg:m:${c.id}:timeout`).setLabel(`Timeout ${s.modTimeoutMinutes}m`).setEmoji('⏳').setStyle(ButtonStyle.Danger).setDisabled(done),
      new ButtonBuilder().setCustomId(`lg:m:${c.id}:kick`).setLabel('Disconnect').setEmoji('🔌').setStyle(ButtonStyle.Secondary).setDisabled(done),
      new ButtonBuilder().setCustomId(`lg:m:${c.id}:dismiss`).setLabel('Dismiss').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(done),
    );
    return { embeds: [embed], components: [row] };
  }

  /** Create or update the case's mod-queue post. Report cases only get one once confirmed. */
  async refreshModReport(guild, c, { create = false, ping = false } = {}) {
    const s = this.store.settings(guild.id);
    const payload = this.modMessage(guild, c);
    if (c.mod_msg_id) {
      const ch = await guild.channels.fetch(c.mod_ch_id).catch(() => null);
      const msg = await ch?.messages?.fetch(c.mod_msg_id).catch(() => null);
      if (msg) await msg.edit(payload).catch(() => {});
      if (ping && s.modPingRoleId && ch) {
        await ch.send({ content: `<@&${s.modPingRoleId}> case #${c.id} was confirmed by the voice channel ⬆️`, allowedMentions: { roles: [s.modPingRoleId] } }).catch(() => {});
      }
      return c;
    }
    if (!create) return c;
    const chId = s.modChannelId ?? s.logChannelId;
    const ch = chId ? await guild.channels.fetch(chId).catch(() => null) : null;
    if (!ch?.isTextBased?.()) {
      console.warn(`[cases] no mod channel set in ${guild.name}. Use /guard set mod_channel`);
      return c;
    }
    const content = ping && s.modPingRoleId ? `<@&${s.modPingRoleId}>` : undefined;
    const msg = await ch.send({ ...payload, content, allowedMentions: { roles: content ? [s.modPingRoleId] : [] } }).catch(() => null);
    return msg ? this.store.updateCase(c.id, { mod_ch_id: ch.id, mod_msg_id: msg.id }) : c;
  }
}
