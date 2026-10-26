import { describe, expect, it } from 'vitest';
import { personName } from '../../../../src/modules/ops/auctions/person-names.js';

describe('AS556 PERSON_NAME (v5.56.0)', () => {
  it('AS556-1: a first name (Census 1990) + a surname (Census 2010) is caught at any split point; a first piece that is a common word, or real phrases, are not', () => {
    expect(personName('teresaperez')).toEqual({ first: 'teresa', last: 'perez' });
    expect(personName('johnsmith')).toEqual({ first: 'john', last: 'smith' });
    expect(personName('katiezimmerman')).toEqual({ first: 'katie', last: 'zimmerman' });
    for (const n of ['markwood', 'willpower', 'rosegarden', 'gymnest', 'absolutefaith', 'tooladvisor', 'stocktutor', 'definegroup', 'towncard', 'moneycrush', 'outswing']) expect(personName(n), n).toBeNull();
    expect(personName('perez')).toBeNull(); // too short to be two names
    expect(personName('john-smith')).toBeNull(); // letters only
  });
});
