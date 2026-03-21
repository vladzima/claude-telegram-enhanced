#!/usr/bin/env bun
/**
 * Shared Telegram polling daemon.
 *
 * Owns the single getUpdates loop for the bot token. Routes incoming messages
 * to per-topic inbox directories as JSON envelopes. Plugin instances (server.ts)
 * watch their topic directory and deliver envelopes to Claude via MCP.
 *
 * This process is NOT an MCP server — it is a standalone background daemon.
 * Started automatically by plugin instances via ensureDaemon().
 */

import { Bot, GrammyError, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import {
  loadEnvFile, gate, loadAccess, APPROVED_DIR, INBOX_DIR, STATE_DIR,
} from './lib/gate.js'
import {
  writePidFile, removePidFile, nextSeq, writeEnvelope, topicDir,
} from './lib/daemon-client.js'
import type { AttachmentMeta, InboxEnvelope, AccessSnapshot } from './lib/types.js'

// Load token from .env
loadEnvFile()

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write('telegram daemon: TELEGRAM_BOT_TOKEN required\n')
  process.exit(1)
}

// Safety nets
process.on('unhandledRejection', err => {
  process.stderr.write(`telegram daemon: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram daemon: uncaught exception: ${err}\n`)
})

const bot = new Bot(TOKEN)
let botUsername = ''

// --- Pairing approval polling ---

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch { return }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
      () => rmSync(file, { force: true }),
      err => {
        process.stderr.write(`telegram daemon: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      },
    )
  }
}

setInterval(checkApprovals, 5000).unref()

// --- Filename sanitizer ---

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// --- Inbound message routing ---

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  const result = gate(ctx, botUsername)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(
      `${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`,
    )
    return
  }

  const access = result.access
  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id
  const threadId = ctx.message?.message_thread_id ?? null
  const isTopicMsg = ctx.message?.is_topic_message ?? false

  // Typing indicator
  const typingThreadId = threadId ?? undefined
  void bot.api.sendChatAction(chat_id, 'typing', {
    ...(typingThreadId != null ? { message_thread_id: typingThreadId } : {}),
  }).catch(() => {})

  // Ack reaction
  if (access.ackReaction && msgId != null) {
    void bot.api
      .setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ])
      .catch(() => {})
  }

  // Download photo if applicable
  const imagePath = downloadImage ? await downloadImage() : undefined

  // Build envelope
  const seq = nextSeq()
  const snapshot: AccessSnapshot = {
    ackReaction: access.ackReaction,
    replyToMode: access.replyToMode,
    textChunkLimit: access.textChunkLimit,
    chunkMode: access.chunkMode,
  }

  const envelope: InboxEnvelope = {
    seq,
    receivedAt: Date.now(),
    topicId: threadId,
    chatId: chat_id,
    messageId: msgId ?? 0,
    fromId: String(from.id),
    fromUsername: from.username,
    text,
    ts: ctx.message?.date ?? 0,
    isTopicMessage: isTopicMsg,
    imagePath,
    attachment,
    accessSnapshot: snapshot,
  }

  // Write to per-topic directory — the topic ID determines the directory.
  // Plugin instances watch their own topic directory.
  writeEnvelope(threadId, envelope)
}

// --- Bot commands (DM-only) ---

bot.command('start', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const access = loadAccess()
  if (access.dmPolicy === 'disabled') {
    await ctx.reply(`This bot isn't accepting new connections.`)
    return
  }
  await ctx.reply(
    `This bot bridges Telegram to a Claude Code session.\n\n` +
    `To pair:\n` +
    `1. DM me anything — you'll get a 6-char code\n` +
    `2. In Claude Code: /telegram:access pair <code>\n\n` +
    `After that, DMs here reach that session.`,
  )
})

bot.command('help', async ctx => {
  if (ctx.chat?.type !== 'private') return
  await ctx.reply(
    `Messages you send here route to a paired Claude Code session. ` +
    `Text and photos are forwarded; replies and reactions come back.\n\n` +
    `/start — pairing instructions\n` +
    `/status — check your pairing state`,
  )
})

bot.command('status', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const from = ctx.from
  if (!from) return
  const senderId = String(from.id)
  const access = loadAccess()

  if (access.allowFrom.includes(senderId)) {
    const name = from.username ? `@${from.username}` : senderId
    await ctx.reply(`Paired as ${name}.`)
    return
  }

  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(
        `Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`,
      )
      return
    }
  }

  await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
})

// --- Message type handlers ---

bot.on('message:text', async ctx => {
  await handleInbound(ctx, ctx.message.text, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      process.stderr.write(`telegram daemon: photo download failed: ${err}\n`)
      return undefined
    }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'document',
    file_id: doc.file_id,
    size: doc.file_size,
    mime: doc.mime_type,
    name,
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  const text = ctx.message.caption ?? '(voice message)'
  await handleInbound(ctx, text, undefined, {
    kind: 'voice',
    file_id: voice.file_id,
    size: voice.file_size,
    mime: voice.mime_type,
  })
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'audio',
    file_id: audio.file_id,
    size: audio.file_size,
    mime: audio.mime_type,
    name,
  })
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  const text = ctx.message.caption ?? '(video)'
  await handleInbound(ctx, text, undefined, {
    kind: 'video',
    file_id: video.file_id,
    size: video.file_size,
    mime: video.mime_type,
    name: safeName(video.file_name),
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', undefined, {
    kind: 'video_note',
    file_id: vn.file_id,
    size: vn.file_size,
  })
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker',
    file_id: sticker.file_id,
    size: sticker.file_size,
  })
})

// --- Error handler ---

bot.catch(err => {
  process.stderr.write(`telegram daemon: handler error (polling continues): ${err.error}\n`)
})

// --- Shutdown ---

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('telegram daemon: shutting down\n')
  removePidFile()
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// --- Start polling ---

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: async info => {
          botUsername = info.username
          writePidFile(process.pid)
          process.stderr.write(`telegram daemon: polling as @${info.username} (pid ${process.pid})\n`)

          void bot.api.setMyCommands(
            [
              { command: 'start', description: 'Welcome and setup guide' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'status', description: 'Check your pairing status' },
            ],
            { scope: { type: 'all_private_chats' } },
          ).catch(() => {})
        },
      })
      return
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 409) {
        const delay = Math.min(1000 * attempt, 15000)
        const detail = attempt === 1
          ? ' — another instance is polling (zombie session, or a second daemon?)'
          : ''
        process.stderr.write(
          `telegram daemon: 409 Conflict${detail}, retrying in ${delay / 1000}s\n`,
        )
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (err instanceof Error && err.message === 'Aborted delay') return
      process.stderr.write(`telegram daemon: polling failed: ${err}\n`)
      return
    }
  }
})()
