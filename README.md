# claude-telegram-enhanced

Enhanced Telegram channel plugin for Claude Code — adds topic-per-session routing, response streaming via drafts, and topic lifecycle management.

Forked from [anthropics/claude-plugins-official/telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram). Fully backwards-compatible with the original plugin.

## What's new

| Feature | Description |
| --- | --- |
| **Shared polling daemon** | A single background daemon owns the `getUpdates` poll. Multiple plugin instances consume from per-topic inboxes — no 409 conflicts. |
| **Topic routing** | Bind a Claude session to a single Telegram topic. Multiple sessions share one bot without conflicts. |
| **Auto-create topics** | Set `TELEGRAM_TOPIC_NAME` and a topic is created on boot, named after your worktree/session. |
| **Response streaming** | `send_draft` tool uses Telegram's `sendMessageDraft` API to show responses building in real-time. |
| **Topic lifecycle** | `create_topic`, `edit_topic`, `delete_topic` tools for managing topics programmatically. |
| **Scoped indicators** | Typing indicators and ack reactions appear in the correct topic, not just the top-level chat. |

## Architecture

```
┌─────────────────────────────────────────────────┐
│  daemon.ts (single process per machine)         │
│  Owns the getUpdates poll, runs gate(),         │
│  writes JSON envelopes to per-topic dirs        │
└───────────┬─────────────┬───────────────────────┘
            │             │
   topics/41/       topics/55/
            │             │
┌───────────┴───┐ ┌───────┴───────────┐
│  server.ts    │ │  server.ts        │
│  (worktree A) │ │  (worktree B)     │
│  MCP server   │ │  MCP server       │
│  watches 41/  │ │  watches 55/      │
└───────────────┘ └───────────────────┘
```

Each `server.ts` is an MCP server spawned by Claude Code. It does **not** poll Telegram — it watches its topic's inbox directory via `fs.watch` + polling fallback. The daemon is spawned automatically on first use and persists across sessions.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- A Telegram bot token (see setup below)

## Telegram setup

### 1. Create a bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, pick a name and username
3. Copy the token (`123456789:AAHfiqksKZ8...`)

### 2. Enable topics (Threaded Mode)

Topics require a **group chat** — they don't work in private bot chats.

1. In BotFather, send `/mybots` → select your bot → **Bot Settings** → **Threaded Mode** → Enable
2. Also turn **off** Group Privacy: **Bot Settings** → **Group Privacy** → Turn off (so the bot receives all messages, not just commands and mentions)

### 3. Create a group chat

1. Create a new Telegram group (or use an existing one)
2. Enable **Topics**: Group settings → Topics → toggle on
3. Add your bot to the group and **make it an admin** (it needs admin rights to create/close topics and react to messages)

### 4. Get the group's chat ID

Add [@userinfobot](https://t.me/userinfobot) to the group temporarily — it will print the chat ID (a negative number like `-1001234567890`). Remove it after.

Alternatively, forward any message from the group to [@userinfobot](https://t.me/userinfobot) in a private chat.

## Plugin installation

### 1. Register the marketplace

```
claude plugin marketplace add vladzima/claude-telegram-enhanced
```

### 2. Install the plugin

```
claude plugin install telegram-enhanced@claude-telegram-enhanced
```

### 3. Configure the token

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Or write it directly:

```bash
mkdir -p ~/.claude/channels/telegram
echo 'TELEGRAM_BOT_TOKEN=123456789:AAHfiqksKZ8...' > ~/.claude/channels/telegram/.env
```

### 4. Launch with the channel flag

```sh
claude --channels plugin:telegram-enhanced@claude-telegram-enhanced
```

> **Note:** If this is the first time loading a development channel, you'll see a safety prompt — select "I am using this for local development" and press Enter.

### 5. Pair with the bot

DM your bot on Telegram — it replies with a 6-character code. In Claude Code:

```
/telegram:access pair <code>
```

Then lock access so only you can use the bot:

```
/telegram:access policy allowlist
```

You only need to pair once. The pairing persists across sessions.

## Topic routing

Each Claude session can be bound to a dedicated Telegram topic using environment variables:

| Variable | Description |
| --- | --- |
| `TELEGRAM_TOPIC_ID` | Bind to an existing topic by its `message_thread_id`. |
| `TELEGRAM_TOPIC_NAME` | Create a new topic with this name on boot (requires `TELEGRAM_TOPIC_CHAT_ID`). |
| `TELEGRAM_TOPIC_CHAT_ID` | The chat ID to create the topic in (used with `TELEGRAM_TOPIC_NAME`). |

When bound, the session **only** receives messages from its topic and **all** replies are automatically routed there.

### Example: one bot, many sessions

```bash
# Session 1 — gets its own topic "feature-auth"
TELEGRAM_TOPIC_NAME="feature-auth" TELEGRAM_TOPIC_CHAT_ID="-1001234567890" \
  claude --channels plugin:telegram-enhanced@claude-telegram-enhanced

# Session 2 — gets its own topic "bugfix-api"
TELEGRAM_TOPIC_NAME="bugfix-api" TELEGRAM_TOPIC_CHAT_ID="-1001234567890" \
  claude --channels plugin:telegram-enhanced@claude-telegram-enhanced
```

Both sessions run the same bot. Messages in the "feature-auth" topic go to session 1; messages in "bugfix-api" go to session 2.

### Topic teardown

When a session ends, its topic can be closed (archived) via the Telegram API. The plugin persists topic metadata (`meta.json`) in the daemon's topic directory so external scripts can find the thread ID by topic name and call `closeForumTopic`.

See [superset-claude-telegram](https://github.com/vladzima/superset-claude-telegram) for an automated teardown example.

## Tools

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat/topic. Takes `chat_id` + `text`, optionally `message_thread_id`, `reply_to`, `files`, `format`. Auto-chunks at 4096 chars. |
| `send_draft` | Stream a partial response via `sendMessageDraft`. Call repeatedly with the same `draft_id` and progressively longer text. The draft disappears when a real reply is sent. |
| `react` | Add an emoji reaction. Only Telegram's fixed whitelist is accepted. |
| `edit_message` | Edit a previously sent bot message. No push notification triggered. |
| `download_attachment` | Download a file by `file_id` to local inbox. |
| `create_topic` | Create a forum topic. Returns `message_thread_id`. |
| `edit_topic` | Rename or change icon of a topic. |
| `delete_topic` | Delete a topic and all its messages. |

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, and the `access.json` schema. Fully compatible with the original plugin's access system.

## Photos and attachments

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/`. Other attachments (documents, voice, video) include a `file_id` in the notification metadata — use `download_attachment` to fetch them.

## No history or search

Telegram's Bot API has no message history or search. The bot only sees messages as they arrive. If earlier context is needed, the assistant will ask you to paste or summarize.

## Integration with Superset

For automatic topic-per-worktree setup with [Superset](https://superset.sh), see [superset-claude-telegram](https://github.com/vladzima/superset-claude-telegram).
