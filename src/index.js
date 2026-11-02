// LoudGuard entry point: wires Discord events to the tracker, moderator and coordinator.
import 'dotenv/config';
import { Client, GatewayIntentBits, Events, EmbedBuilder, REST, Routes, MessageFlags } from 'discord.js';
import { Store } from './store.js';
import { Moderator } from './moderation.js';
import { HopTracker } from './tracker.js';
import { Coordinator } from './coordinator.js';
import { CaseManager } from './cases.js';
import { guardCommand, reportCommand, reportContext, myVoteCommand, handleGuard, handleMemberCommand } from './commands.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, DB_PATH, WORKER_TOKENS = '' } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env (see README.md)');
  process.exit(1);
}

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
// GuildMessages lets the main bot COUNT messages for XP. It never reads message content.
const main = new Client({ intents: [...intents, GatewayIntentBits.GuildMessages] });
const workerTokens = WORKER_TOKENS.split(',').map((t) => t.trim()).filter(Boolean);
const workers = workerTokens.map(() => new Client({ intents }));

const store = new Store(DB_PATH || 'data/loudguard.db');
const moderator = new Moderator(store);
const tracker = new HopTracker();
const cases = new CaseManager({ store, moderator, tracker });
const coord = new Coordinator({
  main, workers, store, moderator,
  onTrigger: (guild, userId, channelId, trig) => (store.settings(guild.id).mode === 'auto'
    ? moderator.punish(guild, userId, channelId, trig)
    : cases.fromDetector(guild, userId, channelId, trig)),
});

// ---------- XP: 1 per minute in voice (not the AFK channel), 1 per minute of chatting ----------
const voiceSince = new Map(); // `${guildId}:${userId}` -> ms
const counts = (state) => !!state.channelId && state.channelId !== state.guild.afkChannelId;
function voiceXpTick(oldS, newS) {
  const key = `${newS.guild.id}:${newS.id}`;
  if (counts(oldS) && !counts(newS)) {
    const start = voiceSince.get(key);
    if (start) store.voiceXp(newS.guild.id, newS.id, Date.now() - start);
    voiceSince.delete(key);
  } else if (!counts(oldS) && counts(newS)) {
    voiceSince.set(key, Date.now());
  }
}
main.on(Events.MessageCreate, (msg) => {
  if (msg.inGuild() && !msg.author.bot) store.messageXp(msg.guildId, msg.author.id);
});

// Each bot account watches its OWN voice state (in case a mod drags or disconnects it)
for (const { id, client } of coord.accounts) {
  client.on(Events.VoiceStateUpdate, (oldS, newS) => {
    if (newS.id === client.user.id) coord.ownVoiceState(id, newS);
  });
}

// Everyone else's voice activity is handled once, by the main bot
main.on(Events.VoiceStateUpdate, async (oldS, newS) => {
  const guild = newS.guild;
  const member = newS.member ?? oldS.member;
  if (!member || member.user.bot) return;
  if (oldS.channelId === newS.channelId) return; // mute/deafen/stream toggles, not a move
  voiceXpTick(oldS, newS);

  store.logVoice(guild.id, member.id, oldS.channelId, newS.channelId);
  const s = store.settings(guild.id);

  if (newS.channelId) {
    moderator.liftIfExpired(guild, member.id, member).catch(() => {});
    const hop = tracker.record(guild.id, member.id, { hopLimit: s.hopLimit, windowSec: s.hopWindowSec });
    if (hop) {
      store.addFlag(guild.id, member.id, 'hopping', `${hop.count} joins in ${hop.windowSec}s`);
      await moderator.log(guild, new EmbedBuilder().setColor(0xf0b232).setTitle('🦘 Channel hopping')
        .setDescription(`<@${member.id}> joined **${hop.count}** voice channels in ${hop.windowSec}s. Now in ${newS.channel}.`)
        .setFooter({ text: `Suspicion score (24 h): ${store.suspicion(guild.id, member.id)}` }).setTimestamp());
    }
  }
  coord.schedule(guild.id);
});

main.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inGuild()) return;
  try {
    if (interaction.isButton() && interaction.customId.startsWith('lg:')) return await cases.onButton(interaction);
    if (!interaction.isChatInputCommand() && !interaction.isUserContextMenuCommand()) return;
    if (interaction.commandName === 'guard') return await handleGuard(interaction, { store, moderator, coord, cases });
    if (['report', 'myvote', 'Report voice trolling'].includes(interaction.commandName)) {
      return await handleMemberCommand(interaction, { cases, store });
    }
  } catch (e) {
    console.error('[command]', e);
    const msg = { content: `Something broke: ${e.message}`, flags: MessageFlags.Ephemeral };
    interaction.deferred || interaction.replied ? interaction.editReply(msg).catch(() => {}) : interaction.reply(msg).catch(() => {});
  }
});

main.once(Events.ClientReady, async (c) => {
  console.log(`[ready] main bot ${c.user.tag} in ${c.guilds.cache.size} server(s), ${workers.length} worker(s) configured`);
  const rest = new REST().setToken(DISCORD_TOKEN);
  const body = [guardCommand, reportCommand, reportContext, myVoteCommand].map((c) => c.toJSON());
  if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
  else await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
  console.log(`[ready] /guard, /report, /myvote registered ${GUILD_ID ? `to server ${GUILD_ID} (instant)` : 'globally (can take up to an hour)'}`);

  store.prune();
  for (const guild of c.guilds.cache.values()) {
    for (const vs of guild.voiceStates.cache.values()) {
      if (vs.serverMute && vs.member) moderator.liftIfExpired(guild, vs.id, vs.member).catch(() => {});
      if (counts(vs) && !vs.member?.user.bot) voiceSince.set(`${guild.id}:${vs.id}`, Date.now());
    }
    coord.schedule(guild.id, 1000);
  }
  setInterval(() => { tracker.sweep(); store.prune(); }, 3_600_000).unref();
  // Close votes whose time is up (restart-safe: expiry times live in the database)
  setInterval(() => cases.expireDue((id) => main.guilds.cache.get(id)).catch((e) => console.warn('[expire]', e.message)), 15_000).unref();
});

workers.forEach((w, i) => {
  w.once(Events.ClientReady, (c) => {
    console.log(`[ready] worker w${i + 1} ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
    if (main.isReady()) for (const g of c.guilds.cache.values()) coord.schedule(g.id, 1000);
  });
});

process.on('unhandledRejection', (e) => console.warn('[unhandled]', e?.message ?? e));
process.on('SIGINT', () => {
  for (const [key, start] of voiceSince) {
    const [g, u] = key.split(':');
    store.voiceXp(g, u, Date.now() - start);
  }
  coord.shutdown();
  for (const { client } of coord.accounts) client.destroy();
  process.exit(0);
});

main.login(DISCORD_TOKEN);
workers.forEach((w, i) => w.login(workerTokens[i]).catch((e) => console.error(`[worker w${i + 1}] login failed: ${e.message}`)));
