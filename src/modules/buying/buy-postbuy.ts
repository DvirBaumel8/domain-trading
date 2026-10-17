// What happens after a /buy booked the purchase (buy.md step 7): pricing evidence, privacy, auto-renew off, the lander nameservers and the proposed
// listing. Each failure is a warning; nothing here undoes the purchase.
import { idtDay } from '../../core/dates.js';
import { withDomainLock } from '../../core/locks.js';
import { RegistrarError, nsPendingWarning, type DomainInfo } from '../registrars/index.js';
import { applyPlan, changedColumns, domainPlanColumns, landerNameservers, planView, sameNsSet, type ListingPlan } from '../listing/index.js';
import { withPolicyLine, type Approved, type BuyDeps } from './buy-types.js';

/** buy.md step 7: each failure is a warning; nothing here undoes the purchase. */
export async function postBuy(deps: BuyDeps, a: Approved, info: DomainInfo | null, warnings: string[]) {
  const { db } = deps;
  const d = a.input.domain;
  const hint = (e: unknown, what: string) =>
    e instanceof RegistrarError && e.code === 'API_ACCESS_DISABLED'
      ? 'API_ACCESS_DISABLED: turn on "Opt In All Domains" at porkbun.com/account/api, then call /list again'
      : `${what}: ${e instanceof RegistrarError ? e.code : 'error'}`;
  const post: { privacy: string; auto_renew: string; lander: string; listing: unknown } = {
    privacy: 'unknown', auto_renew: 'unconfirmed', lander: 'skipped', listing: null,
  };

  // 7.0 pricing evidence (first: nothing below may keep it from being saved) (the comps behind this buy); a failure is a warning, never an undo
  try {
    await db.insertInto('pricing_evidence').values({
      domain_id: (await db.selectFrom('domains').select('id').where('domain', '=', d).executeTakeFirstOrThrow()).id,
      comps: JSON.stringify(a.comps), rationale: a.rationale, audit_id: a.ctx.auditId,
    }).execute();
  } catch (e) {
    deps.log?.error({ errMessage: (e as Error).message }, 'post-buy evidence save failed');
    warnings.push('EVIDENCE_SAVE_FAILED: the purchase is booked but the comps were not saved; record them with a pricing note');
  }

  // 7.1 privacy
  if (info?.whoisPrivacy === true) post.privacy = 'on';
  else if (info?.whoisPrivacy === false) {
    post.privacy = 'off';
    warnings.push('PRIVACY_OFF: WHOIS privacy is off and Porkbun has no API to turn it on after registration; turn it on in the Porkbun dashboard');
  } else warnings.push('PRIVACY_UNKNOWN: could not confirm WHOIS privacy; check the registrar dashboard');

  // 7.2 auto-renew off, then verify
  try {
    await a.adapter.setAutoRenew(d, false);
    const after = await a.adapter.findDomain(d);
    if (after?.autoRenew === false) post.auto_renew = 'off';
    else warnings.push('AUTO_RENEW_NOT_CONFIRMED: auto-renew may still be on; turn it off in the registrar dashboard');
  } catch (e) {
    warnings.push(hint(e, 'AUTO_RENEW_FAILED'));
  }

  // 7.3 auto_list
  if (a.input.autoList) {
    const target = a.settings.lander_target;
    const ns = landerNameservers(target);
    if (!ns) warnings.push('LANDER_CUSTOM: lander_target is custom; call /list with explicit nameservers');
    else {
      try {
        const nsRes = await a.adapter.setNameservers(d, [...ns]);
        const got = nsRes && nsRes.pending ? null : await a.adapter.getNameservers(d);
        if (got === null) {
          post.lander = 'pending';
          warnings.push(nsPendingWarning(a.adapter.name));
          await saveLander(deps, d, target, ns);
        } else if (sameNsSet(got, ns)) {
          post.lander = `${target} ns set`;
          await saveLander(deps, d, target, ns);
        } else {
          post.lander = 'mismatch';
          warnings.push('LANDER_MISMATCH: the registrar reports different nameservers; call /list again');
        }
      } catch (e) {
        post.lander = 'failed';
        warnings.push(hint(e, 'LANDER_FAILED'));
      }
    }
    if (a.plan) await saveListing(deps, a, a.plan, post, warnings);
  }
  return post;
}

/** The lander columns, written under the per-domain lock so a concurrent /list can't be overwritten. */
async function saveLander(deps: BuyDeps, d: string, target: string, ns: readonly string[]): Promise<void> {
  await withDomainLock(deps.db, d, async (conn) => {
    const at = new Date();
    await conn.updateTable('domains').set({ lander: target, lander_ns: [...ns], lander_set_at: at, updated_at: at })
      .where('domain', '=', d).execute();
  });
}

/** Plan + schedule + history under the per-domain lock. Runs after the reservation and bookkeeping transactions committed, so it can't deadlock with /buy's xact lock. */
async function saveListing(deps: BuyDeps, a: Approved, plan: ListingPlan, post: { listing: unknown }, warnings: string[]): Promise<void> {
  const d = a.input.domain;
  const now = new Date(deps.now());
  warnings.push(...plan.warnings);
  try {
    const events = await withDomainLock(deps.db, d, (conn) => conn.transaction().execute(async (trx) => {
      const row = await trx.selectFrom('domains').selectAll().where('domain', '=', d).forUpdate().executeTakeFirstOrThrow();
      if (row.status !== 'owned' || !row.drop_date) throw new Error(`domain is ${row.status}, not owned`);
      await trx.updateTable('domains').set({
        ...domainPlanColumns(plan), status: 'listed', category: a.category, price_grade: plan.grade,
        first_listed_at: now, ...changedColumns(row, now), updated_at: now,
      }).where('id', '=', row.id).execute();
      return applyPlan(trx, {
        domainId: row.id, plan, source: 'buy', category: a.category, lander: a.settings.lander_target, override: plan.overrideUsed,
        overrideReason: plan.overrideUsed ? a.input.overrideReason : null, approvalText: String(a.input.approval?.text), approvalAt: a.approvedAt,
        auditId: a.ctx.auditId, anchor: idtDay(now), dropDate: row.drop_date, settings: a.pricing, now,
      });
    }));
    post.listing = withPolicyLine(planView(plan, events), a.dropPolicy, a.winner.renewalCents);
  } catch (e) {
    // Post-buy never undoes or masks a booked purchase (controller ruling, step 3 Task 2 review).
    deps.log?.error({ errMessage: (e as Error).message }, 'post-buy listing save failed');
    warnings.push('LISTING_SAVE_FAILED: the purchase is booked but the proposed listing was not saved; call /list');
  }
}
