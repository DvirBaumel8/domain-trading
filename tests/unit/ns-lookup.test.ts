import { describe, expect, it } from 'vitest';
import { encodeNsQuery, parseNsResponse } from '../../src/dns/ns-lookup.js';

/** Test-only encoder for a DNS response carrying NS records in the answer or authority section. */
function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}
function nsRecord(owner: Buffer, target: Buffer): Buffer {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(2, 0); // type NS
  fixed.writeUInt16BE(1, 2); // class IN
  fixed.writeUInt32BE(172800, 4);
  fixed.writeUInt16BE(target.length, 8);
  return Buffer.concat([owner, fixed, target]);
}
function response(id: number, domain: string, ns: string[], section: 'answer' | 'authority', opts: { rcode?: number; compress?: boolean; tc?: boolean; owner?: string; qd?: number } = {}): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8000 | (opts.tc ? 0x0200 : 0) | (opts.rcode ?? 0), 2);
  header.writeUInt16BE(opts.qd ?? 1, 4); // qdcount
  header.writeUInt16BE(section === 'answer' ? ns.length : 0, 6);
  header.writeUInt16BE(section === 'authority' ? ns.length : 0, 8);
  const qname = encodeName(domain);
  const qfixed = Buffer.from([0, 2, 0, 1]);
  // Owner name: a compression pointer to the question name at offset 12, or the full name.
  const owner = opts.owner ? encodeName(opts.owner) : opts.compress ? Buffer.from([0xc0, 12]) : qname;
  const rrs = ns.map((n) => nsRecord(owner, encodeName(n)));
  return Buffer.concat([header, qname, qfixed, ...rrs]);
}

describe('NS query encoding', () => {
  it('builds a standard NS/IN query for the domain with the given id', () => {
    const q = encodeNsQuery('example.com', 0x1234);
    expect(q.readUInt16BE(0)).toBe(0x1234);
    expect(q.readUInt16BE(4)).toBe(1); // one question
    expect(q.subarray(12).toString('hex')).toBe(`${encodeName('example.com').toString('hex')}00020001`);
  });
});

describe('parseNsResponse', () => {
  it('reads NS from the authority section (gTLD referral), lowercased, deduped', () => {
    const r = response(7, 'example.com', ['NS1.Afternic.com', 'ns2.afternic.com'], 'authority');
    expect(parseNsResponse(r, 'example.com', 7)?.sort()).toEqual(['ns1.afternic.com', 'ns2.afternic.com']);
  });
  it('reads NS from the answer section and handles name compression', () => {
    const r = response(9, 'example.com', ['ns1.sedoparking.com', 'ns2.sedoparking.com'], 'answer', { compress: true });
    expect(parseNsResponse(r, 'example.com', 9)?.sort()).toEqual(['ns1.sedoparking.com', 'ns2.sedoparking.com']);
  });
  it('Review Focus 5: wrong id, NXDOMAIN, truncated, or garbage → null (never a false match)', () => {
    expect(parseNsResponse(response(1, 'example.com', ['ns1.x.com'], 'authority'), 'example.com', 2)).toBeNull();
    expect(parseNsResponse(response(3, 'example.com', [], 'authority', { rcode: 3 }), 'example.com', 3)).toBeNull();
    expect(parseNsResponse(response(4, 'example.com', ['ns1.x.com'], 'authority', { tc: true }), 'example.com', 4)).toBeNull();
    expect(parseNsResponse(Buffer.from([1, 2, 3]), 'example.com', 1)).toBeNull();
    const cut = response(5, 'example.com', ['ns1.x.com'], 'authority');
    expect(parseNsResponse(cut.subarray(0, cut.length - 4), 'example.com', 5)).toBeNull();
  });
  it('ignores NS records owned by another name', () => {
    const r = response(6, 'example.com', ['ns1.x.com'], 'authority', { owner: 'other.com' });
    expect(parseNsResponse(r, 'example.com', 6)).toEqual([]);
  });
  it('a question for another name, or qdcount 0, → null', () => {
    expect(parseNsResponse(response(6, 'other.com', ['ns1.x.com'], 'authority'), 'example.com', 6)).toBeNull();
    expect(parseNsResponse(response(6, 'example.com', ['ns1.x.com'], 'authority', { qd: 0 }), 'example.com', 6)).toBeNull();
  });
  it('a pointer loop does not hang → null', () => {
    const r = response(8, 'example.com', ['ns1.x.com'], 'authority');
    // Corrupt the first RR owner into a pointer to itself.
    const ownerOffset = 12 + encodeName('example.com').length + 4;
    r.writeUInt8(0xc0, ownerOffset);
    r.writeUInt8(ownerOffset, ownerOffset + 1);
    expect(parseNsResponse(r, 'example.com', 8)).toBeNull();
  });
});
