// Slash commands: /guard <subcommand>. Only members with "Mute Members" see them by default.
import {
  SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType,
  PermissionFlagsBits, ChannelType, EmbedBuilder, MessageFlags,
} from 'discord.js';
import { xpForLevel } from './levels.js';

const REASONS = [
  ['Earrape / very loud audio', 'Earrape / very loud audio'],
  ['Trolling / disrupting the channel', 'Trolling / disrupting the channel'],
  ['Harassment / slurs', 'Harassment / slurs'],
  ['Other', 'Other'],
];

/** /report: anyone can use it. */
export const reportCommand = new SlashCommandBuilder()
  .setName('report')
  .setDescription('Start a vote about someone disrupting your voice channel')
  .setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('What are they doing?')
    .addChoices(...REASONS.map(([name, value]) => ({ name, value }))));

/** Right-click a user → Apps → Report voice trolling */
export const reportContext = new ContextMenuCommandBuilder()
  .setName('Report voice trolling')
  .setType(ApplicationCommandType.User)
  .setDMPermission(false);

/** /myvote: see how much your vote counts and why. */
export const myVoteCommand = new SlashCommandBuilder()
  .setName('myvote')
  .setDescription('See how much your vote counts in LoudGuard votes')
  .setDMPermission(false);

export const guardCommand = new SlashCommandBuilder()
  .setName('guard')
  .setDescription('LoudGuard — auto-mute earrape and track voice trolls')
  .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)
  .setDMPermission(false)
  .addSubcommand((c) => c.setName('join').setDescription('Listen in your current voice channel')
    .addBooleanOption((o) => o.setName('stay').setDescription('Stay here instead of auto-following flagged users')))
  .addSubcommand((c) => c.setName('leave').setDescription('All listeners leave voice and auto-follow pauses'))
  .addSubcommand((c) => c.setName('resume').setDescription('Resume auto-follow after /guard leave'))
  .addSubcommand((c) => c.setName('status').setDescription('Show where each listener is and current settings'))
  .addSubcommand((c) => c.setName('meter').setDescription('Loudness of each speaker over the last 10 s (for tuning)'))
  .addSubcommand((c) => c.setName('set').setDescription('Change settings')
    .addBooleanOption((o) => o.setName('enabled').setDescription('Turn detection on/off'))
    .addStringOption((o) => o.setName('mode').setDescription('flag = open a case for mods (default) · auto = mute instantly')
      .addChoices({ name: 'flag (report to mods)', value: 'flag' }, { name: 'auto (mute instantly)', value: 'auto' }))
    .addChannelOption((o) => o.setName('mod_channel').setDescription('Where cases go for mods to review').addChannelTypes(ChannelType.GuildText))
    .addRoleOption((o) => o.setName('mod_ping_role').setDescription('Role pinged when the channel confirms a case'))
    .addNumberOption((o) => o.setName('vote_threshold').setDescription('Weighted votes needed to confirm (default 4)').setMinValue(1).setMaxValue(30))
    .addIntegerOption((o) => o.setName('min_voters').setDescription('Different people who must vote yes (default 2)').setMinValue(1).setMaxValue(10))
    .addIntegerOption((o) => o.setName('vote_minutes').setDescription('How long votes stay open (default 3)').setMinValue(1).setMaxValue(30))
    .addIntegerOption((o) => o.setName('min_tenure_hours').setDescription('Hours in server before someone can vote (default 24)').setMinValue(0).setMaxValue(2160))
    .addIntegerOption((o) => o.setName('min_account_days').setDescription('Account age before someone can vote (default 7)').setMinValue(0).setMaxValue(365))
    .addIntegerOption((o) => o.setName('mod_mute_minutes').setDescription('Length of the Mute button (default 5)').setMinValue(1).setMaxValue(1440))
    .addIntegerOption((o) => o.setName('mod_timeout_minutes').setDescription('Length of the Timeout button (default 10)').setMinValue(1).setMaxValue(10080))
    .addNumberOption((o) => o.setName('threshold_db').setDescription('Loud frame threshold in dBFS (default -8; lower = stricter)').setMinValue(-30).setMaxValue(0))
    .addIntegerOption((o) => o.setName('trigger_ms').setDescription('How long loud before flagging (default 1500)').setMinValue(200).setMaxValue(10000))
    .addIntegerOption((o) => o.setName('mute_seconds').setDescription('Auto mode: first mute length (default 30)').setMinValue(5).setMaxValue(3600))
    .addIntegerOption((o) => o.setName('hop_limit').setDescription('Channel joins that count as hopping (default 5)').setMinValue(2).setMaxValue(50))
    .addIntegerOption((o) => o.setName('hop_window_sec').setDescription('...within this many seconds (default 120)').setMinValue(10).setMaxValue(3600))
    .addBooleanOption((o) => o.setName('auto_follow').setDescription('Bot moves to channels flagged users join'))
    .addChannelOption((o) => o.setName('log_channel').setDescription('Where to post mute/flag logs').addChannelTypes(ChannelType.GuildText))
    .addRoleOption((o) => o.setName('exempt_role').setDescription('Role that is never flagged or reported')))
  .addSubcommand((c) => c.setName('levelrole').setDescription('Give a level role (from MEE6, Arcane, etc.) extra vote weight')
    .addRoleOption((o) => o.setName('role').setDescription('The level role').setRequired(true))
    .addNumberOption((o) => o.setName('bonus').setDescription('Extra vote weight, 0 to 1.5 (0 removes it)').setRequired(true).setMinValue(0).setMaxValue(1.5)))
  .addSubcommand((c) => c.setName('cases').setDescription('Recent cases')
    .addBooleanOption((o) => o.setName('open_only').setDescription('Only cases still waiting for a mod')))
  .addSubcommand((c) => c.setName('incidents').setDescription('Recent mutes (auto mode + mod buttons)')
    .addUserOption((o) => o.setName('user').setDescription('Only this user')))
  .addSubcommand((c) => c.setName('watchlist').setDescription('Most suspicious users in the last 24 h'))
  .addSubcommand((c) => c.setName('trail').setDescription("A user's recent voice-channel movements")
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
  .addSubcommand((c) => c.setName('pardon').setDescription('Clear strikes, unmute and un-timeout a user')
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)));

