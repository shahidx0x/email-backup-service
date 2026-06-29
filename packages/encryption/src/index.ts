import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedCredential {
  ciphertext: string;
  initializationVector: string;
  authenticationTag: string;
  keyVersion: number;
}

export class CredentialCipher {
  constructor(private readonly keys: ReadonlyMap<number, Buffer>, private readonly activeVersion: number) {
    const key = keys.get(activeVersion);
    if (!key || key.length !== 32) throw new Error('Active AES-256-GCM key must contain exactly 32 bytes');
  }

  encrypt(plaintext: string, context: string): EncryptedCredential {
    const key = this.keys.get(this.activeVersion);
    if (!key) throw new Error('Encryption key version unavailable');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'), initializationVector: iv.toString('base64'),
      authenticationTag: cipher.getAuthTag().toString('base64'), keyVersion: this.activeVersion,
    };
  }

  decrypt(value: EncryptedCredential, context: string): string {
    const key = this.keys.get(value.keyVersion);
    if (!key) throw new Error(`Encryption key version ${value.keyVersion} unavailable`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.initializationVector, 'base64'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(value.authenticationTag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}
