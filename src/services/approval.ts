import { ISO_WITH_OFFSET } from '../core/dates.js';

export type ApprovalCheck =
  | { ok: true; approvedAt: Date }
  | { ok: false; code: 'APPROVAL_INVALID' | 'APPROVAL_EXPIRED'; reason: string };

const SKEW_MS = 60_000;

/** A name (domain, settings label, list name) must appear on label boundaries: `x.com` is not named by `ba.com`, `x.com.au`, `www.x.com`, `x.company`; `v1` is not named by `v1b`. */
export function namesToken(text: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9._-])${esc}(?![a-z0-9_-]|\\.[a-z0-9])`, 'i').test(text);
}
const namesDomain = namesToken;

/** Text present, ISO time with an offset, not in the future (60 s skew), not older than `maxAgeHours`. Does not look for a domain name. */
export function checkTimedApproval(
  ref: { text?: unknown; approved_at?: unknown } | null | undefined,
  now: Date,
  maxAgeHours: number,
): ApprovalCheck {
  const bad = (reason: string): ApprovalCheck => ({ ok: false, code: 'APPROVAL_INVALID', reason });
  if (!ref || typeof ref.text !== 'string' || ref.text.trim() === '') return bad('approval_ref.text is required');
  return checkTime(ref, now, maxAgeHours);
}

export function checkApproval(
  ref: { text?: unknown; approved_at?: unknown } | null | undefined,
  domain: string,
  now: Date,
  maxAgeHours: number,
): ApprovalCheck {
  const bad = (reason: string): ApprovalCheck => ({ ok: false, code: 'APPROVAL_INVALID', reason });
  if (!ref || typeof ref.text !== 'string' || ref.text.trim() === '') return bad('approval_ref.text is required');
  if (!namesDomain(ref.text, domain)) return bad('approval_ref.text must name the domain');
  return checkTime(ref, now, maxAgeHours);
}

function checkTime(ref: { approved_at?: unknown }, now: Date, maxAgeHours: number): ApprovalCheck {
  const bad = (reason: string): ApprovalCheck => ({ ok: false, code: 'APPROVAL_INVALID', reason });
  if (typeof ref.approved_at !== 'string' || !ISO_WITH_OFFSET.test(ref.approved_at)) {
    return bad('approval_ref.approved_at must be ISO 8601 with a timezone offset');
  }
  const approvedAt = new Date(ref.approved_at);
  if (Number.isNaN(approvedAt.getTime())) return bad('approval_ref.approved_at is not a valid time');
  if (approvedAt.getTime() > now.getTime() + SKEW_MS) return bad('approval_ref.approved_at is in the future');
  if (now.getTime() - approvedAt.getTime() > maxAgeHours * 3_600_000) {
    return { ok: false, code: 'APPROVAL_EXPIRED', reason: `approval is older than ${maxAgeHours} h` };
  }
  return { ok: true, approvedAt };
}
