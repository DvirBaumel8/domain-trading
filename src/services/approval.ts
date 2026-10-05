export type ApprovalCheck =
  | { ok: true; approvedAt: Date }
  | { ok: false; code: 'APPROVAL_INVALID' | 'APPROVAL_EXPIRED'; reason: string };

const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const SKEW_MS = 60_000;

/** The domain must appear on label boundaries: `x.com` is not named by `ba.com`, `x.com.au`, `www.x.com`, `x.company`. */
function namesDomain(text: string, domain: string): boolean {
  const esc = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9.-])${esc}(?![a-z0-9-]|\\.[a-z0-9])`, 'i').test(text);
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
  if (typeof ref.approved_at !== 'string' || !ISO_WITH_TZ.test(ref.approved_at)) {
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
