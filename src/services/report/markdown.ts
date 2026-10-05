import type { buildReport } from './index.js';

type Report = Awaited<ReturnType<typeof buildReport>>;
const cell = (v: unknown) => String(v ?? '').replaceAll('|', '\\|').replaceAll(/\s*\n\s*/g, ' ');
function table(head: string[], rows: unknown[][]): string {
  if (rows.length === 0) return '_None._\n';
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') + '\n';
}

/** A compact chat digest. The private walk-away is never written here (it is pasted into chat). */
export function reportMarkdown(r: Report): string {
  const b = r.budget;
  const parts: string[] = [`# Domain trading report\n\nGenerated ${r.generated_at}\n`];
  parts.push(`## Budget\n\n- Cap: ${b.poc_cap}\n- Spent: ${b.spent}\n- Remaining: ${b.remaining}\n- Committed forward (renewals): ${b.committed_forward.total}${b.committed_forward.complete ? '' : ` (incomplete: ${b.committed_forward.missing.join(', ')})`}\n- Domains: ${b.domains.count} of ${b.domains.max}\n`);
  parts.push(`## Sales & ROI\n\n- Sales: ${r.sales.count}\n- Gross: ${r.sales.gross}\n- Commission: ${r.sales.commission}\n- Fees: ${r.sales.fees}\n- Net: ${r.sales.net}\n- Profit: ${r.profit}\n- ROI: ${r.roi_pct === null ? 'n/a' : `${r.roi_pct}%`}\n`);
  parts.push(`## Domains\n\n${table(['Domain', 'Status', 'Mode', 'BIN', 'Floor', 'Next event'],
    r.per_domain.map((d) => [d.domain, d.status, d.listing_mode ?? '', d.bin ?? '', d.floor ?? '', d.next_price_event ? `${d.next_price_event.event} ${d.next_price_event.due_on}` : '']))}`);
  parts.push(`## Upcoming (90 days)\n\n${table(['Date', 'Domain', 'Kind', 'Note'], r.upcoming_90d.map((e) => [e.date, e.domain, e.kind, e.note]))}`);
  parts.push(`## Pending payouts\n\n${table(['Domain', 'Venue', 'Amount', 'Days pending'], r.payouts_pending.map((p) => [p.domain, p.venue, p.amount, p.days_pending]))}`);
  const w = r.warnings;
  parts.push(`## Warnings\n`);
  if (w.length === 0) parts.push('_None._\n');
  for (const level of ['error', 'warn', 'info'] as const) {
    const ws = w.filter((x) => x.level === level);
    if (ws.length) parts.push(`### ${level}\n\n${table(['Code', 'Domain', 'Message'], ws.map((x) => [x.code, x.domain ?? '', x.message]))}`);
  }
  return parts.join('\n');
}
