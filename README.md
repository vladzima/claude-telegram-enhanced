# claude-telegram-enhanced

Enhanced Telegram channel plugin for Claude Code — adds topic-per-session routing, response streaming via drafts, and topic lifecycle management.

Forked from [anthropics/claude-plugins-official/telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram). Fully backwards-compatible with the original plugin.

## What's new

| Feature | Description |
| --- | --- |
| **Topic routing** | Bind a Claude session to a single Telegram topic. Multiple sessions share one bot without conflicts. |
| **Auto-create topics** | Set `TELEGRAM_TOPIC_NAME` and a topic is created on boot, named after your worktree/session. |
| **Response streaming** | `send_draft` tool uses Telegram's `sendMessageDraft` API to show responses building in real-time. |
| **Topic lifecycle** | `create_topic`, `edit_topic`, `delete_topic` tools for managing topics programmatically. |
| **Scoped indicators** | Typing indicators appear in the correct topic, not just the top-level chat. |

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- A Telegram bot with **Threaded Mode** enabled via [@BotFather](https://t.me/BotFather) (required for topics; without it, the plugin works identically to the original)

## Quick setup

### 1. Create a bot with BotFather

Open [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, pick a name and username. Copy the token (`123456789:AAHfiqksKZ8...`).

To enable topics, open the BotFather Mini App and toggle **Threaded Mode** on for your bot.

### 2. Install the plugin

```
/plugin install telegram-enhanced@vladzima/claude-telegram-enhanced
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
claude --channels plugin:telegram-enhanced@vladzima/claude-telegram-enhanced
```

### 5. Pair

DM your bot on Telegram — it replies with a 6-character code. In Claude Code:

```
/telegram:access pair <code>
```

Then lock access: `/telegram:access policy allowlist`

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
TELEGRAM_TOPIC_NAME="feature-auth" TELEGRAM_TOPIC_CHAT_ID="123456" \
  claude --channels plugin:telegram-enhanced@vladzima/claude-telegram-enhanced

# Session 2 — gets its own topic "bugfix-api"
TELEGRAM_TOPIC_NAME="bugfix-api" TELEGRAM_TOPIC_CHAT_ID="123456" \
  claude --channels plugin:telegram-enhanced@vladzima/claude-telegram-enhanced
```

Both sessions run the same bot. Messages in the "feature-auth" topic go to session 1; messages in "bugfix-api" go to session 2.

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