const OPTION_MAP = {
  enabled: 'enabled', mode: 'mode', threshold_db: 'thresholdDb', trigger_ms: 'triggerMs', mute_seconds: 'muteSeconds',
  hop_limit: 'hopLimit', hop_window_sec: 'hopWindowSec', auto_follow: 'autoFollow',
  vote_threshold: 'voteThreshold', min_voters: 'minVoters', vote_minutes: 'voteMinutes',
  min_tenure_hours: 'minTenureHours', min_account_days: 'minAccountDays',
  mod_mute_minutes: 'modMuteMinutes', mod_timeout_minutes: 'modTimeoutMinutes',
};

const ts = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const ch = (id) => (id ? `<#${id}>` : '—');

export function settingsText(s) {
  const roles = Object.entries(s.levelRoles ?? {}).map(([id, b]) => `<@&${id}> +${b}`).join(', ') || '—';
  return [
    `**Detection:** ${s.enabled ? 'on' : 'off'} · **Mode:** ${s.mode === 'auto' ? 'auto (mutes instantly)' : 'flag (cases go to mods)'}`,
    `**Loudness:** ${s.thresholdDb} dBFS for ${s.triggerMs} ms`,
    `**Mod queue:** ${ch(s.modChannelId ?? s.logChannelId)} · ping ${s.modPingRoleId ? `<@&${s.modPingRoleId}>` : '—'} · buttons: mute ${s.modMuteMinutes}m, timeout ${s.modTimeoutMinutes}m`,
    `**Votes:** confirm at ${s.voteThreshold} weighted (min ${s.minVoters} people) · open ${s.voteMinutes}m · voters need ${s.minTenureHours}h in server + ${s.minAccountDays}d account`,
    `**Level roles:** ${roles}`,
    `**Hopping flag:** ${s.hopLimit} joins in ${s.hopWindowSec}s · **Auto-follow:** ${s.autoFollow ? 'on' : 'off'}`,
    `**Log channel:** ${ch(s.logChannelId)} · **Exempt role:** ${s.exemptRoleId ? `<@&${s.exemptRoleId}>` : '—'}`,
    s.mode === 'auto' ? `**Auto mutes:** ${s.muteSeconds}s${s.escalate ? ` → ${s.muteSeconds * 4}s → ${s.timeoutMinutes}m timeout` : ''}` : '',
  ].filter(Boolean).join('\n');
}

