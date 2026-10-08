// v3.2.0 (CR-017): Buffer's GraphQL input types as in developers.buffer.com/reference.html, for the MSW mocks. The mocks answer introspection
// (`__type`) from this table and refuse a createPost input that does not fit it with a GraphQL-style error, the way Buffer does.
import { HttpResponse } from 'msw';

type Fields = Record<string, string>;
export const BUFFER_TYPES: Record<string, { kind: 'INPUT_OBJECT'; fields: Fields } | { kind: 'ENUM'; values: string[] }> = {
  CreatePostInput: { kind: 'INPUT_OBJECT', fields: { channelId: 'ID!', assets: '[AssetInput]', metadata: 'PostMetadataInput', shareMode: 'ShareMode!', text: 'String!', dueAt: 'DateTime' } },
  AssetInput: { kind: 'INPUT_OBJECT', fields: { image: 'ImageAssetInput', link: 'LinkAssetInput', video: 'VideoAssetInput', document: 'DocumentAssetInput' } },
  ImageAssetInput: { kind: 'INPUT_OBJECT', fields: { url: 'String!', altText: 'String' } },
  PostMetadataInput: { kind: 'INPUT_OBJECT', fields: { twitter: 'TwitterPostMetadataInput' } },
  TwitterPostMetadataInput: { kind: 'INPUT_OBJECT', fields: { thread: '[ThreadedPostInput!]' } },
  ThreadedPostInput: { kind: 'INPUT_OBJECT', fields: { assets: '[AssetInput!]!', text: 'String!', metadata: 'PostMetadataInput' } },
  LinkAssetInput: { kind: 'INPUT_OBJECT', fields: { url: 'String!' } },
  VideoAssetInput: { kind: 'INPUT_OBJECT', fields: { url: 'String!' } },
  DocumentAssetInput: { kind: 'INPUT_OBJECT', fields: { url: 'String!' } },
  ShareMode: { kind: 'ENUM', values: ['addToQueue', 'shareNext', 'shareNow', 'customScheduled'] },
};
const SCALARS = new Set(['ID', 'String', 'DateTime']);

interface Ref { kind: string; name: string | null; ofType: Ref | null }
function parseRef(t: string): Ref {
  if (t.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: parseRef(t.slice(0, -1)) };
  if (t.startsWith('[')) return { kind: 'LIST', name: null, ofType: parseRef(t.slice(1, -1)) };
  const def = BUFFER_TYPES[t];
  return { kind: SCALARS.has(t) ? 'SCALAR' : def?.kind ?? 'SCALAR', name: t, ofType: null };
}

export function introspectionAnswer(name: string): Response {
  const def = BUFFER_TYPES[name];
  if (!def) return HttpResponse.json({ data: { __type: null } });
  if (def.kind === 'ENUM') return HttpResponse.json({ data: { __type: { name, kind: 'ENUM', inputFields: null, enumValues: def.values.map((v) => ({ name: v })) } } });
  return HttpResponse.json({ data: { __type: { name, kind: 'INPUT_OBJECT', enumValues: null, inputFields: Object.entries(def.fields).map(([n, t]) => ({ name: n, type: parseRef(t) })) } } });
}

function check(value: unknown, t: string, path: string, errs: string[]): void {
  if (t.endsWith('!')) {
    if (value == null) { errs.push(`${path} of required type "${t}" was not provided.`); return; }
    return check(value, t.slice(0, -1), path, errs);
  }
  if (value == null) return;
  if (t.startsWith('[')) {
    // GraphQL coerces a single value into a list, but an input OBJECT standing where a list of objects belongs is judged by the element type below.
    for (const [i, v] of (Array.isArray(value) ? value : [value]).entries()) check(v, t.slice(1, -1), `${path}.${i}`, errs);
    return;
  }
  const def = BUFFER_TYPES[t];
  if (!def) return;
  if (def.kind === 'ENUM') { if (!def.values.includes(String(value))) errs.push(`${path}: Value "${String(value)}" does not exist in "${t}" enum.`); return; }
  if (typeof value !== 'object' || Array.isArray(value)) { errs.push(`${path}: Expected type "${t}" to be an object.`); return; }
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!(k in def.fields)) errs.push(`${path}: Field "${k}" is not defined by type "${t}".`);
  for (const [k, ft] of Object.entries(def.fields)) check(obj[k], ft, `${path}.${k}`, errs);
  if (t === 'AssetInput' && Object.keys(obj).length !== 1) errs.push(`${path}: Exactly one field of "AssetInput" must be provided.`);
}

/** Errors Buffer's GraphQL layer would give for this CreatePostInput; empty = accepted. */
export function createPostErrors(input: unknown): string[] {
  const errs: string[] = [];
  check(input, 'CreatePostInput!', 'Variable "$input" got invalid value', errs);
  return errs;
}

/** A GraphQL-style refusal (HTTP 200 with `errors`) when the input does not fit; undefined when it does. */
export function refuseBadCreate(input: unknown): Response | undefined {
  const errs = createPostErrors(input);
  return errs.length > 0 ? HttpResponse.json({ errors: errs.map((message) => ({ message })) }) : undefined;
}
