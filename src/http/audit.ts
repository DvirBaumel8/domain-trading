import { randomBytes } from 'node:crypto';

export function newAuditId(): string {
  return `aud_${randomBytes(16).toString('hex')}`;
}
