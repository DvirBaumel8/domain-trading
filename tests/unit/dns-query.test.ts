// The generic DNS query: A/NS encode and parse with crafted buffers (NXDOMAIN, 127.0.0.2, wrong id, truncated).
import { describe, expect, it } from 'vitest';
import { encodeDnsQuery, encodeNsQuery, parseDnsResponse } from '../../src/core/ns-lookup.js';

const name = (n: string) => Buffer.concat([...n.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')])), Buffer.from([0])]);

/** A response to an A (or other) query for `qname`: `answers` are [owner, type, rdata]. */
function response(id: number, qname: string, qtype: number, answers: [string, number, Buffer][], opts: { rcode?: number; tc?: boolean; qd?: number } = {}): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8000 | (opts.tc ? 0x0200 : 0) | (opts.rcode ?? 0), 2);
  header.writeUInt16BE(opts.qd ?? 1, 4);
  header.writeUInt16BE(answers.length, 6);
  const q = Buffer.concat([name(qname), Buffer.from([qtype >> 8, qtype & 255, 0, 1])]);
  const rrs = answers.map(([owner, type, rdata]) => {
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(type, 0);
    fixed.writeUInt16BE(1, 2);
    fixed.writeUInt32BE(300, 4);
    fixed.writeUInt16BE(rdata.length, 8);
    return Buffer.concat([name(owner), fixed, rdata]);
  });
  return Buffer.concat([header, q, ...rrs]);
}
const ip = (a: number, b: number, c: number, d: number) => Buffer.from([a, b, c, d]);
const Q = 'example.com.multi.surbl.org';

describe('encodeDnsQuery', () => {
  it('is encodeNsQuery with the requested type, RD=0, one question', () => {
    const a = encodeDnsQuery(Q, 1, 0x1234);
    expect(a.readUInt16BE(0)).toBe(0x1234);
    expect(a.readUInt16BE(2)).toBe(0);
    expect(a.readUInt16BE(4)).toBe(1);
    expect(a.subarray(12).toString('hex')).toBe(`${name(Q).toString('hex')}00010001`);
    expect(encodeDnsQuery(Q, 2, 1).equals(encodeNsQuery(Q, 1))).toBe(true);
  });
});

describe('parseDnsResponse', () => {
  it('NXDOMAIN is an answer (rcode 3, no records), not a failure', () => {
    expect(parseDnsResponse(response(5, Q, 1, [], { rcode: 3 }), Q, 1, 5)).toEqual({ rcode: 3, answers: [] });
  });
  it('reads an A record as dotted IPv4 (127.0.0.2)', () => {
    expect(parseDnsResponse(response(6, Q, 1, [[Q, 1, ip(127, 0, 0, 2)]]), Q, 1, 6)).toEqual({ rcode: 0, answers: [{ type: 1, data: '127.0.0.2' }] });
  });
  it('is case-insensitive on the question and drops records for other owners and other types', () => {
    const buf = response(7, Q.toUpperCase(), 1, [['other.example.org', 1, ip(1, 2, 3, 4)], [Q, 16, Buffer.from('xx')], [Q, 1, ip(127, 0, 0, 80)]]);
    expect(parseDnsResponse(buf, Q, 1, 7)).toEqual({ rcode: 0, answers: [{ type: 1, data: '127.0.0.80' }] });
  });
  it('null for a wrong id, a query (QR=0), TC, a different question, qdcount ≠ 1, a bad A length, truncation and garbage', () => {
    const ok = response(8, Q, 1, [[Q, 1, ip(127, 0, 0, 2)]]);
    expect(parseDnsResponse(ok, Q, 1, 9)).toBeNull();
    const query = Buffer.from(ok);
    query.writeUInt16BE(0x0000, 2);
    expect(parseDnsResponse(query, Q, 1, 8)).toBeNull();
    expect(parseDnsResponse(response(8, Q, 1, [], { tc: true }), Q, 1, 8)).toBeNull();
    expect(parseDnsResponse(ok, 'other.multi.surbl.org', 1, 8)).toBeNull();
    expect(parseDnsResponse(ok, Q, 2, 8)).toBeNull();
    expect(parseDnsResponse(response(8, Q, 1, [], { qd: 2 }), Q, 1, 8)).toBeNull();
    expect(parseDnsResponse(response(8, Q, 1, [[Q, 1, Buffer.from([1, 2, 3])]]), Q, 1, 8)).toBeNull();
    expect(parseDnsResponse(ok.subarray(0, ok.length - 2), Q, 1, 8)).toBeNull();
    expect(parseDnsResponse(Buffer.from('garbage'), Q, 1, 8)).toBeNull();
    expect(parseDnsResponse(Buffer.alloc(0), Q, 1, 8)).toBeNull();
  });
  it('NS answers are returned lowercased', () => {
    const buf = response(3, 'surbl.org', 2, [['surbl.org', 2, name('A.SURBL.org')]]);
    expect(parseDnsResponse(buf, 'surbl.org', 2, 3)).toEqual({ rcode: 0, answers: [{ type: 2, data: 'a.surbl.org' }] });
  });
});
