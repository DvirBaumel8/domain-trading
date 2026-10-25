// v5.47.0 (F20): the adult and forbidden-term filter of the auction shortlist. `bestnaked.com` passed the v5.46.0 name rules (SPELL-1, BRAND-1, BIGCO-1, TM_KILL), which do not look for
// adult words, and GoDaddy's own `isAdult` flag only catches part of them. Two rules, applied to every shortlist candidate before it is scored:
//   ADULT_TERM      a word of the name (the form tokens, or the engine split) is an adult word, or the whole name holds an unambiguous adult stem (porn, xxx, nude, naked, ...).
//   FORBIDDEN_TERM  an active, not retired `forbidden_terms` term (the company's own list) is inside the name (the same substring rule as the closeout classifier).
// The lists are frozen here (a word list is data, not a pricing rule); the company list is read from the database. Pure after loading.
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { termKey } from '../../selection/index.js';

/** Whole words: the name is refused when one of its words equals one of these (so `essex`, `class`, `scunthorpe` are fine). */
export const ADULT_WORDS: ReadonlySet<string> = new Set([
  'sex', 'sexy', 'sexed', 'sexual', 'sexting', 'sexcam', 'sexchat', 'porn', 'porno', 'pornstar', 'xxx', 'nude', 'nudes', 'naked', 'nudist', 'nsfw', 'erotic', 'erotica', 'escort', 'escorts',
  'fetish', 'kink', 'kinky', 'hentai', 'milf', 'milfs', 'stripper', 'strippers', 'striptease', 'brothel', 'whore', 'whores', 'slut', 'sluts', 'horny', 'orgy', 'orgasm', 'cum', 'cumshot',
  'dildo', 'vibrator', 'blowjob', 'handjob', 'anal', 'bdsm', 'camgirl', 'camgirls', 'topless', 'lingerie', 'playboy', 'hooker', 'hookers', 'incest', 'fuck', 'fucking', 'fucks', 'cock', 'cocks',
  'pussy', 'tits', 'titty', 'boobs', 'boobies', 'naughty', 'swinger', 'swingers', 'onlyfans', 'redtube', 'xvideos', 'camsex', 'lewd', 'bondage', 'masturbate', 'masturbation', 'voyeur',
]);

/** Stems that are adult wherever they sit in the name (long or odd enough that a false hit is rare and cheap). */
export const ADULT_STEMS: readonly string[] = ['porn', 'xxx', 'nude', 'naked', 'hentai', 'erotic', 'fetish', 'nsfw', 'orgasm', 'blowjob', 'handjob', 'masturbat', 'camgirl', 'onlyfans', 'sexcam', 'sexchat', 'escortservice'];

export type AdultCode = 'ADULT_TERM' | 'FORBIDDEN_TERM';

export interface AdultFilter { check(domain: string, words: readonly string[]): { code: AdultCode; term: string } | null }

/** Loads the company's active forbidden terms once (a few dozen). */
export async function adultFilter(db: Kysely<Database>): Promise<AdultFilter> {
  const forbidden = (await db.selectFrom('forbidden_terms as t').leftJoin('forbidden_term_retirements as r', 'r.term_id', 't.id').select('t.term').where('r.id', 'is', null).execute())
    .map((r) => ({ raw: r.term, key: termKey(r.term) })).filter((t) => t.key !== '');
  return {
    check(domain, words) {
      const sld = domain.trim().toLowerCase().replace(/\.com$/, '');
      const key = termKey(sld);
      for (const w of words) if (ADULT_WORDS.has(w.toLowerCase())) return { code: 'ADULT_TERM', term: w.toLowerCase() };
      if (ADULT_WORDS.has(key)) return { code: 'ADULT_TERM', term: key };
      for (const s of ADULT_STEMS) if (key.includes(s)) return { code: 'ADULT_TERM', term: s };
      for (const t of forbidden) if (key.includes(t.key)) return { code: 'FORBIDDEN_TERM', term: t.raw };
      return null;
    },
  };
}
