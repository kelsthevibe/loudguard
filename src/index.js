// LoudGuard entry point: wires Discord events to the tracker, moderator and coordinator.
import 'dotenv/config';
import { Client, GatewayIntentBits, Events, EmbedBuilder, REST, Routes, MessageFlags } from 'discord.js';
import { Store } from './store.js';
import { Moderator } from './moderation.js';
import { HopTracker } from './tracker.js';
import { Coordinator } from './coordinator.js';
import { guardCommand, handleGuard } from './commands.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, DB_PATH, WORKER_TOKENS = '' } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env (see README.md)');
  process.exit(1);
}

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
const main = new Client({ intents });
const workerTokens = WORKER_TOKENS.split(',').map((t) => t.trim()).filter(Boolean);
const workers = workerTokens.map(() => new Client({ intents }));

const store = new Store(DB_PATH || 'data/loudguard.db');
const moderator = new Moderator(store);
const tracker = new HopTracker();
const coord = new Coordinator({ main, workers, store, moderator });

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
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'guard' || !interaction.inGuild()) return;
  try {
    await handleGuard(interaction, { store, moderator, coord });
  } catch (e) {
    console.error('[command]', e);
    const msg = { content: `Something broke: ${e.message}`, flags: MessageFlags.Ephemeral };
    interaction.deferred || interaction.replied ? interaction.editReply(msg).catch(() => {}) : interaction.reply(msg).catch(() => {});
  }
});

main.once(Events.ClientReady, async (c) => {
  console.log(`[ready] main bot ${c.user.tag} in ${c.guilds.cache.size} server(s), ${workers.length} worker(s) configured`);
  const rest = new REST().setToken(DISCORD_TOKEN);
  const body = [guardCommand.toJSON()];
  if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
  else await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
  console.log(`[ready] /guard registered ${GUILD_ID ? `to server ${GUILD_ID} (instant)` : 'globally (can take up to an hour)'}`);

  store.prune();
  for (const guild of c.guilds.cache.values()) {
    for (const vs of guild.voiceStates.cache.values()) {
      if (vs.serverMute && vs.member) moderator.liftIfExpired(guild, vs.id, vs.member).catch(() => {});
    }
    coord.schedule(guild.id, 1000);
  }
  setInterval(() => { tracker.sweep(); store.prune(); }, 3_600_000).unref();
});

workers.forEach((w, i) => {
  w.once(Events.ClientReady, (c) => {
    console.log(`[ready] worker w${i + 1} ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
    if (main.isReady()) for (const g of c.guilds.cache.values()) coord.schedule(g.id, 1000);
  });
});

process.on('unhandledRejection', (e) => console.warn('[unhandled]', e?.message ?? e));
process.on('SIGINT', () => {
  coord.shutdown();
  for (const { client } of coord.accounts) client.destroy();
  process.exit(0);
});

main.login(DISCORD_TOKEN);
workers.forEach((w, i) => w.login(workerTokens[i]).catch((e) => console.error(`[worker w${i + 1}] login failed: ${e.message}`)));
