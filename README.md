# LoudGuard (beta 0.3)

[![tests](https://github.com/kelsthevibe/loudguard/actions/workflows/test.yml/badge.svg)](https://github.com/kelsthevibe/loudguard/actions/workflows/test.yml)

A Discord bot that **spots voice-chat trolls and earrape, lets the people in the channel vote on it, and hands confirmed cases to human mods**, so mods can act with one click instead of hunting through voice channels.

By default **LoudGuard never punishes anyone by itself.** A human mod always makes the call.

- 🎙️ **Auto-detects** sustained earrape (it measures loudness live and never records audio)
- 🙋 **`/report`** (or right-click a user → *Report voice trolling*) for anything a detector can't hear
- 🗳️ **Community vote** in the voice channel's chat. Only people *in that channel* can vote, and votes from long-time, higher-level members count more
- 🚩 **Mod queue** gets each case with the evidence and the vote result, plus buttons: 🔇 Mute · ⏳ Timeout · 🔌 Disconnect · ✅ Dismiss
- 🦘 **Channel-hop tracking** across every voice channel, plus `/guard trail` to see where someone has been
- 🤖 **Worker bots** to cover several voice channels at once

## How a case works

```
 🎙️ detector hears earrape ──┐                  ┌─► 🔴 vote passes ──► mod queue updated + @Mods pinged
                             ├─► case opens ──► 🗳️ vote in VC chat ─┼─► 🟢 channel says "fine" ──► marked cleared
 🙋 member uses /report ──────┘                  └─► ⌛ time runs out ──► detector cases stay in queue as 🟡 unconfirmed
                                                                                  │
                         mod clicks 🔇 Mute / ⏳ Timeout / 🔌 Disconnect / ✅ Dismiss ◄─┘
```

- **Detector cases** go to the mod queue straight away as 🟡 *unconfirmed* (no ping). If the channel votes yes, they turn 🔴 and the mod role gets pinged.
- **Reports** only reach mods if the channel agrees, so one person can't spam the queue.
- Repeat detections on the same person add to their open case instead of opening new ones.
- If a mod dismisses a case as a false alarm, the detector leaves that person alone for 10 minutes.

### How votes are weighted

Every vote starts at **1** and gains bonuses:

| | Bonus |
|---|---|
| Time in the server: 7–30 days / 30–180 days / 180+ days | +0.5 / +1 / +1.5 |
| Level: +0.15 per level (max +1.5). LoudGuard's own level, or a level role from MEE6, Arcane etc., whichever is higher | up to +1.5 |

So a vote counts between **×1** (a member who's fairly new) and **×4** (a long-time regular).

A case is **confirmed** when 👍 weight minus 👎 weight reaches **4** *and* at least **2 different people** voted 👍. One heavy voter can't confirm a case alone.

**Who can't vote:** Discord accounts younger than 7 days (alts), members who joined less than 24 hours ago (raids), anyone not in the voice channel, and the person being voted on.

**Levels:** LoudGuard gives 1 XP per minute in voice (not in the AFK channel) and 1 XP per minute of chatting (spam doesn't count extra). Level *L* needs 50 × L² XP, so level 5 is about 21 hours of activity. It only counts activity since the bot joined your server, which is why `/guard levelrole` lets you plug in the level roles another bot already gives out. Members can run `/myvote` to see what their vote is worth and why.

---

## 1. Create the bot (5 min)

1. Go to the **Discord Developer Portal**: https://discord.com/developers/applications → **New Application**.
2. Copy the **Application ID** from *General Information*. That's your `CLIENT_ID`.
3. **Bot** tab → **Reset Token** → copy it. That's your `DISCORD_TOKEN` (keep it secret).
   No privileged intents are needed, so leave the three toggles off.
4. Invite it to your server. Replace `YOUR_CLIENT_ID` in this link and open it:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1099533732864
   ```

   That grants: View Channels, Send Messages, Embed Links, Read Message History, Connect, Mute Members, Move Members, Timeout Members. The mod-action permissions are only used when a mod clicks a button.
5. In *Server Settings → Roles*, drag the bot's role **above** the roles of people it should moderate (timeouts need this).

## 2. Run it

Requires **Node.js 22.12+**: https://nodejs.org

```bash
cd loudguard
npm install
cp .env.example .env      # then fill in DISCORD_TOKEN, CLIENT_ID, GUILD_ID
npm start
```

`GUILD_ID` = your server's ID (turn on *Developer Mode* in Discord settings, then right-click the server → Copy Server ID). With it set, commands appear instantly. Without it they register globally, which can take up to an hour.

## 3. First-time setup in Discord

```
/guard set mod_channel:#mod-queue mod_ping_role:@Mods log_channel:#mod-log
/guard levelrole role:@Level 10 bonus:1        ← optional, if you use MEE6/Arcane level roles
/guard join                                     ← while you're in a voice channel
```

Then test it: have a friend play something loud, vote 👍 with another member in the channel, and watch `#mod-queue`.

Members need **Send Messages** in voice channels to see the vote, so check your voice-channel permissions if votes don't show up.

## 4. (Optional) Add worker bots for more channels

Discord lets one bot account sit in **one voice channel per server**. Each worker bot covers one more channel.

1. Make another application at https://discord.com/developers/applications (for example "LoudGuard Ear 1") and copy its bot token.
2. Invite it with listen-only permissions, using the worker's own Application ID:
   ```
   https://discord.com/oauth2/authorize?client_id=WORKER_APP_ID&scope=bot&permissions=1049600
   ```
3. Add it to `.env` (separate several tokens with commas): `WORKER_TOKENS=token1,token2`
4. Restart. `/guard status` should list `main`, `w1`, `w2`, ...

Workers only listen. Cases, votes and mod actions all go through the main bot.

**How listeners get assigned** (`src/planner.js`): pinned listeners never move → listeners in occupied channels stay put → free listeners take channels with flagged users first, then the busiest → if a flagged user is in an uncovered channel, a listener moves over from the smallest channel with no flagged users → idle listeners leave empty channels.

## Commands

**For everyone**

| Command | What it does |
|---|---|
| `/report user [reason]` | Start a vote about someone in your voice channel |
| Right-click user → Apps → **Report voice trolling** | Same thing, quicker |
| `/myvote` | How much your vote counts, and your level |

**For mods** (needs *Mute Members*)

| Command | What it does |
|---|---|
| `/guard cases [open_only]` | Recent cases with links to their mod-queue posts |
| `/guard watchlist` | Most suspicious users in the last 24 h |
| `/guard trail user` | That user's recent voice-channel movements |
| `/guard pardon user` | Clear their record, unmute, remove timeout |
| `/guard incidents [user]` | Recent mutes |
| `/guard join [stay]` / `leave` / `resume` | Place listeners manually / stop / restart auto-follow |
| `/guard status` | Where every listener is, plus all settings |
| `/guard meter` | Loudness of each speaker over the last 10 s, for tuning |
| `/guard levelrole role bonus` | Give a level role extra vote weight (0 removes it) |
| `/guard set ...` | Change settings (see below) |

## Settings (`/guard set`)

| Setting | Default | Meaning |
|---|---|---|
| `mode` | `flag` | `flag` = cases go to mods (recommended) · `auto` = v0.2 behaviour, mutes instantly with a strike ladder |
| `mod_channel` | — | Where cases are posted (falls back to `log_channel`) |
| `mod_ping_role` | — | Pinged when the channel confirms a case |
| `vote_threshold` | `4` | Net weighted 👍 needed to confirm |
| `min_voters` | `2` | Different people who must vote 👍 |
| `vote_minutes` | `3` | How long a vote stays open |
| `min_tenure_hours` | `24` | Time in the server before someone can vote or report |
| `min_account_days` | `7` | Discord account age before someone can vote or report |
| `mod_mute_minutes` / `mod_timeout_minutes` | `5` / `10` | Lengths for the mod buttons. Mutes lift automatically. |
| `threshold_db` | `-8` | How loud counts as "loud". 0 = max possible; talking ≈ -30 to -20, shouting ≈ -15 to -10, earrape ≈ -6 to 0 |
| `trigger_ms` | `1500` | How long someone must stay loud before a case opens (distorted audio counts 1.5×) |
| `hop_limit` / `hop_window_sec` | `5` / `120` | Joins within the window that count as channel hopping |
| `auto_follow` | `true` | Listeners move toward flagged users and busy channels |
| `exempt_role` | — | Never flagged or reportable (admins always are) |

**Suspicion score** (24 h): 3 per confirmed or mod-actioned case, 1 per unconfirmed detector case or hop flag, 0 for anything dismissed or cleared. Any score ≥ 1 draws a listener toward that user.

## Test before going live

```bash
npm test                                         # 36 tests
npm run calibrate -- some-earrape.mp3            # would this clip open a case? (needs ffmpeg)
npm run calibrate -- loud-friend.wav -12 1000    # try threshold -12 dBFS, 1000 ms
```

ffmpeg: https://ffmpeg.org/download.html

## Hosting 24/7

- **Docker** (any VPS, e.g. Oracle Cloud free tier, or a Raspberry Pi 4/5):
  ```bash
  docker build -t loudguard .
  docker run -d --name loudguard --restart unless-stopped --env-file .env -v loudguard-data:/app/data loudguard
  ```
- **Without Docker:** `npm install -g pm2 && pm2 start src/index.js --name loudguard && pm2 save` (https://pm2.keymetrics.io)

## Privacy

- Audio is analysed live as loudness numbers and **never recorded or stored**.
- LoudGuard counts messages for XP but **never reads message content**. That's why it doesn't need the Message Content intent.
- Stored data (settings, cases, votes, XP, movement log) lives in `data/loudguard.db`. Movement logs and hop flags are deleted after 7 days.
- Who voted which way is visible only in the database, not in Discord. Mods see totals.
- Put a line in your server rules, such as: *"Voice channels are monitored for loudness by a bot. Audio is not recorded. Members can vote on reports."*

## Files

```
src/analyzer.js     loudness math + leaky-bucket detector
src/levels.js       XP → level, vote weights, vote tally
src/cases.js        cases, votes, mod queue, mod buttons, expiry
src/tracker.js      channel-hop counter
src/store.js        SQLite: settings, cases, votes, XP, incidents, voice log
src/voice.js        one listener: joins voice, subscribes to each speaker, decodes audio
src/planner.js      which listener goes to which channel
src/coordinator.js  runs the planner across main + worker bots
src/moderation.js   mute/unmute/timeout helpers, auto-mode strike ladder, logs
src/commands.js     /guard, /report, /myvote, context menu
src/index.js        wires it all together
scripts/calibrate.js  test audio files offline
```
