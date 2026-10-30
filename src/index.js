// LoudGuard entry point: wires Discord events to the detector, tracker and moderator.
import 'dotenv/config';
import { Client, GatewayIntentBits, Events, EmbedBuilder, ChannelType, REST, Routes, MessageFlags } from 'discord.js';
import { Store } from './store.js';
import { Moderator } from './moderation.js';
import { HopTracker } from './tracker.js';
import { GuildMonitor } from './voice.js';
import { guardCommand, handleGuard } from './commands.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, DB_PATH } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env — see README.md');
  process.exit(1);
}

const store = new Store(DB_PATH || 'data/loudguard.db');
const moderator = new Moderator(store);
const tracker = new HopTracker();
const monitors = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

function getMonitor(guild) {
  let m = monitors.get(guild.id);
  if (!m) {
    m = new GuildMonitor({ guild, store, moderator, onDisconnect: () => setTimeout(() => goIdle(guild), 2000) });
    monitors.set(guild.id, m);
  }
  return m;
}

const humans = (vc) => vc?.members.filter((m) => !m.user.bot) ?? new Map();
const hasFlagged = (vc) => [...humans(vc).values()].some((m) => store.suspicion(vc.guild.id, m.id) >= 1);

/** When the bot's channel empties (or it has none), sit in the busiest channel — flagged users first. */
async function goIdle(guild) {
  const s = store.settings(guild.id);
  const mon = getMonitor(guild);
  const current = mon.channelId ? guild.channels.cache.get(mon.channelId) : null;
  if (current && humans(current).size > 0) return;
  if (mon.pinned && current) return;
  if (!s.enabled || !s.autoFollow) {
    if (current) mon.leave();
    return;
  }
  const candidates = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildVoice && humans(c).size > 0 && c.joinable)
    .sort((a, b) => (hasFlagged(b) - hasFlagged(a)) || (humans(b).size - humans(a).size));
  const target = candidates.first();
  if (!target) return mon.leave();
  await mon.join(target).catch((e) => { console.warn('[idle join]', e.message); mon.leave(); });
}

/** A flagged user just entered a channel: go listen there unless we're already watching someone flagged. */
async function maybeFollow(guild, member, channel) {
  const s = store.settings(guild.id);
  if (!s.enabled || !s.autoFollow || !channel.joinable) return;
  if (store.suspicion(guild.id, member.id) < 1) return;
  const mon = getMonitor(guild);
  if (mon.channelId === channel.id || mon.pinned) return;
  const current = mon.channelId ? guild.channels.cache.get(mon.channelId) : null;
  if (current && hasFlagged(current) && humans(current).size > 0) return;
  try {
    await mon.join(channel);
    await moderator.log(guild, new EmbedBuilder().setColor(0x5865f2)
      .setDescription(`👁️ Following flagged user <@${member.id}> into ${channel} (score ${store.suspicion(guild.id, member.id)})`));
  } catch (e) {
    console.warn('[follow]', e.message);
    mon.leave();
  }
}

client.on(Events.VoiceStateUpdate, async (oldS, newS) => {
  const guild = newS.guild;
  const member = newS.member ?? oldS.member;
  if (!member) return;

  // Our own bot got moved/kicked out of voice
  if (member.id === client.user.id) {
    const mon = getMonitor(guild);
    if (!newS.channelId) mon.leave();
    else if (newS.channelId !== mon.channelId) mon.channelId = newS.channelId;
    return;
  }
  if (member.user.bot) return;
  if (oldS.channelId === newS.channelId) return; // mute/deafen/stream toggles, not a move

  store.logVoice(guild.id, member.id, oldS.channelId, newS.channelId);
  const s = store.settings(guild.id);

  if (newS.channelId) {
    // Lift any expired LoudGuard mute (e.g. they left while muted)
    moderator.liftIfExpired(guild, member.id, member).catch(() => {});

    const hop = tracker.record(guild.id, member.id, { hopLimit: s.hopLimit, windowSec: s.hopWindowSec });
    if (hop) {
      store.addFlag(guild.id, member.id, 'hopping', `${hop.count} joins in ${hop.windowSec}s`);
      await moderator.log(guild, new EmbedBuilder().setColor(0xf0b232).setTitle('🦘 Channel hopping')
        .setDescription(`<@${member.id}> joined **${hop.count}** voice channels in ${hop.windowSec}s. Now in ${newS.channel}.`)
        .setFooter({ text: `Suspicion score (24 h): ${store.suspicion(guild.id, member.id)}` }).setTimestamp());
    }
    await maybeFollow(guild, member, newS.channel);
  }

  // Someone left the bot's channel — maybe it's empty now
  const mon = monitors.get(guild.id);
  if (mon?.channelId && oldS.channelId === mon.channelId) await goIdle(guild);
  else if (!mon?.channelId && newS.channelId) await goIdle(guild);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'guard' || !interaction.inGuild()) return;
  try {
    await handleGuard(interaction, { store, moderator, getMonitor });
  } catch (e) {
    console.error('[command]', e);
    const msg = { content: `Something broke: ${e.message}`, flags: MessageFlags.Ephemeral };
    interaction.deferred || interaction.replied ? interaction.editReply(msg).catch(() => {}) : interaction.reply(msg).catch(() => {});
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[ready] logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
  const rest = new REST().setToken(DISCORD_TOKEN);
  const body = [guardCommand.toJSON()];
  if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
  else await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
  console.log(`[ready] /guard registered ${GUILD_ID ? `to server ${GUILD_ID} (instant)` : 'globally (can take up to an hour)'}`);

  store.prune();
  for (const guild of c.guilds.cache.values()) {
    // Clean up mutes that expired while the bot was offline
    for (const vs of guild.voiceStates.cache.values()) {
      if (vs.serverMute && vs.member) moderator.liftIfExpired(guild, vs.id, vs.member).catch(() => {});
    }
    goIdle(guild).catch(() => {});
  }
  setInterval(() => { tracker.sweep(); store.prune(); }, 3_600_000).unref();
});

process.on('unhandledRejection', (e) => console.warn('[unhandled]', e?.message ?? e));
process.on('SIGINT', () => { for (const m of monitors.values()) m.leave(); client.destroy(); process.exit(0); });

client.login(DISCORD_TOKEN);
