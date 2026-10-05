import { AppError } from './http/errors.js';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Lowercase, trim, drop one trailing dot; v1 accepts only second-level .com names. */
export function normalizeDomain(input: string): string {
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  const labels = d.split('.');
  if (d.length === 0 || d.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    throw new AppError(422, 'DOMAIN_INVALID', 'Not a valid domain name', { domain: input });
  }
  if (labels[labels.length - 1] !== 'com') {
    throw new AppError(422, 'TLD_NOT_SUPPORTED', 'Only .com names are supported in v1', { domain: d });
  }
  if (labels.length !== 2) {
    throw new AppError(422, 'DOMAIN_INVALID', 'Only second-level names (name.com) can be registered', { domain: d });
  }
  return d;
}

/** A display name is the domain with different ASCII capitalisation only (Unicode folds such as the Kelvin sign are refused). */
export function isValidDisplayName(domain: string, name: string): boolean {
  return /^[A-Za-z0-9.-]+$/.test(name) && name.toLowerCase() === domain;
}