/** /report, the context menu and /myvote. */
export async function handleMemberCommand(interaction, { cases, store }) {
  const guild = interaction.guild;
  const reporter = await guild.members.fetch(interaction.user.id);
  if (interaction.commandName === 'myvote') {
    const w = cases.weightFor(guild, reporter);
    const act = store.activity(guild.id, reporter.id);
    const next = xpForLevel(act.level + 1) - act.xp;
    const lines = w.eligible
      ? [
        `Your vote counts **×${w.weight}**`,
        `• base 1`,
        `• time here (${Math.floor(w.days)} days): +${w.tenurePart}`,
        `• level: +${w.levelPart.toFixed(2)} (LoudGuard level ${act.level}${w.roleBonus ? `, level role +${w.roleBonus}` : ''})`,
        '',
        `-# ${next} XP to level ${act.level + 1}. You earn XP by chatting (1/min max) and being in voice (1/min).`,
      ]
      : [`You can't vote yet: ${w.reason}.`];
    return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
  }
  const targetUser = interaction.isUserContextMenuCommand() ? interaction.targetUser : interaction.options.getUser('user', true);
  const target = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!target) return interaction.reply({ content: "That user isn't in this server.", flags: MessageFlags.Ephemeral });
  const reason = interaction.isChatInputCommand() ? (interaction.options.getString('reason') ?? 'Trolling / disrupting the channel') : 'Trolling / disrupting the channel';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return interaction.editReply(await cases.fromReport(guild, reporter, target, reason));
}

