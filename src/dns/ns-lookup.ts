import { randomInt } from 'node:crypto';
import dgram from 'node:dgram';
import { isIP } from 'node:net';

/** NS names (lowercase, no trailing dot) as seen by the .com registry; null = couldn't tell. */
export type NsLookup = (domain: string) => Promise<string[] | null>;

const TYPE_NS = 2;
const CLASS_IN = 1;

export function encodeNsQuery(domain: string, id: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0000, 2); // standard query, RD=0 (we ask the registry server directly)
  header.writeUInt16BE(1, 4);
  const labels = domain.replace(/\.$/, '').split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')]));
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE_NS, 0);
  tail.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}

/** Read a (possibly compressed) name at `offset`. Returns the name and the offset after it in the original stream. */
function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  for (let jumps = 0; jumps < 32; jumps++) {
    if (pos >= buf.length) throw new Error('truncated');
    const len = buf[pos]!;
    if (len === 0) {
      return { name: labels.join('.').toLowerCase(), next: next === -1 ? pos + 1 : next };
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('truncated');
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (next === -1) next = pos + 2;
      pos = ptr;
      continue;
    }
    if (pos + 1 + len > buf.length) throw new Error('truncated');
    labels.push(buf.toString('ascii', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new Error('pointer loop');
}

export function parseNsResponse(buf: Buffer, domain: string, id: number): string[] | null {
  try {
    if (buf.length < 12 || buf.readUInt16BE(0) !== id) return null;
    const flags = buf.readUInt16BE(2);
    if (!(flags & 0x8000) || flags & 0x0200 || (flags & 0x000f) !== 0) return null; // not a response, truncated, or rcode≠0
    if (buf.readUInt16BE(4) !== 1) return null;
    const an = buf.readUInt16BE(6);
    const ns = buf.readUInt16BE(8);
    const want = domain.toLowerCase().replace(/\.$/, '');
    // The question must be exactly what we asked: <domain> NS IN.
    const q = readName(buf, 12);
    if (q.name !== want || q.next + 4 > buf.length) return null;
    if (buf.readUInt16BE(q.next) !== TYPE_NS || buf.readUInt16BE(q.next + 2) !== CLASS_IN) return null;
    let pos = q.next + 4;
    const out = new Set<string>();
    for (let i = 0; i < an + ns; i++) {
      const owner = readName(buf, pos);
      pos = owner.next;
      if (pos + 10 > buf.length) return null;
      const type = buf.readUInt16BE(pos);
      const cls = buf.readUInt16BE(pos + 2);
      const rdlen = buf.readUInt16BE(pos + 8);
      const rdata = pos + 10;
      if (rdata + rdlen > buf.length) return null;
      if (type === TYPE_NS && cls === CLASS_IN && owner.name === want) {
        const target = readName(buf, rdata);
        if (target.next > rdata + rdlen) return null; // name ran past its rdata
        out.add(target.name);
      }
      pos = rdata + rdlen;
    }
    return [...out];
  } catch {
    return null;
  }
}

/** One UDP query to the registry server. Never throws; null on timeout or a bad answer. */
export function queryNs(domain: string, opts: { server?: string; timeoutMs?: number } = {}): Promise<string[] | null> {
  const id = randomInt(0, 0x10000);
  const msg = encodeNsQuery(domain, id);
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const done = (v: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), opts.timeoutMs ?? 3000);
    sock.on('error', () => done(null));
    const server = opts.server ?? '192.5.6.30';
    // Ignore datagrams from the wrong source or with a different id (spoof/stray); keep waiting until the timeout.
    sock.on('message', (buf, rinfo) => {
      if (rinfo.port !== 53) return;
      if (isIP(server) && rinfo.address !== server) return;
      if (buf.length < 2 || buf.readUInt16BE(0) !== id) return;
      done(parseNsResponse(buf, domain, id));
    });
    sock.send(msg, 53, server, (err) => {
      if (err) done(null);
    });
  });
}
