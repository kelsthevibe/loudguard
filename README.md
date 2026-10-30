# LoudGuard (beta 0.1)

A Discord bot that **auto-mutes people blasting earrape** and **tracks trolls hopping between voice channels**.

- 🔇 Listens to every speaker separately and measures loudness live (audio is never recorded or saved)
- ⏱️ Mutes only *sustained* loud audio, so a loud laugh is fine and a soundboard blast is not
- 📈 Escalates: 30 s mute → 2 min mute → 10 min timeout (strikes reset after 1 h)
- 🦘 Flags channel hoppers (5+ joins in 2 min) across **every** voice channel in the server
- 👁️ Auto-follows flagged users into whatever channel they join next
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

## Commands

All commands are only visible to members with **Mute Members** by default.

| Command | What it does |
|---|---|
| `/guard join [stay]` | Listen in your voice channel. `stay:true` stops it auto-following elsewhere. |
| `/guard leave` | Leave voice |
| `/guard status` | Where it's listening + all settings |
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
| `auto_follow` | `true` | Bot moves to wherever flagged users go, and sits in the busiest channel when idle |
| `exempt_role` | — | Never auto-muted (admins are always exempt) |

**Test with real clips before going live**, no Discord needed (requires ffmpeg → https://ffmpeg.org/download.html):

```bash
npm run calibrate -- some-earrape.mp3          # default settings
npm run calibrate -- loud-friend.wav -12 1000  # try threshold -12, trigger 1000 ms
```

It prints a loudness bar for each second and tells you whether the clip would be muted.

```bash
npm test     # 11 tests: speech, laughs, earrape, pulsing earrape, hopping, strikes
```

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

- **One channel at a time per server.** That's a Discord rule for bots. Hop tracking covers every channel, but audio is only checked where the bot is sitting. Auto-follow puts it where trouble is most likely. For full coverage of big servers, the next step is several "worker" bot accounts.
- Loudness is measured on what the person *sends*. Your personal volume slider for them doesn't affect it.
- Data (settings, incidents, movement logs) lives in `data/loudguard.db`. Movement logs and flags are deleted after 7 days.
- Only tracks inside servers the bot is in. It doesn't share data between servers.
- Tell your members: add a line to your rules like *"Voice channels are monitored for loudness by a bot. Audio is not recorded."*

## Files

```
src/analyzer.js    loudness math + leaky-bucket detector (pure, tested)
src/tracker.js     channel-hop counter
src/store.js       SQLite: settings, incidents, voice log, flags, suspicion
src/voice.js       joins voice, subscribes to each speaker, decodes audio
src/moderation.js  strike ladder, mute/unmute/timeout, mod-log embeds
src/commands.js    /guard slash commands
src/index.js       wires it all together
scripts/calibrate.js  test audio files offline
```
