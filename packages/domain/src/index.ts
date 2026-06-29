export const USER_ROLES = ['super_admin', 'admin', 'auditor', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const MAILBOX_STATUSES = [
  'pending', 'testing', 'connecting', 'initial_sync', 'active', 'paused',
  'authentication_failed', 'connection_failed', 'disabled', 'error',
] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

export const QUEUE_NAMES = [
  'mailbox-connect', 'folder-discovery', 'initial-sync', 'incremental-sync',
  'imap-event', 'reconciliation', 'message-fetch', 'message-parse',
  'attachment-store', 'export', 'restore', 'integrity-check', 'retention',
  'cleanup', 'statistics',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  FORBIDDEN: 'FORBIDDEN',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  IMAP_AUTHENTICATION_FAILED: 'IMAP_AUTHENTICATION_FAILED',
  IMAP_CONNECTION_FAILED: 'IMAP_CONNECTION_FAILED',
  IMAP_TLS_FAILED: 'IMAP_TLS_FAILED',
  MONGODB_UNAVAILABLE: 'MONGODB_UNAVAILABLE',
  REDIS_UNAVAILABLE: 'REDIS_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
