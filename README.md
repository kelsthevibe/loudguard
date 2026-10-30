# LoudGuard (beta 0.2)

[![tests](https://github.com/kelsthevibe/loudguard/actions/workflows/test.yml/badge.svg)](https://github.com/kelsthevibe/loudguard/actions/workflows/test.yml)

A Discord bot that **auto-mutes people blasting earrape** and **tracks trolls hopping between voice channels**.

- 🔇 Listens to every speaker separately and measures loudness live (audio is never recorded or saved)
- ⏱️ Mutes only *sustained* loud audio, so a loud laugh is fine and a soundboard blast is not
- 📈 Escalates: 30 s mute → 2 min mute → 10 min timeout (strikes reset after 1 h)
- 🦘 Flags channel hoppers (5+ joins in 2 min) across **every** voice channel in the server
- 👁️ Auto-follows flagged users into whatever channel they join next
- 🤖 **Worker bots**: add extra bot accounts to listen in several channels at once
- 📋 Logs everything to a mod channel; `/guard trail` shows where someone has been

---

## 1. Create the bot (5 min)

1. Go to the **Discord Developer Portal** → https://discord.com/developers/applications → **New Application**.
2. Copy the **Application ID** from *General Information*. That's your `CLIENT_ID`.
3. **Bot** tab → **Reset Token** → copy it. That's your `DISCORD_TOKEN` (keep it secret).
   No privileged intents are needed, so leave the three toggles off.
4. Invite it to your server. Replace `YOUR_CLIENT_ID` in this link and open it:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1099516890112
   ```

   That grants: View Channels, Send Messages, Embed Links, Connect, **Mute Members**, **Timeout Members**.
5. In *Server Settings → Roles*, drag the bot's role **above** the roles of people it should moderate (timeouts need this).

## 2. Run it

Requires **Node.js 22.12+** → https://nodejs.org

```bash
cd loudguard
npm install
cp .env.example .env      # then fill in DISCORD_TOKEN, CLIENT_ID, GUILD_ID
npm start
```

`GUILD_ID` = your server's ID (enable *Developer Mode* in Discord settings, then right-click the server → Copy Server ID). With it set, the slash commands show up instantly. Without it they register globally, which can take up to an hour.

You should see:
```
[ready] logged in as LoudGuard#1234 in 1 server(s)
[ready] /guard registered to server ... (instant)
```

## 3. First-time setup in Discord

```
/guard set log_channel:#mod-log
/guard join            ← while you're in a voice channel
```

Then have a friend play something loud and check `#mod-log`.

## 4. (Optional) Add worker bots for more channels

Discord lets one bot account sit in **one voice channel per server**. Each worker bot covers one more channel.

1. Make another application in the Developer Portal (https://discord.com/developers/applications), for example "LoudGuard Ear 1", and copy its bot token.
2. Invite it with listen-only permissions (View Channels + Connect). Use the worker's own Application ID:
   ```
   https://discord.com/oauth2/authorize?client_id=WORKER_APP_ID&scope=bot&permissions=1049600
   ```
3. Add its token to `.env`. For several workers, separate the tokens with commas:
   ```
   WORKER_TOKENS=token-of-worker-1,token-of-worker-2
   ```
4. Restart. `/guard status` should now list `main`, `w1`, `w2`, ...

Workers only **listen**. When one hears earrape it reports to the main bot, which does the muting, so workers never need moderation permissions.

**How listeners get assigned** (`src/planner.js`):
1. A listener pinned with `/guard join stay:true` never moves.
2. A listener in a channel that still has people stays put, so bots don't bounce around.
3. Free listeners go to uncovered channels: channels with flagged users first, then the busiest.
4. If a flagged user is in an uncovered channel and every listener is busy, the bot pulls a listener from the smallest channel that has no flagged users.
5. Idle listeners in empty channels leave.

## Commands

All commands are only visible to members with **Mute Members** by default.

| Command | What it does |
|---|---|
| `/guard join [stay]` | Listen in your voice channel. `stay:true` stops it auto-following elsewhere. |
| `/guard leave` | All listeners leave and auto-follow pauses |
| `/guard resume` | Resume auto-follow |
| `/guard status` | Where every listener is + all settings |
| `/guard meter` | Loudness of each speaker over the last 10 s. **Use this to tune.** |
| `/guard set ...` | Change any setting (see below) |
| `/guard incidents [user]` | Recent auto-mutes |
| `/guard watchlist` | Most suspicious users in the last 24 h |
| `/guard trail user` | That user's recent voice-channel movements |
| `/guard pardon user` | Clear strikes, unmute, remove timeout |

## Tuning

| Setting | Default | Meaning |
|---|---|---|
| `threshold_db` | `-8` | How loud a 20 ms slice must be to count as "loud". **0 = max possible.** Normal talking is around -30 to -20, shouting around -15 to -10, earrape around -6 to 0. Lower number = stricter. |
| `trigger_ms` | `1500` | How long someone must stay loud before being muted. Heavily distorted (clipped) audio counts 1.5×, so real earrape gets caught in about 1 s. |
| `mute_seconds` | `30` | First mute. The 2nd strike is 4× longer, the 3rd is a timeout. |
| `escalate` | `true` | Turn the strike ladder off and every offence is just `mute_seconds` |
| `timeout_minutes` | `10` | Timeout on the 3rd strike within an hour |
| `hop_limit` / `hop_window_sec` | `5` / `120` | Joins within the window that count as channel hopping |
| `auto_follow` | `true` | Listeners move automatically: flagged users' channels first, then the busiest |
| `exempt_role` | — | Never auto-muted (admins are always exempt) |

**Test with real clips before going live**, no Discord needed (requires ffmpeg → https://ffmpeg.org/download.html):

```bash
npm run calibrate -- some-earrape.mp3          # default settings
npm run calibrate -- loud-friend.wav -12 1000  # try threshold -12, trigger 1000 ms
```

It prints a loudness bar for each second and tells you whether the clip would be muted.

```bash
npm test     # 25 tests: detector, hopping, strikes, listener planner, coordinator
```

## Hosting 24/7

The bot only runs while `npm start` is running. To keep it online:

- **Docker** (any VPS, e.g. Oracle Cloud free tier, or a Raspberry Pi 4/5):
  ```bash
  docker build -t loudguard .
  docker run -d --name loudguard --restart unless-stopped --env-file .env -v loudguard-data:/app/data loudguard
  ```
- **Without Docker:** `npm install -g pm2 && pm2 start src/index.js --name loudguard && pm2 save` (pm2: https://pm2.keymetrics.io)

## How it works

```
voice channel ──► per-user Opus stream (DAVE-decrypted) ──► Opus decoder ──► 20 ms PCM frames
                                                                               │
                                       RMS loudness (dBFS) + clipping % ◄──────┘
                                                   │
                                  "leaky bucket": loud frames fill it, quiet frames drain it
                                                   │  bucket full
                                                   ▼
                              server-mute ─► log embed ─► auto-unmute timer ─► strike ladder

voiceStateUpdate (every channel) ─► movement log + hop counter ─► flag ─► auto-follow
```

**Suspicion score** (24 h) = 3 per auto-mute + 1 per hopping flag. Any score ≥ 1 makes the bot follow that user.

## Known beta limitations

- **One channel per bot account.** Hop tracking covers every channel, but audio is only checked where a listener is sitting. Add worker bots (step 4) until you have as many listeners as busy channels.
- Loudness is measured on what the person *sends*. Your personal volume slider for them doesn't affect it.
- Data (settings, incidents, movement logs) lives in `data/loudguard.db`. Movement logs and flags are deleted after 7 days.
- Only tracks inside servers the bot is in. It doesn't share data between servers.
- Tell your members: add a line to your rules like *"Voice channels are monitored for loudness by a bot. Audio is not recorded."*

## Files

```
src/analyzer.js    loudness math + leaky-bucket detector (pure, tested)
src/tracker.js     channel-hop counter
src/store.js       SQLite: settings, incidents, voice log, flags, suspicion
src/voice.js       one listener: joins voice, subscribes to each speaker, decodes audio
src/planner.js     which listener goes to which channel (pure, tested)
src/coordinator.js runs the planner across main + worker bots
src/moderation.js  strike ladder, mute/unmute/timeout, mod-log embeds
src/commands.js    /guard slash commands
src/index.js       wires it all together
scripts/calibrate.js  test audio files offline
```
