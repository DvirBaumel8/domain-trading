// A streaming reader for `{ "meta": {...}, "data": [ {...}, {...} ] }` (CR-071): yields each element of the top-level array `key` as parsed JSON
// without holding the document in memory. Only objects inside that array are supported (GoDaddy's rows are objects).
import { StringDecoder } from 'node:string_decoder';

export async function* streamArrayItems(source: AsyncIterable<Buffer | string>, key: string): AsyncGenerator<unknown> {
  const decoder = new StringDecoder('utf8');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let strStart = -1;
  let strBuf = '';
  let lastKey = '';
  let inTarget = false; // inside the array under `key`, at depth 2
  let capturing = false;
  let item = '';
  const scan = function* (chunk: string): Generator<unknown> {
    let from = 0; // start of the part of this chunk not yet appended to `item`
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (c === 92) { escaped = true; continue; }
        if (c === 34) {
          inString = false;
          if (depth === 1) lastKey = strBuf + chunk.slice(strStart, i);
          strBuf = '';
        }
        continue;
      }
      if (c === 34) { inString = true; strStart = i + 1; strBuf = ''; continue; }
      if (c === 123 || c === 91) { // { [
        depth++;
        if (c === 91 && depth === 2 && lastKey === key) inTarget = true;
        else if (c === 123 && inTarget && depth === 3) { capturing = true; from = i; item = ''; }
        continue;
      }
      if (c === 125 || c === 93) { // } ]
        if (capturing && c === 125 && depth === 3) {
          item += chunk.slice(from, i + 1);
          capturing = false;
          yield JSON.parse(item);
          item = '';
        }
        if (c === 93 && depth === 2 && inTarget) inTarget = false;
        depth--;
      }
    }
    if (inString) strBuf += chunk.slice(strStart < 0 ? 0 : strStart);
    if (capturing) item += chunk.slice(from);
  };
  for await (const buf of source) {
    const text = typeof buf === 'string' ? buf : decoder.write(buf);
    if (text) { strStart = inString ? 0 : strStart; yield* scan(text); }
  }
  const rest = decoder.end();
  if (rest) yield* scan(rest);
  if (depth !== 0 || inString) throw new Error('truncated JSON document');
}
