import { CredentialCipher } from './index';
test('encrypts and decrypts with mailbox-bound AAD', () => {
  const cipher = new CredentialCipher(new Map([[1, Buffer.alloc(32, 7)]]), 1);
  const encrypted = cipher.encrypt('secret', 'mailbox:abc');
  expect(cipher.decrypt(encrypted, 'mailbox:abc')).toBe('secret');
  expect(() => cipher.decrypt(encrypted, 'mailbox:def')).toThrow();
});
test('supports historical key versions', () => {
  const oldCipher = new CredentialCipher(new Map([[1, Buffer.alloc(32, 1)]]), 1);
  const encrypted = oldCipher.encrypt('secret', 'mailbox:abc');
  const rotated = new CredentialCipher(new Map([[1, Buffer.alloc(32, 1)], [2, Buffer.alloc(32, 2)]]), 2);
  expect(rotated.decrypt(encrypted, 'mailbox:abc')).toBe('secret');
});
