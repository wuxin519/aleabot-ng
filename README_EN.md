# AleaBot NG 🎲

<p align="center">
  <a href="README_EN.md">🇬🇧 English</a> &nbsp;|&nbsp; <a href="README.md">🇨🇳 简体中文</a>
</p>

> A multi-platform TRPG (tabletop role-playing game) dice bot — **supports both QQ and KOOK**, with a built-in web admin panel and data backup.

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/language-TypeScript-3178c6.svg" alt="Language">
  <img src="https://img.shields.io/badge/platform-QQ%20%C2%B7%20KOOK-07c160.svg" alt="Platforms">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933.svg" alt="Node">
  <img src="https://img.shields.io/badge/database-SQLite-003b57.svg" alt="Database">
</p>

## Table of Contents

- [Features](#features)
- [Command Reference](#command-reference)
- [Quick Start](#quick-start)
- [Platform Setup](#platform-setup)
  - [Why QQ and KOOK (not WeChat, Discord, or others)](#why-qq-and-kook-not-wechat-discord-or-others)
  - [QQ vs KOOK](#qq-vs-kook)
- [Admin Panel](#admin-panel)
- [Data & Backup](#data--backup)
- [Deployment](#deployment)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [License](#license)

## Features

- **Dual-platform online**: QQ (OneBot 11) + KOOK official Bot API, single process, shared data
- **Zero-dependency dice engine**: self-built expression parser, no third-party deps, reproducible & testable
- **Full TRPG commands**: rolling / COC checks / character sheets / initiative / per-group config
- **Web admin panel**: live status, roll logs, character sheets, group config, one-click backup & export
- **Auto backup**: scheduled snapshots + retention policy + pre-exit backup
- **Multi-platform data isolation**: `(platform, group, user)` triple, QQ & KOOK data never mix

## Command Reference

> **Prefix**: all commands start with `.`, and you can also use the Chinese full-stop `。` (e.g. `。r 3d6` ≡ `.r 3d6`). The group prefix is configurable via `.set prefix`.

### Basic Rolling

| Command | Description | Example |
|---------|-------------|---------|
| `.r <expr>` | Roll dice (multi-roll / Fate / WoD / Twin-Cross / CN advantage / bare bonus) | `.r 3d6+2` · `.r 4d6k3` · `.r 2d20kh1` |
| `.r` | Roll the default dice (`.r d` omitting sides also works) | `.r` · `.r 2d` |
| `.r<expr>` | Sticky writing (mainstream dice-bot style; same for checks/attributes) | `.r3d100` · `.ra侦查60` · `.st力量88` |
| `.rh <expr>` | Hidden roll (only a hint in group, result via DM) | `.rh 1d100` |

### COC / Rulebook Checks

| Command | Description | Example |
|---------|-------------|---------|
| `.ra <skill> [value]` | COC check (reads sheet if value omitted) | `.ra 侦查 60` |
| `.ra <skill>±<expr>` | Attribute adjustment (`+10` / `-5` / `+1d4`) | `.ra 侦查+10` |
| `.ra (困难\|极难\|大成功)<skill>` | Difficulty prefix | `.ra 困难侦查` |
| `.rc <skill> [value]` | Rulebook check (ignores group house rule) | `.rc 侦查` |
| `.ra 3#b手枪` | Multi-column check (burst; `b` bonus / `p` penalty) | `.ra 3#b2侦查 55` |
| `.rb` / `.rp` | Bonus / penalty dice check | `.rb 侦查 60` |
| `.sc [pass/fail]` | Sanity check (max loss on fumble, auto-written back) | `.sc 0/1d10` |
| `.sc ... --cap=N` / `--half` | Sanity loss **cap** / **halved** (stackable, halved first) | `.sc 1/1d6 --cap=3` |
| `.rav @opponent <skill>` | Opposed check (higher rank wins, tie → lower roll) | `.rav @李四 侦查` |
| `.setcoc 0-5/dg` | Switch house rule (0 rulebook / 2 common / dg luck) | `.setcoc dg` |
| `.setcoc details` | List all available house rules | `.setcoc details` |
| `.en <skill>...` | Improvement check (multiple at once) | `.en 侦查 聆听` |
| `.en <skill> +<fail>/<success>` | Custom improvement points (dice/negative allowed) | `.en 侦查 +0/1d6` |
| `.ti` / `.li` | Temporary / Long-term insanity table | `.ti` |

### Character Sheets

| Command | Description | Example |
|---------|-------------|---------|
| `.coc` / `.coc <N>` | Generate COC 7 sheet / **roll N sets of primary attributes** (attributes+HP+totals only, not saved) | `.coc` · `.coc 5` |
| `.coc5` / `.dnd` | Generate COC 5 (Tenra) / D&D 5e sheet | `.coc5` · `.dnd` |
| `.st <key> [value]` | Set/view attribute (`.st hp+1` to adjust) | `.st 力量 60` · `.st show` |
| `.st show <attribute>` | View a single attribute | `.st show 侦查` |
| `.st del <attribute>...` | **Delete specified attributes** | `.st del 幸运 魔法` |
| `.st clr` | **Clear all attributes** | `.st clr` |
| `.st export` | **Export attributes** (copy to another bot) | `.st export` |
| `.st &name=expr` | **Save a computed expression** (call via `.r name`) | `.st &手枪伤害=1d6+1` |
| `.st name <name>` / `.sn` | Set the sheet name (also the bot's nickname for you) | `.sn 张三` |
| `.st <key><value> ...` | **Batch entry** (spaces optional, multiple at once) | `.st 力量88 体质70 敏捷60` |
| `.st <num> <num> ...` | **Positional entry** (no key, order matches `.st show`) | `.st 88 70 60 75 80 65 70 60 55` |
| `.st new <title>` | Create a new sheet and switch to it (multi-sheet) | `.st new 调查员A` |
| `.st list` / `.st switch <title\|no>` | List / switch sheets | `.st switch 2` |
| `.pc new/tag/list/del/show/nn` | Sheet management (**delete via `.pc del`**) | `.pc del 调查员A` |
| `.hp` / `.san` | HP/SAN shortcut (`+1`/`-1d4` adjust, `50` set) | `.hp-1d4` |

### Initiative / Fun / Logs / Admin

| Command | Description | Example |
|---------|-------------|---------|
| `.init add <name> <init>` | Add to initiative | `.init add 张三 15` |
| `.init list` / `.init clr` | View / clear initiative | `.init list` |
| `.draw [deck] [count]` | Draw cards (Tarot / Poker) | `.draw 塔罗 3` |
| `.drawlist` | List available decks | `.drawlist` |
| `.name cn 10` | Random name (cn / en / jp) | `.name en 5` |
| `.who A B C` | Shuffle order | `.who 甲 乙 丙` |
| `.jrrp` | Daily luck (stable per day & user) | `.jrrp` |
| `.coin [count]` | Flip coin (heads/tails stats) | `.coin 3` |
| `.gugu` | Coo-coo (pigeon meme) | `.gugu` |
| `.stat` / `.hiy` | Group / my roll stats | `.stat 今日` |
| `.log new [name]` | Create a campaign log and start recording | `.log new 黑圣杯` |
| `.log on` / `.log off` | Resume / pause recording | `.log off` |
| `.log end [json]` | End and export the log | `.log end json` |
| `.log get / list / stat / del` | Export / list / stats / delete logs | `.log list` |
| `.ob` | Observer mode (tag `[OB]`, excludable in recap) | `.ob` |
| `.help` / `.rule` | Command image / quick rules | `.help` |
| `.bot on/off/bye` | Group on/off / leave (admin; unrestricted if unset) | `.bot off` |
| `.set <key> <value>` | Group config (admin) | `.set defaultDice 1d20` |
| `.bak` | Manual backup (admin) | `.bak` |

### Dice Expression Syntax

```
3d6          3 six-sided dice
3d6+2-1      with constant add/sub
4d6k3        4d6 keep the highest 3
4d6dl1       4d6 drop the lowest 1
2d20kh1      advantage (keep high)
2d20kl1      disadvantage (keep low)
1d100<=50    COC check (with target, shows success level)
d / 2d       omit sides (uses group default)
d20优势       CN advantage (= 2d20kh1)
3#2d50       multi-roll (roll 3 times, sum)
f            Fate dice (4 × [-1/0/+1])
5a6          WoD endless dice (≥6 reroll, ≥8 success)
4c3          Twin-Cross dice (≥3 crit continues)
```

## Quick Start

### 1. Requirements

- Node.js **≥ 18**
- An OneBot 11 implementation (for QQ) or a KOOK bot token

### 2. Install & Build

```bash
npm install --registry=https://registry.npmmirror.com
npm run build
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env and fill in each platform's config per the comments
```

### 4. Run

```bash
npm start
```

Then open `http://<hostIP>:8787/` to access the admin panel.

## Platform Setup

### Why QQ and KOOK (not WeChat, Discord, or others)

> **Selection principle**: targeting users in China, "**directly reachable from within China**" is a hard requirement. We also require "a stable, callable bot API" and "fit for TRPG scenarios".

- **Discord**: blocked in mainland China since 2018 and only reachable via proxy, so it is ruled out.
- **WeChat (personal account)**: there is no official bot API for individual developers; the web protocol has long been restricted and can fail at any time, with very strict risk control — unsuitable for a long-running bot, ruled out.
- **Niche platforms like Oopz**: lack a public third-party Bot API, so messages cannot be sent/received programmatically, ruled out.
- **QQ**: the largest user base in China. Instead of reverse-engineering QQ, this project connects via the mature **OneBot 11 standard protocol** through frameworks like NapCat / Lagrange — the framework handles login while this project only sends/receives standard messages, which is stable and reliable; QQ groups are also the most common TRPG venue domestically.
- **KOOK (kaiheila / 开黑啦)**: domestic, directly reachable, mature official Bot API, and inherently a "voice + community" product that fits voice TRPG sessions and public game rooms. Its official WebSocket interface is clean and cheap to adapt.

In short, **QQ covers the widest range of friend groups, while KOOK fills the gap for voice sessions and public communities** — they complement each other, so we settled on the dual-platform approach.

### QQ vs KOOK

| Dimension | QQ (OneBot 11) | KOOK (kaiheila / 开黑啦) |
|-----------|----------------|--------------------------|
| Access method | Forward WebSocket via NapCat / Lagrange | Official Bot API (WebSocket) |
| Login account | Your own QQ number (framework-hosted login) | Standalone bot account (registered on open platform) |
| Reachable in China | ✅ Direct | ✅ Direct |
| Interface nature | Community protocol (unofficial but mature) | Official API (most stable) |
| Ban risk | Low (framework-based, not reverse-engineered) | None (official interface) |
| Groups / Channels | QQ groups, full features | Servers / channels / voice channels, strong community feel |
| Voice capability | No native voice (needs external tools) | Native voice channels, ideal for voice TRPG |
| Integration cost | Zero (OneBot standard, works out of the box) | Low (clear official API, adapter already built-in) |
| Best for | Friend groups, existing QQ groups | Voice sessions, public communities, game rooms |

> Dual-platform data is isolated by the `(platform, group, user)` triple and never mixes; toggle `ONEBOT_ENABLED` / `KOOK_ENABLED` independently in `.env`, or run both platforms online at once.

### QQ (OneBot 11)

This bot does **not** handle QQ login directly; instead it connects to an OneBot implementation:

1. Deploy [NapCat](https://github.com/NapNeko/NapCatQQ) (recommended) or [Lagrange](https://github.com/LagrangeDev/Lagrange.Core)
2. Enable its **forward WebSocket service** (NapCat default port 3001)
3. Set in `.env`:

```env
ONEBOT_ENABLED=true
ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_TOKEN=     # fill in if the framework set an access_token
```

> **Why OneBot instead of reverse-engineering QQ directly?**
> Reverse-engineering protocols (oicq, etc.) simulate a phone login — QR codes expire often, accounts get risk-controlled/banned at any time, and the underlying library breaks on every update. OneBot leaves login to a mature framework while this project only sends/receives standard messages, which is stable and reliable.

### KOOK

1. Go to the [KOOK Developer Center](https://developer.kookapp.cn/) and create a bot application
2. Copy the **Token** and invite the bot to your server
3. Set in `.env`:

```env
KOOK_ENABLED=true
KOOK_TOKEN=your-bot-token
```

## Admin Panel

Open `http://<hostIP>:8787/` (append `?token=xxx` if `ADMIN_TOKEN` is set):

- **Overview**: platform online status, roll stats, uptime, latest backup
- **Roll Logs**: filter by platform/keyword, paginated browsing of all history
- **Character Sheets**: view all users' sheets, deletable
- **Group Config**: view/modify each group's command prefix, default dice, etc.
- **Data Backup**: backup now, download snapshot, export JSON

## Data & Backup

- Database: `data/aleabot.db` (SQLite, WAL mode)
- Backup dir: `data/backups/aleabot-backup-<time>.db`
- Auto backup: every 24h by default, keep latest 14 (adjustable in `.env`)
- Exit protection: on SIGTERM/SIGINT the process backs up before exiting
- Manual backup: click "Backup Now" in the panel, or send `.bak` as an admin

**Restore data**: stop the service, then overwrite `data/aleabot.db` with a backup file.

## Deployment

Deployment instructions for **Linux / Windows / macOS** are provided below. On every platform, complete the common prerequisite steps first:

```bash
# 1. Install dependencies and build
npm install --registry=https://registry.npmmirror.com
npm run build

# 2. Generate the config file (fill in each platform's config per the comments)
cp .env.example .env

# 3. Run (foreground, for verification)
npm start
#   Then open http://<hostIP>:8787/ to access the admin panel
```

### Linux (systemd)

Use the bundled script to install as a system service (auto-start on boot, auto-restart on crash):

```bash
sudo bash deploy/install.sh
sudo systemctl enable --now aleabot
# Check status / logs
systemctl status aleabot
journalctl -u aleabot -f
```

### Windows

**Option A: Run directly (debug / temporary)**

```powershell
npm run build
copy .env.example .env
npm start
```

**Option B: PM2 daemon (recommended, background + auto-start)**

```powershell
npm install -g pm2
npm run build
pm2 start "node dist/index.js" --name aleabot
pm2 save
pm2 startup          # Run the command it prints once more "as Administrator" to enable auto-start
```

**Option C: Register as a Windows service (nssm, windowless background)**

```powershell
# Download nssm from https://nssm.cc first, and add its directory to PATH
nssm install aleabot "C:\Program Files\nodejs\node.exe" "C:\path\to\aleabot-ng\dist\index.js"
nssm set aleabot AppDirectory "C:\path\to\aleabot-ng"
nssm set aleabot AppExit Default Restart
nssm start aleabot
# Manage: nssm stop aleabot / nssm restart aleabot / nssm remove aleabot
```

> Note: replace `C:\path\to\aleabot-ng` with your actual project directory.

### macOS

**Option A: Run directly**

```bash
npm run build
cp .env.example .env
npm start
```

**Option B: launchd auto-start (recommended)**

1. Save the plist below as `~/Library/LaunchAgents/com.aleabot.ng.plist` (replace `USERNAME`, the project path, and `/usr/local/bin/node` with your actual values):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.aleabot.ng</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/node</string>
      <string>/path/to/aleabot-ng/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/aleabot-ng</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/path/to/aleabot-ng/data/aleabot.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/aleabot-ng/data/aleabot.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
  </dict>
</plist>
```

2. Load and start:

```bash
launchctl load ~/Library/LaunchAgents/com.aleabot.ng.plist
launchctl start com.aleabot.ng
# View logs
tail -f /path/to/aleabot-ng/data/aleabot.log
```

**Option C: PM2 daemon**

```bash
npm install -g pm2
npm run build
pm2 start "node dist/index.js" --name aleabot
pm2 save
pm2 startup    # Run the generated command (macOS uses launchd)
```

### Using PM2 (cross-platform)

PM2 unifies process guarding across Linux / Windows / macOS, with log management and zero-downtime reloads:

```bash
npm install -g pm2
pm2 start "node dist/index.js" --name aleabot
pm2 logs aleabot          # view logs
pm2 restart aleabot       # restart after rebuilding
pm2 save                  # persist process list (restore on boot)
```

### Optional: Docker

For containerized deployment (consistent across platforms), create a `Dockerfile` at the project root:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --registry=https://registry.npmmirror.com
COPY . .
RUN npm run build
EXPOSE 8787
CMD ["node", "dist/index.js"]
```

```bash
docker build -t aleabot-ng .
docker run -d --name aleabot -p 8787:8787 -v "$(pwd)/data:/app/data" aleabot-ng
```

> Note: with Docker, OneBot (QQ) usually needs to share the network with NapCat — use `docker-compose`, or point `ONEBOT_WS_URL` at the host's NapCat address.

## Testing

```bash
npm run build
npm test
```

## Project Structure

```
aleabot-ng/
├── src/
│   ├── core/            Core (platform-agnostic)
│   │   ├── dice.ts      Dice expression engine
│   │   ├── command.ts   Command parsing
│   │   ├── sheet.ts     Character sheet generation
│   │   ├── store.ts     SQLite data layer
│   │   ├── backup.ts    Auto backup
│   │   ├── engine.ts    Business engine
│   │   └── random.ts    Random source
│   ├── platforms/       Platform adapters
│   │   ├── types.ts     Unified interface
│   │   ├── onebot.ts    QQ (OneBot 11)
│   │   ├── kook.ts      KOOK
│   │   └── manager.ts   Adapter manager
│   ├── web/server.ts    Admin panel API
│   └── index.ts         Entry point
├── public/index.html    Admin panel page
├── tests/               Unit tests
└── deploy/              Deploy scripts
```

## License

[MIT](LICENSE)
