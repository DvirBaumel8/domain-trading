import { z } from 'zod';
import { AppError } from '../http/errors.js';

/** The approval_ref object as bots send it: text and approved_at are checked later by the approval service, not by zod. */
export const approvalRefObject = z.object({ text: z.unknown().optional(), approved_at: z.unknown().optional() }).strict();
/** approval_ref as an optional, nullable body field (the route decides whether it is required). */
export const approvalRef = approvalRefObject.nullable().optional();

/** The personal-data rule shared by /offers, /sold, /export uploads and /candidates/intake: free text carries no '@'. */
export const hasAtSign = (v: string | null | undefined): boolean => v != null && v.includes('@');
/** 422 NO_PII with the caller's message and optional details. */
export const piiError = (message: string, details?: Record<string, unknown>): AppError => new AppError(422, 'NO_PII', message, details);
/** The `note` field of /offers, /offers/:id and uploaded exports. */
export function assertNoteNoPii(note: string | null | undefined): void {
  if (hasAtSign(note)) throw piiError("note must not contain an email address or '@'");
}
