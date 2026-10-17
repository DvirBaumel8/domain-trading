// POST /buy: the checks in order (approval, category, proposed listing, buy hold, pack, tranche, live availability, caps, renewal maths, account state,
// registrar dry run), then a dry-run answer or the money phase (buy-register.ts). The phases live in buy-dryrun.ts, buy-register.ts, buy-postbuy.ts.
import { AppError } from '../../http/errors.js';
import { addOneYear, idtDay } from '../../core/dates.js';
import { checkApproval } from '../../core/approval.js';
import { isValidDisplayName } from '../../domain-name.js';
import { pickWinner, type CheckService, type EvaluatedQuote, type RegistrarAdapter } from '../registrars/index.js';
import { checkSettingsVersion, currentSettings, isCategory, validateComps, validateListing, type ListingPlan } from '../listing/index.js';
import { activeSelectionSettings } from '../selection/index.js';
import { latestScreeningRun, screeningHold } from './buy-hold.js';
import { gateError, packGate, trancheGate, type BuyBlock } from './buy-gates.js';
import { smallBuyGate, smallBuyRequested } from './small-buy.js';
import { binForMath, renewalMath, screeningGroupOf, type RenewalMath } from './renewal-math.js';
import { assertDomainCap, assertNotOwned } from './buy-reserve.js';
import { assertAccountState, dryRunBody, gateFields, priceDetails, registrarDryRun, type Caps } from './buy-dryrun.js';
import { priorOutcome, purchase } from './buy-register.js';
import { policyFields, type Approved, type BuyCtx, type BuyDeps, type BuyInput, type BuyResult, type DropPolicy, type Horizon } from './buy-types.js';


export class BuyService {
  constructor(private readonly deps: BuyDeps) {}

  private adapter(name: string): RegistrarAdapter {
    const a = this.deps.adapters.find((x) => x.name === name);
    if (!a) throw new AppError(409, 'NO_ELIGIBLE_REGISTRAR', `No adapter for ${name}`);
    return a;
  }

