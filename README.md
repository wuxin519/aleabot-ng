# AleaBot NG 🎲

<p align="center">
  <a href="README.md">🇨🇳 简体中文</a> &nbsp;|&nbsp; <a href="README_EN.md">🇬🇧 English</a>
</p>

> 多平台 TRPG（桌上角色扮演）跑团骰子机器人 —— **同时支持 QQ 与 KOOK**，内置网页管理后台与数据备份。

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/language-TypeScript-3178c6.svg" alt="Language">
  <img src="https://img.shields.io/badge/platform-QQ%20%C2%B7%20KOOK-07c160.svg" alt="Platforms">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933.svg" alt="Node">
  <img src="https://img.shields.io/badge/database-SQLite-003b57.svg" alt="Database">
</p>

## 目录

- [特性](#特性)
- [指令一览](#指令一览)
- [快速开始](#快速开始)
- [平台接入](#平台接入)
  - [为什么选择 QQ 与 KOOK](#为什么选择-qq-与-kook-而非微信-discord-其他)
  - [QQ 与 KOOK 对比](#qq-与-kook-对比)
- [管理后台](#管理后台)
- [数据与备份](#数据与备份)
- [部署](#部署)
- [测试](#测试)
- [项目结构](#项目结构)
- [许可证](#许可证)

## 特性

- **双平台同时在线**：QQ（OneBot 11）+ KOOK 官方 Bot API，单进程，数据互通
- **零依赖骰点引擎**：自研表达式解析，无第三方依赖，结果可复现、可测试
- **完整跑团指令**：普通掷骰 / COC 检定 / 角色卡生成 / 先攻管理 / 群级配置
- **网页管理后台**：实时状态、掷骰日志、角色卡管理、群配置、一键备份与导出
- **自动备份**：定时快照 + 保留策略 + 退出前自动备份，数据不怕丢
- **多平台数据隔离**：以 `(平台, 群, 用户)` 三元组隔离，QQ 与 KOOK 数据不串

## 指令一览

> **前缀说明**：所有指令以 `.` 开头，也可使用中文句号 `。` 代替（例如 `。r 3d6` 与 `.r 3d6` 完全等价）。群前缀可用 `.set prefix` 修改。

### 基础掷骰

| 指令 | 说明 | 示例 |
|------|------|------|
| `.r <表达式>` | 掷骰（支持多轮 / Fate / WoD / 双十字 / 中文优劣势 / 裸奖励骰） | `.r 3d6+2` · `.r 4d6k3` · `.r 2d20kh1` |
| `.r` | 掷默认骰（`.r d` 省略面数同样生效） | `.r` · `.r 2d` |
| `.r<表达式>` | 紧贴写法（主流骰娘习惯，检定/属性同理） | `.r3d100` · `.ra侦查60` · `.st力量88` |
| `.rh <表达式>` | 暗骰（群里只提示，结果私聊） | `.rh 1d100` |

### COC / 规则书检定

| 指令 | 说明 | 示例 |
|------|------|------|
| `.ra <技能> [值]` | COC 检定（省略值则读角色卡） | `.ra 侦查 60` |
| `.ra <技能>±<表达式>` | 属性调整（`+10` / `-5` / `+1d4`） | `.ra 侦查+10` |
| `.ra (困难\|极难\|大成功)<技能>` | 难度前缀（要求达到该等级才算成功） | `.ra 困难侦查` |
| `.rc <技能> [值]` | 规则书检定（无视群房规） | `.rc 侦查` |
| `.ra 3#b手枪` | 多列检定（连发，`b` 奖励骰 / `p` 惩罚骰） | `.ra 3#b2侦查 55` |
| `.rb` / `.rp` | 奖励骰 / 惩罚骰检定 | `.rb 侦查 60` |
| `.sc [成功扣/失败扣]` | 理智检定（大失败取最大扣，自动写回卡） | `.sc 0/1d10` |
| `.sc ... --cap=N` / `--half` | 理智损失**上限** / **减半**（可同用，先减半再截断） | `.sc 1/1d6 --cap=3` |
| `.rav @对手 <技能>` | 对抗检定（等级高者胜，同级比小） | `.rav @李四 侦查` |
| `.setcoc 0-5/dg` | 切换房规（0 规则书 / 2 常用 / dg 骰运） | `.setcoc dg` |
| `.setcoc details` | 列出全部可用房规 | `.setcoc details` |
| `.en <技能>...` | 成长检定（可一次多个） | `.en 侦查 聆听` |
| `.en <技能> +<失败>/<成功>` | 自定义成长点数（可含骰点/负数） | `.en 侦查 +0/1d6` |
| `.ti` / `.li` | 临时 / 长期疯狂表 | `.ti` |

### 角色卡

| 指令 | 说明 | 示例 |
|------|------|------|
| `.coc` / `.coc <N>` | 生成 COC 7 角色卡 / **批量掷 N 组主属性**（只主属性+HP+总值，不写卡） | `.coc` · `.coc 5` |
| `.coc5` / `.dnd` | 生成 COC 5（天命）/ D&D 5e 角色卡 | `.coc5` · `.dnd` |
| `.st <键> [值]` | 设置/查看属性（`.st hp+1` 增减） | `.st 力量 60` · `.st show` |
| `.st show <属性>` | 只看某项属性 | `.st show 侦查` |
| `.st del <属性>...` | **删除指定属性** | `.st del 幸运 魔法` |
| `.st clr` | **清空所有属性** | `.st clr` |
| `.st export` | **导出属性**（可复制到别的骰子） | `.st export` |
| `.st &名=表达式` | **保存计算表达式**（`.r 名` 调用） | `.st &手枪伤害=1d6+1` |
| `.st name <名字>` / `.sn` | 设置角色卡名字（同时是 bot 称呼你的昵称） | `.sn 张三` |
| `.st <键><值> ...` | **批量录入**（空格可省，一条录多个） | `.st 力量88 体质70 敏捷60` |
| `.st <数> <数> ...` | **按位置录入**（免键名，顺序同 `.st show`） | `.st 88 70 60 75 80 65 70 60 55` |
| `.st new <标题>` | 新建角色卡并切换（多卡） | `.st new 调查员A` |
| `.st list` / `.st switch <标题\|编号>` | 列出 / 切换角色卡 | `.st switch 2` |
| `.pc new/tag/list/del/show/nn` | 角色卡管理（**删卡用 `.pc del`**） | `.pc del 调查员A` |
| `.hp` / `.san` | HP/SAN 快捷（`+1`/`-1d4` 增减、`50` 设值） | `.hp-1d4` |

### 先攻 / 娱乐 / 日志 / 群管

| 指令 | 说明 | 示例 |
|------|------|------|
| `.init add <名> <先攻>` | 加入先攻 | `.init add 张三 15` |
| `.init list` / `.init clr` | 查看 / 清空先攻 | `.init list` |
| `.draw [牌堆] [数量]` | 抽牌（塔罗 / 扑克） | `.draw 塔罗 3` |
| `.drawlist` | 可用牌堆列表 | `.drawlist` |
| `.name cn 10` | 随机名字（cn / en / jp） | `.name en 5` |
| `.who A B C` | 顺序重排 | `.who 甲 乙 丙` |
| `.jrrp` | 今日人品（同日同人固定） | `.jrrp` |
| `.coin [数量]` | 抛硬币（正反面统计） | `.coin 3` |
| `.gugu` | 咕咕咕 | `.gugu` |
| `.stat` / `.hiy` | 本群 / 我的掷骰统计 | `.stat 今日` |
| `.log new [名称]` | 新建跑团日志并开始记录 | `.log new 黑圣杯` |
| `.log on` / `.log off` | 继续 / 暂停记录 | `.log off` |
| `.log end [json]` | 结束并导出文件 | `.log end json` |
| `.log get / list / stat / del` | 导出 / 列表 / 统计 / 删除日志 | `.log list` |
| `.ob` | 观众模式（发言标 `[OB]`，复盘可剔除） | `.ob` |
| `.help` / `.rule` | 指令图 / 规则速查 | `.help` |
| `.bot on/off/bye` | 群开关 / 退群（管理员；未配则不限） | `.bot off` |
| `.set <键> <值>` | 群配置（管理员） | `.set defaultDice 1d20` |
| `.bak` | 手动备份（管理员） | `.bak` |

### 骰点表达式语法

```
3d6          3 个 6 面骰
3d6+2-1      带常量加减
4d6k3        4d6 取最高的 3 个
4d6dl1       4d6 去掉最低的 1 个
2d20kh1      优势（取高）
2d20kl1      劣势（取低）
1d100<=50    COC 检定（带目标值，输出成功等级）
d / 2d       省略面数（用群默认骰）
d20优势      中文优势（= 2d20kh1）
3#2d50       多轮掷骰（掷 3 次给合计）
f            Fate 命运骰（4 枚 [-1/0/+1]）
5a6          WoD 无限骰（≥6 加骰、≥8 成功）
4c3          双十字骰（≥3 暴击续轮）
```

## 快速开始

### 1. 环境要求

- Node.js **≥ 18**
- 一个 OneBot 11 实现（用于 QQ）或一个 KOOK 机器人 Token

### 2. 安装与构建

```bash
npm install --registry=https://registry.npmmirror.com
npm run build
```

### 3. 配置

```bash
cp .env.example .env
# 编辑 .env，按注释填写各平台配置
```

### 4. 启动

```bash
npm start
```

启动后访问 `http://<主机IP>:8787/` 打开管理后台。

## 平台接入

### 为什么选择 QQ 与 KOOK （而非微信 Discord 其他）

> **选型原则**：面向国内用户，「**国内可直连**」是硬性前提；同时要求「有可稳定调用的机器人接口」「适合跑团场景」。

- **Discord**：自 2018 年起在中国大陆被墙，必须走代理才能连，直接排除。
- **微信（个人号）**：没有面向个人开发者的官方机器人接口；网页版协议早已收紧、随时可能失效，且风控极严，不适合做长驻机器人，排除。
- **Oopz 等小众平台**：缺少公开的第三方 Bot API，无法程序化收发消息，排除。
- **QQ**：国内用户基数最大。本项目不直接逆向 QQ，而是经由成熟框架（NapCat / Lagrange）以 **OneBot 11 标准协议**接入——登录由框架负责，本项目只收发标准消息，稳定可靠；QQ 群也是国内最现成的跑团场景。
- **KOOK（开黑啦）**：国产、国内可直连、官方 Bot API 成熟，且天生就是「语音 + 社区」属性，非常契合语音跑团与公开开黑房。官方 WebSocket 接口干净，适配成本低。

综合下来，**QQ 覆盖最广泛的熟人团，KOOK 补足语音团与公开社区**，二者互补，故定为双平台。

### QQ 与 KOOK 对比

| 维度 | QQ（OneBot 11） | KOOK（开黑啦） |
|------|----------------|----------------|
| 接入方式 | 经 NapCat / Lagrange 正向 WebSocket | 官方 Bot API（WebSocket） |
| 登录账号 | 你自己的 QQ 号（框架托管登录） | 独立机器人账号（开放平台注册） |
| 国内可达性 | ✅ 直连 | ✅ 直连 |
| 接口性质 | 社区协议（非官方但成熟） | 官方 API（最稳） |
| 封号风险 | 低（走协议框架，非逆向） | 无（官方接口） |
| 群 / 频道 | QQ 群，功能完整 | 服务器 / 频道 / 语音频道，社区属性强 |
| 语音能力 | 无原生语音（需外部工具） | 原生语音频道，天然适合语音跑团 |
| 适配成本 | 零（OneBot 标准，开箱即用） | 低（官方 API 清晰，已内置适配器） |
| 适合场景 | 熟人团、既有 QQ 群 | 语音团、公开社区、开黑房 |

> 双平台数据通过 `(平台, 群, 用户)` 三元组隔离，互不串扰；可在 `.env` 中分别开关 `ONEBOT_ENABLED` / `KOOK_ENABLED`，也可同时开启双平台在线。

### QQ（OneBot 11）

本地器人**不直接处理 QQ 登录**，而是连接一个 OneBot 实现框架：

1. 部署 [NapCat](https://github.com/NapNeko/NapCatQQ)（推荐）或 [Lagrange](https://github.com/LagrangeDev/Lagrange.Core)
2. 在其配置中开启 **正向 WebSocket 服务**（NapCat 默认端口 3001）
3. 在 `.env` 中设置：

```env
ONEBOT_ENABLED=true
ONEBOT_WS_URL=ws://127.0.0.1:3001
ONEBOT_TOKEN=     # 若框架设置了 access_token 则填写
```

> **为什么用 OneBot 而不是直接逆向 QQ 协议？**
> 逆向协议（oicq 等）需要模拟手机端登录，二维码频繁失效、随时可能被风控封号，
> 且底层库一旦升级就会崩。OneBot 由成熟框架负责登录，本项目只收发标准消息，稳定可靠。

### KOOK

1. 前往 [KOOK 开发者中心](https://developer.kookapp.cn/) 创建机器人应用
2. 复制 **Token**，并邀请机器人加入你的服务器
3. 在 `.env` 中设置：

```env
KOOK_ENABLED=true
KOOK_TOKEN=你的机器人Token
```

## 管理后台

访问 `http://<主机IP>:8787/`（如设置了 `ADMIN_TOKEN` 则需带 `?token=xxx`）：

- **概览**：平台在线状态、掷骰统计、运行时长、最近备份
- **掷骰日志**：按平台/关键词筛选，分页浏览全部历史
- **角色卡**：查看所有用户角色卡，可删除
- **群配置**：查看/修改各群的指令前缀、默认骰等
- **数据备份**：立即备份、下载快照、导出 JSON

## 数据与备份

- 数据库：`data/aleabot.db`（SQLite，WAL 模式）
- 备份目录：`data/backups/aleabot-backup-<时间>.db`
- 自动备份：默认每 24 小时一次，保留最近 14 份（可在 `.env` 调整）
- 退出保护：进程收到 SIGTERM/SIGINT 时会先备份再退出
- 手动备份：后台点「立即备份」，或群内管理员发 `.bak`

**恢复数据**：停止服务后，用备份文件覆盖 `data/aleabot.db` 即可。

## 部署

以下给出 **Linux / Windows / macOS** 三种平台的部署方式。无论哪种平台，都先完成通用前置步骤：

```bash
# 1. 安装依赖并构建
npm install --registry=https://registry.npmmirror.com
npm run build

# 2. 生成配置文件（按注释填写各平台配置）
cp .env.example .env

# 3. 启动（前台，用于验证）
npm start
#   启动后访问 http://<服务器IP>:8787/ 打开管理后台
```

### Linux（systemd）

使用仓库内置脚本一键安装为系统服务（开机自启、崩溃自动重启）：

```bash
sudo bash deploy/install.sh
sudo systemctl enable --now aleabot
# 查看状态 / 日志
systemctl status aleabot
journalctl -u aleabot -f
```

### Windows

**方式 A：直接运行（调试 / 临时）**

```powershell
npm run build
copy .env.example .env
npm start
```

**方式 B：PM2 守护（推荐，后台常驻 + 开机自启）**

```powershell
npm install -g pm2
npm run build
pm2 start "node dist/index.js" --name aleabot
pm2 save
pm2 startup          # 按屏幕提示，把输出的命令「以管理员身份」再执行一次，即可开机自启
```

**方式 C：注册为 Windows 服务（nssm，无窗口后台常驻）**

```powershell
# 先从 https://nssm.cc 下载 nssm，把 nssm.exe 所在目录加入 PATH
nssm install aleabot "C:\Program Files\nodejs\node.exe" "C:\path\to\aleabot-ng\dist\index.js"
nssm set aleabot AppDirectory "C:\path\to\aleabot-ng"
nssm set aleabot AppExit Default Restart
nssm start aleabot
# 管理：nssm stop aleabot / nssm restart aleabot / nssm remove aleabot
```

> 提示：`C:\path\to\aleabot-ng` 请替换为你实际的项目目录。

### macOS

**方式 A：直接运行**

```bash
npm run build
cp .env.example .env
npm start
```

**方式 B：launchd 开机自启（推荐）**

1. 将下方 plist 保存为 `~/Library/LaunchAgents/com.aleabot.ng.plist`（把 `USERNAME`、项目路径、`/usr/local/bin/node` 替换成你的实际值）：

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

2. 加载并启动：

```bash
launchctl load ~/Library/LaunchAgents/com.aleabot.ng.plist
launchctl start com.aleabot.ng
# 查看日志
tail -f /path/to/aleabot-ng/data/aleabot.log
```

**方式 C：PM2 守护**

```bash
npm install -g pm2
npm run build
pm2 start "node dist/index.js" --name aleabot
pm2 save
pm2 startup    # 按提示执行生成的命令（macOS 走 launchd）
```

### 使用 PM2 守护（跨平台通用）

PM2 可在 Linux / Windows / macOS 上统一守护进程，支持日志管理、零停机重载：

```bash
npm install -g pm2
pm2 start "node dist/index.js" --name aleabot
pm2 logs aleabot          # 查看日志
pm2 restart aleabot       # 改完代码重新构建后重启
pm2 save                  # 保存进程列表（开机恢复）
```

### 可选：Docker 部署

如需容器化（跨平台一致），在项目根目录新建 `Dockerfile`：

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

> 注意：用 Docker 时 OneBot（QQ）通常需要与 NapCat 同网络，建议用 `docker-compose` 编排，或把 `ONEBOT_WS_URL` 指向宿主机上的 NapCat 地址。

## 测试

```bash
npm run build
npm test
```

## 项目结构

```
aleabot-ng/
├── src/
│   ├── core/            核心（与平台无关）
│   │   ├── dice.ts      骰点表达式引擎
│   │   ├── command.ts   命令解析
│   │   ├── sheet.ts     角色卡生成
│   │   ├── store.ts     SQLite 数据层
│   │   ├── backup.ts    自动备份
│   │   ├── engine.ts    业务引擎
│   │   └── random.ts    随机源
│   ├── platforms/       平台适配器
│   │   ├── types.ts     统一接口
│   │   ├── onebot.ts    QQ（OneBot 11）
│   │   ├── kook.ts      KOOK
│   │   └── manager.ts   适配器管理
│   ├── web/server.ts    管理后台 API
│   └── index.ts         主入口
├── public/index.html    管理后台页面
├── tests/               单元测试
└── deploy/              部署脚本
```

## 许可证

[MIT](LICENSE)
