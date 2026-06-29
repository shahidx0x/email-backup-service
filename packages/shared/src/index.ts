import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';

export const createRequestId = (): string => randomUUID();
export const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

export function sanitizeFilename(value: string | undefined, fallback = 'attachment.bin'): string {
  const safeBase = basename((value ?? fallback).replaceAll('\\', '/'));
  const cleaned = safeBase.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || fallback).slice(0, 180);
}

export function protectCsvValue(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export interface ApiErrorResponse {
  statusCode: number;
  code: string;
  message: string;
  requestId: string;
  timestamp: string;
  path: string;
}
