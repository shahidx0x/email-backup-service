import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';

export interface ImapConnectionConfig {
  host: string; port: number; secure: boolean; servername?: string; rejectUnauthorized: boolean;
  username: string; password: string; connectionTimeoutMs: number;
}
export interface DiscoveredFolder { path: string; name: string; delimiter: string; specialUse?: string; selectable: boolean; subscribed?: boolean; }

export function detectSentFolder(folders: readonly DiscoveredFolder[], override?: string): string | undefined {
  if (override && folders.some((f) => f.path === override && f.selectable)) return override;
  const special = folders.find((f) => f.specialUse?.toLowerCase() === '\\sent' && f.selectable);
  if (special) return special.path;
  const candidates = ['Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent', 'INBOX/Sent'];
  for (const candidate of candidates) {
    const match = folders.find((f) => f.selectable && f.path.toLowerCase() === candidate.toLowerCase());
    if (match) return match.path;
  }
  return undefined;
}

export class ImapClientService {
  createClient(config: ImapConnectionConfig): ImapFlow {
    return new ImapFlow({ host: config.host, port: config.port, secure: config.secure, servername: config.servername,
      auth: { user: config.username, pass: config.password }, tls: { rejectUnauthorized: config.rejectUnauthorized },
      connectionTimeout: config.connectionTimeoutMs, greetingTimeout: config.connectionTimeoutMs, logger: false });
  }
  async testConnection(config: ImapConnectionConfig): Promise<void> { const c=this.createClient(config); try { await c.connect(); await c.noop(); } finally { if (c.usable) await c.logout().catch(()=>undefined); } }
  async listFolders(config: ImapConnectionConfig): Promise<DiscoveredFolder[]> {
    const c=this.createClient(config); try { await c.connect(); const boxes=await c.list(); return boxes.map((b) => ({
      path:b.path, name:b.name, delimiter:b.delimiter, specialUse:b.specialUse, selectable:!b.flags.has('\\Noselect'), subscribed:b.subscribed,
    })); } finally { if (c.usable) await c.logout().catch(()=>undefined); }
  }
  parse(raw: Buffer): Promise<ParsedMail> { return simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true }); }
}