export async function handleGuard(interaction, ctx) {
  const { store, moderator, coord, cases } = ctx;
  const guild = interaction.guild;
  const sub = interaction.options.getSubcommand();
  const reply = (content, extra = {}) => interaction.reply({ content, flags: MessageFlags.Ephemeral, ...extra });

  switch (sub) {
    case 'join': {
      const member = await guild.members.fetch(interaction.user.id);
      const vc = member.voice.channel;
      if (!vc) return reply('Join a voice channel first, then run this.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const mon = await coord.join(guild, vc, { pinned: interaction.options.getBoolean('stay') ?? false });
        return interaction.editReply(`👂 Listener **${mon.id}** is in ${vc}. Audio is analysed live and never recorded.`);
      } catch (e) {
        coord.schedule(guild.id);
        return interaction.editReply(`Couldn't connect: ${e.message}. Check I have **Connect** + **View Channel** there.`);
      }
    }
    case 'leave':
      coord.leaveAll(guild.id);
      return reply('👋 All listeners left voice. Auto-follow is paused until `/guard join` or `/guard resume`.');
    case 'resume':
      coord.resume(guild.id);
      return reply('▶️ Auto-follow resumed.');
    case 'status': {
      const slots = coord.status(guild.id);
      const lines = slots.map((m) => `\`${m.id}\` → ${m.channelId ? ch(m.channelId) : '*idle*'}${m.pinned ? ' (stay)' : ''}`);
      const paused = coord.paused.has(guild.id) ? ' *(auto-follow paused)*' : '';
      return reply(`**Listeners (${slots.length})**${paused}\n${lines.join('\n')}\n\n${settingsText(store.settings(guild.id))}`);
    }
    case 'meter': {
      const rows = coord.meter(guild.id);
      if (!rows.length) return reply('No one has spoken in any watched channel in the last 10 s.');
      const s = store.settings(guild.id);
      const lines = rows.map((r) => `<@${r.userId}> in ${ch(r.channelId)}: loudest **${r.maxDb.toFixed(1)}** dBFS, avg ${r.avgDb.toFixed(1)}${r.maxDb >= s.thresholdDb ? ' ⚠️' : ''}`);
      return reply(`Threshold is **${s.thresholdDb} dBFS**.\n${lines.join('\n')}`);
    }
    case 'set': {
      const patch = {};
      for (const [opt, key] of Object.entries(OPTION_MAP)) {
        const v = interaction.options.get(opt)?.value;
        if (v !== undefined) patch[key] = v;
      }
      const logCh = interaction.options.getChannel('log_channel');
      if (logCh) patch.logChannelId = logCh.id;
      const role = interaction.options.getRole('exempt_role');
      if (role) patch.exemptRoleId = role.id;
      const modCh = interaction.options.getChannel('mod_channel');
      if (modCh) patch.modChannelId = modCh.id;
      const ping = interaction.options.getRole('mod_ping_role');
      if (ping) patch.modPingRoleId = ping.id;
      if (!Object.keys(patch).length) return reply(settingsText(store.settings(guild.id)));
      const s = store.updateSettings(guild.id, patch);
      coord.applySettings(guild.id);
      return reply(`✅ Updated.\n${settingsText(s)}`);
    }
    case 'levelrole': {
      const role = interaction.options.getRole('role', true);
      const bonus = interaction.options.getNumber('bonus', true);
      const levelRoles = { ...store.settings(guild.id).levelRoles };
      if (bonus === 0) delete levelRoles[role.id];
      else levelRoles[role.id] = bonus;
      store.updateSettings(guild.id, { levelRoles });
      return reply(bonus === 0 ? `Removed ${role}.` : `Members with ${role} now get **+${bonus}** vote weight (the highest level bonus counts, not the sum).`);
    }
    case 'cases': {
      const rows = store.listCases(guild.id, { open: interaction.options.getBoolean('open_only') ?? false, limit: 10 });
      if (!rows.length) return reply('No cases. 🎉');
      const icon = { open: '🟡', confirmed: '🔴', cleared: '🟢', expired: '⚪', actioned: '🔵', dismissed: '⚫' };
      const lines = rows.map((r) => {
        const link = r.mod_msg_id ? ` [→](https://discord.com/channels/${guild.id}/${r.mod_ch_id}/${r.mod_msg_id})` : '';
        return `${icon[r.status]} **#${r.id}** <@${r.target_id}> in ${ch(r.channel_id)} · ${r.source === 'detector' ? 'auto' : 'report'} · ${ts(r.created_ts)}${r.action ? ` · ${r.action.replace('mod: ', '')}` : ''}${link}`;
      });
      return reply(lines.join('\n'));
    }
    case 'incidents': {
      const user = interaction.options.getUser('user');
      const rows = store.incidents(guild.id, user?.id, 10);
      if (!rows.length) return reply('No incidents yet. 🎉');
      const lines = rows.map((r) => `${ts(r.ts)} <@${r.user_id}> in ${ch(r.channel_id)}${r.avg_db != null ? `: ${r.avg_db.toFixed(1)} dBFS for ${(r.loud_ms / 1000).toFixed(1)}s` : ''} → ${r.action}`);
      return reply(lines.join('\n'));
    }
    case 'watchlist': {
      const rows = store.watchlist(guild.id);
      if (!rows.length) return reply('Nobody flagged in the last 24 h.');
      const lines = rows.map((r, i) => `${i + 1}. <@${r.user_id}>: score **${r.score}** (${r.confirmed} confirmed, ${r.flagged} unconfirmed flags, ${r.hops} hop flags)`);
      return reply(`**Watchlist (24 h)**\n${lines.join('\n')}`);
    }
    case 'trail': {
      const user = interaction.options.getUser('user', true);
      const rows = store.trail(guild.id, user.id);
      if (!rows.length) return reply(`No voice movement logged for ${user}.`);
      const lines = rows.map((r) => `${ts(r.ts)} ${r.from_ch ? ch(r.from_ch) : '*(joined)*'} → ${r.to_ch ? ch(r.to_ch) : '*(left)*'}`);
      const embed = new EmbedBuilder().setTitle(`Voice trail — ${user.username}`).setDescription(lines.join('\n'))
        .setFooter({ text: `Suspicion score (24 h): ${store.suspicion(guild.id, user.id)}` });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    case 'pardon': {
      const user = interaction.options.getUser('user', true);
      const n = await moderator.pardon(guild, user.id);
      return reply(`🕊️ Pardoned ${user}: cleared ${n} record(s) and lifted any mute/timeout.`);
    }
  }
}
