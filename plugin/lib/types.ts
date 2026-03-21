/**
 * Shared types for the enhanced Telegram channel daemon + plugin architecture.
 */

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  /** Emoji to react with on receipt. Empty string disables. */
  ackReaction?: string
  /** Which chunks get Telegram's reply reference when reply_to is passed. Default: 'first'. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 4096. */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

/** Snapshot of delivery-relevant access config, embedded in each envelope. */
export type AccessSnapshot = {
  ackReaction?: string
  replyToMode?: string
  textChunkLimit?: number
  chunkMode?: string
}

/** A single message routed by the daemon to a per-topic inbox directory. */
export type InboxEnvelope = {
  seq: number
  receivedAt: number
  topicId: number | null
  chatId: string
  messageId: number
  fromId: string
  fromUsername: string | undefined
  text: string
  ts: number
  isTopicMessage: boolean
  imagePath?: string
  attachment?: AttachmentMeta
  accessSnapshot: AccessSnapshot
}

/** Persisted topic metadata for teardown/cleanup. */
export type TopicMeta = {
  topicName: string
  chatId: string
  threadId: number
  createdAt: number
}
