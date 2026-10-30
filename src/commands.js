// Slash commands: /guard <subcommand>. Only members with "Mute Members" see them by default.
import {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, MessageFlags,
} from 'discord.js';

export const guardCommand = new SlashCommandBuilder()
  .setName('guard')
  .setDescription('LoudGuard — auto-mute earrape and track voice trolls')
  .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)
  .setDMPermission(false)
  .addSubcommand((c) => c.setName('join').setDescription('Listen in your current voice channel')
    .addBooleanOption((o) => o.setName('stay').setDescription('Stay here instead of auto-following flagged users')))
  .addSubcommand((c) => c.setName('leave').setDescription('Stop listening and leave voice'))
  .addSubcommand((c) => c.setName('status').setDescription('Show where the bot is and current settings'))
  .addSubcommand((c) => c.setName('meter').setDescription('Loudness of each speaker over the last 10 s (for tuning)'))
  .addSubcommand((c) => c.setName('set').setDescription('Change settings')
    .addBooleanOption((o) => o.setName('enabled').setDescription('Turn auto-mute on/off'))
    .addNumberOption((o) => o.setName('threshold_db').setDescription('Loud frame threshold in dBFS (default -8; lower = stricter)').setMinValue(-30).setMaxValue(0))
    .addIntegerOption((o) => o.setName('trigger_ms').setDescription('How long loud before muting (default 1500)').setMinValue(200).setMaxValue(10000))
    .addIntegerOption((o) => o.setName('mute_seconds').setDescription('First-offence mute length (default 30)').setMinValue(5).setMaxValue(3600))
    .addBooleanOption((o) => o.setName('escalate').setDescription('Longer mutes, then timeout, for repeat offenders'))
    .addIntegerOption((o) => o.setName('timeout_minutes').setDescription('Timeout length on 3rd strike (default 10)').setMinValue(1).setMaxValue(10080))
    .addIntegerOption((o) => o.setName('hop_limit').setDescription('Channel joins that count as hopping (default 5)').setMinValue(2).setMaxValue(50))
    .addIntegerOption((o) => o.setName('hop_window_sec').setDescription('...within this many seconds (default 120)').setMinValue(10).setMaxValue(3600))
    .addBooleanOption((o) => o.setName('auto_follow').setDescription('Bot moves to channels flagged users join'))
    .addChannelOption((o) => o.setName('log_channel').setDescription('Where to post mute/flag logs').addChannelTypes(ChannelType.GuildText))
    .addRoleOption((o) => o.setName('exempt_role').setDescription('Role that is never auto-muted')))
  .addSubcommand((c) => c.setName('incidents').setDescription('Recent auto-mutes')
    .addUserOption((o) => o.setName('user').setDescription('Only this user')))
  .addSubcommand((c) => c.setName('watchlist').setDescription('Most suspicious users in the last 24 h'))
  .addSubcommand((c) => c.setName('trail').setDescription("A user's recent voice-channel movements")
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
  .addSubcommand((c) => c.setName('pardon').setDescription('Clear strikes, unmute and un-timeout a user')
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)));

const OPTION_MAP = {
  enabled: 'enabled', threshold_db: 'thresholdDb', trigger_ms: 'triggerMs', mute_seconds: 'muteSeconds',
  escalate: 'escalate', timeout_minutes: 'timeoutMinutes', hop_limit: 'hopLimit', hop_window_sec: 'hopWindowSec',
  auto_follow: 'autoFollow',
};

const ts = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const ch = (id) => (id ? `<#${id}>` : '—');

export function settingsText(s) {
  return [
    `**Auto-mute:** ${s.enabled ? 'on' : 'off'}`,
    `**Threshold:** ${s.thresholdDb} dBFS for ${s.triggerMs} ms`,
    `**Mute:** ${s.muteSeconds}s${s.escalate ? ` → ${s.muteSeconds * 4}s → ${s.timeoutMinutes}m timeout` : ''} (strikes reset after ${s.strikeWindowMin}m)`,
    `**Hopping flag:** ${s.hopLimit} joins in ${s.hopWindowSec}s`,
    `**Auto-follow:** ${s.autoFollow ? 'on' : 'off'}`,
    `**Log channel:** ${ch(s.logChannelId)}   **Exempt role:** ${s.exemptRoleId ? `<@&${s.exemptRoleId}>` : '—'}`,
  ].join('\n');
}

export async function handleGuard(interaction, ctx) {
  const { store, moderator, getMonitor } = ctx;
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
        await getMonitor(guild).join(vc, { pinned: interaction.options.getBoolean('stay') ?? false });
        return interaction.editReply(`👂 Listening in ${vc}. Audio is analysed live and never recorded.`);
      } catch (e) {
        getMonitor(guild).leave();
        return interaction.editReply(`Couldn't connect: ${e.message}. Check I have **Connect** + **View Channel** there.`);
      }
    }
    case 'leave':
      getMonitor(guild).leave();
      return reply('👋 Left voice.');
    case 'status': {
      const m = getMonitor(guild);
      return reply(`**Listening in:** ${ch(m.channelId)}${m.pinned ? ' (stay)' : ''}\n${settingsText(store.settings(guild.id))}`);
    }
    case 'meter': {
      const rows = getMonitor(guild).meter();
      if (!rows.length) return reply('No one has spoken in my channel in the last 10 s.');
      const s = store.settings(guild.id);
      const lines = rows.map((r) => `<@${r.userId}> — loudest **${r.maxDb.toFixed(1)}** dBFS, avg ${r.avgDb.toFixed(1)}${r.maxDb >= s.thresholdDb ? ' ⚠️' : ''}`);
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
      if (!Object.keys(patch).length) return reply(settingsText(store.settings(guild.id)));
      const s = store.updateSettings(guild.id, patch);
      getMonitor(guild).applySettings();
      return reply(`✅ Updated.\n${settingsText(s)}`);
    }
    case 'incidents': {
      const user = interaction.options.getUser('user');
      const rows = store.incidents(guild.id, user?.id, 10);
      if (!rows.length) return reply('No incidents yet. 🎉');
      const lines = rows.map((r) => `${ts(r.ts)} <@${r.user_id}> in ${ch(r.channel_id)} — ${r.avg_db.toFixed(1)} dBFS for ${(r.loud_ms / 1000).toFixed(1)}s → ${r.action}`);
      return reply(lines.join('\n'));
    }
    case 'watchlist': {
      const rows = store.watchlist(guild.id);
      if (!rows.length) return reply('Nobody flagged in the last 24 h.');
      const lines = rows.map((r, i) => `${i + 1}. <@${r.user_id}> — score **${r.score}** (${r.mutes} mutes, ${r.hops} hop flags)`);
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
      return reply(`🕊️ Pardoned ${user} — cleared ${n} incident(s), lifted mute/timeout.`);
    }
  }
}