  async buy(input: BuyInput, ctx: BuyCtx): Promise<BuyResult> {
    const { db } = this.deps;
    const now = new Date(this.deps.now());
    const settings = await db.selectFrom('settings').selectAll().executeTakeFirstOrThrow();

    // B4: purchase-level replay (real buys only), before the approval check so a same-key retry
    // gets the stored outcome even if the approval has since expired
    if (!input.dryRun) {
      const prior = await priorOutcome(this.deps, ctx, input.domain);
      if (prior) return prior;
    }

    // 3. approval
    const appr = checkApproval(input.approval, input.domain, now, settings.approval_max_age_hours);
    if (!appr.ok) throw new AppError(422, appr.code, appr.reason);

    // 3b. category + proposed listing (V1–V8), before any registrar call
    const pm = input.proposedListing?.mode;
    if (input.proposedListing && (typeof pm !== 'string' || !['bin', 'offer', 'hybrid'].includes(pm))) throw new AppError(422, 'MODE_INVALID', 'mode must be bin, offer or hybrid');
    if (!isCategory(input.category)) {
      throw new AppError(422, 'CATEGORY_REQUIRED', 'A valid category is required: geo, trend, b2b, collision, regulation, buzzword or other');
    }
    const category = input.category;
    if (category === 'geo' && !input.priceGrade) throw new AppError(422, 'GEO_GRADE_REQUIRED', 'Geo names need price_grade strong or weaker');
    if (category !== 'geo' && input.priceGrade) throw new AppError(422, 'GRADE_NOT_GEO', 'price_grade is only for geo names');
    const dropPolicy: DropPolicy = input.dropPolicy ?? 'after_one_renewal';
    const horizon: Horizon = input.horizon ?? 'evergreen';
    let displayName: string | null = null;
    if (input.displayName != null) {
      if (!isValidDisplayName(input.domain, input.displayName)) {
        throw new AppError(422, 'DISPLAY_NAME_MISMATCH', 'display_name must be the domain with different ASCII capitalisation only');
      }
      displayName = input.displayName;
    } else displayName = await this.defaultDisplayName(input.domain);
    const pricing = await currentSettings(db, now);
    const today = idtDay(now);
    let plan: ListingPlan | null = null;
    if (input.proposedListing) {
      const r = validateListing(input.proposedListing, {
        category, grade: input.priceGrade, phase: 'buy', settings: pricing, highValueMinBinCents: settings.high_value_min_bin_cents,
        override: input.override, overrideReason: input.overrideReason, approvalValid: true,
        noLto: horizon !== 'evergreen' || dropPolicy === 'at_first_expiry',
        today, dropDate: dropPolicy === 'at_first_expiry' ? addOneYear(today) : addOneYear(addOneYear(today)), // registered today + 1 y; the drop is 1 y later (none with at_first_expiry)
      });
      if (!r.ok) throw new AppError(r.status, r.code, r.message, r.details);
      plan = r.plan;
    }
    const ev = validateComps(input.pricingEvidence as { comps?: unknown; rationale?: unknown } | null, pricing, today);
    if (!ev.ok) throw new AppError(ev.status, ev.code, ev.message, ev.details);
    const ver = checkSettingsVersion(input.expectedSettingsVersion, pricing);
    if (ver) throw new AppError(ver.status, ver.code, ver.message, ver.details);

    const gateRefuses = !input.dryRun || input.strictDry === true; // a real buy, or a strict dry run, is refused at the first gate

    // 3c. buy hold (v1.1.0, R1): only a name that was screened. A dry run reports it instead of refusing.
    const latestRun = (await latestScreeningRun(db, input.domain)) ?? null; // read once per /buy (v5.14.0): the hold, the pack gate and the dry-run fields share it
    const hold = await screeningHold(db, input.domain, latestRun);
    // CR-030: with the exception requested, the hold is decided once the quote is known (price), below
    const smallBuy = smallBuyRequested(input.smallBuyException, input.approval?.text);
    if (hold && gateRefuses && !smallBuy) {
      throw new AppError(409, 'BUY_HOLD', `${input.domain} was screened under selection settings "${hold.settingsVersion}" while buy_hold is on (or the version is a backtest or no longer active); no real buy`,
        { settings_version: hold.settingsVersion, run_id: hold.runId });
    }

    // 3d. v2.0.0: a complete, current screening pack, then an open tranche . A dry run reports the first.
    let blocked: BuyBlock | null = hold && !smallBuy ? 'BUY_HOLD' : null;
    const pg = await packGate(db, input.domain, now.getTime(), latestRun);
    if (pg && gateRefuses) throw gateError(pg);
    blocked ??= pg?.code ?? null;
    const tg = await trancheGate(db, input.domain);
    if ('gate' in tg && gateRefuses) throw gateError(tg.gate);
    blocked ??= 'gate' in tg ? tg.gate.code : null;
    const trancheId = 'trancheId' in tg ? tg.trancheId : null;

    // v2.0.2: in a dry run an error after the DOM gates carries the gate fields of the 200 body
    let check!: Awaited<ReturnType<CheckService['check']>>;
    let winner!: EvaluatedQuote;
    let adapter!: RegistrarAdapter;
    let dry!: Awaited<ReturnType<typeof registrarDryRun>>;
    let accountWarnings: string[] = [];
    let math: RenewalMath | null = null;
    try {
      // 4, 5
      await assertNotOwned(db, input.domain);
      try {
        await assertDomainCap(db, settings);
      } catch (e) {
        // v4.0.0 (CR-045 item 3): a dry run reports the domain cap as would_be_blocked; a real buy (or a strict dry run) is refused
        if (gateRefuses || !(e instanceof AppError) || e.code !== 'DOMAIN_CAP_REACHED') throw e;
        blocked ??= 'DOMAIN_CAP_REACHED';
      }

      // 6. live re-check (no cache)
      check = await this.deps.checkService.check(input.domain, { useCache: false });
      if (check.availability !== 'available') {
        throw new AppError(409, 'NOT_AVAILABLE', `${input.domain} is not available`, { availability: check.availability, rdap: check.rdap });
      }
      let candidates = check.quotes;
      if (input.registrar) {
        const pinned = check.quotes.find((q) => q.registrar === input.registrar);
        if (!pinned?.eligible) {
          throw new AppError(409, 'PINNED_REGISTRAR_INELIGIBLE', `${input.registrar} can't register this domain; not falling back`, {
            registrar: input.registrar, exclusion_reason: pinned?.exclusionReason ?? 'NO_ADAPTER',
          });
        }
        candidates = [pinned];
      } else if (!check.quotes.some((q) => q.eligible)) {
        throw new AppError(409, 'NO_ELIGIBLE_REGISTRAR', 'No registrar can register this domain', {
          quotes: check.quotes.map((q) => ({ registrar: q.registrar, exclusion_reason: q.exclusionReason })),
        });
      }

      // 7. price caps, then the cheapest two-year
      const caps: Caps = { maxFirstYearCents: input.maxPriceCents, ...(input.maxTwoYearCents !== null ? { maxTwoYearCents: input.maxTwoYearCents } : {}) };
      const picked = pickWinner(candidates, caps);
      if (!picked) {
        throw new AppError(409, 'PRICE_ABOVE_MAX', 'Every eligible price is above your cap', { cheapest: priceDetails(pickWinner(candidates)!) });
      }
      winner = picked;
      adapter = this.adapter(winner.registrar);

      // 7b. v4.0.0 (CR-046 item 3): the renewal maths. Refused under buy.renewal_math_min; a dry run gets the same 422 with the numbers.
      const sel = (await activeSelectionSettings(db)).values.buy;
      const binForRatio = binForMath(category, input.priceGrade, plan?.binCents ?? null, pricing);
      if (binForRatio !== null && winner.renewalCents && input.stre !== undefined) {
        const commission = sel.commission[sel.math_venue];
        if (commission === undefined) throw new AppError(500, 'INTERNAL', `buy.commission has no entry for ${sel.math_venue}`);
        math = renewalMath({ binCents: binForRatio, commission, stre: input.stre, renewalCents: winner.renewalCents, min: sel.renewal_math_min, venue: sel.math_venue });
        if (!math.pass) {
          throw new AppError(422, 'RENEWAL_MATH_FAIL', `BIN x (1 - commission) x STRe is ${math.ratio}x the renewal cost, under the minimum ${math.min}`, { renewal_math: math });
        }
      }

      // 8. CR-030: the small-buy exception (price); a dry run reports a refusal as would_be_blocked
      if (smallBuy) {
        const sg = smallBuyGate(winner.firstYearCents!, winner.premium);
        if (sg) {
          if (gateRefuses) throw gateError(sg.gate);
          blocked ??= sg.gate.code;
        }
      }

      // 9. registrar account state
      accountWarnings = await assertAccountState(adapter, winner.firstYearCents!, input.dryRun);

      // 10. registrar dry run (re-quote once on COST_MISMATCH)
      dry = await registrarDryRun(this.deps, adapter, input.domain, winner, caps, settings.allowed_registrars,
        { input, ctx, approvedAt: appr.approvedAt, check, category, trancheId, smallBuy });

    } catch (e) {
      if (input.dryRun && e instanceof AppError) {
        // v3.7.1 (CR-038 #1): the buy card's display name and drop policy also ride on a dry-run error (e.g. REGISTRAR_FUNDS)
        throw new AppError(e.status, e.code, e.message, { ...e.details, ...(await gateFields(this.deps, input.domain, blocked, latestRun)), display_name: displayName, ...policyFields(dropPolicy, winner?.renewalCents ?? null) });
      }
      throw e;
    }
    winner = dry.winner;

    const approved: Approved = {
      input, ctx, category, plan, comps: ev.comps, rationale: ev.rationale, pricing, approvedAt: appr.approvedAt, check, winner, cost: dry.cost, adapter, wouldBeBlocked: blocked, latestRun, trancheId, smallBuy, displayName, dropPolicy, accountWarnings,
      horizon, screeningGroup: await screeningGroupOf(db, input.domain), math, streReason: input.streReason ?? null,
      settings: { max_domains: settings.max_domains, lander_target: settings.lander_target },
    };
    if (input.dryRun) return { status: 200, body: await dryRunBody(this.deps, approved) };
    return purchase(this.deps, approved);
  }

  /** CR-033 G-2: "UkCbamCompliance.com" from the newest intake `words` of the name (each word capitalised); null when none or not valid. */
  private async defaultDisplayName(domain: string): Promise<string | null> {
    const r = await this.deps.db.selectFrom('candidate_intake').select('words').where('domain', '=', domain).where('words', 'is not', null)
      .orderBy('received_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (!r?.words || r.words.length === 0) return null;
    const name = `${r.words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')}.com`;
    return isValidDisplayName(domain, name) ? name : null;
  }
}
