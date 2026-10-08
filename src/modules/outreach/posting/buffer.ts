// The ONLY file in the service that talks to Buffer (v2.12.0, CR-011 part A; founder rule 10: publish to the company's own X account only).
// Buffer's GraphQL API, POST https://api.buffer.com with `Authorization: Bearer <key>`, 30 s timeout. The key is never logged, stored or returned.
// This client has no call that replies, quotes, likes, follows or messages anyone: it can create a post, read a post, delete a post and
// find the channel.
//
// ASSUMED SHAPES (from Buffer's public docs, not verified against the live API; every one is a constant below):
//   createPost(input: {text, channelId, shareMode: shareNow, assets: [{image: {url, altText}}],
//                      metadata: {twitter: {thread: [{text, assets: [{image: {url, altText}}]}]}}})   (v3.2.0, CR-017: Buffer's reference;
//                      `assets` is a LIST of AssetInput with exactly one of image/link/video/document; ThreadedPostInput.assets is required)  ->  union: PostActionSuccess {post {id status externalLink sentAt}} | MutationError {message}
//   post(input: {id}) {id status externalLink sentAt}        deletePost(input: {id})  ->  MutationError {message} | anything else = success
//   account {organizations {id}}                             channels(input: {organizationId}) {id name service}
import { scrubSecrets } from '../../../core/redact.js';

export const BUFFER_URL = 'https://api.buffer.com';
export const BUFFER_TIMEOUT_MS = 30_000;

export const CREATE_POST_MUTATION = `mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id status externalLink sentAt } }
    ... on MutationError { message }
  }
}`;
export const GET_POST_QUERY = `query GetPost($input: PostInput!) {
  post(input: $input) { id status externalLink sentAt }
}`;
export const DELETE_POST_MUTATION = `mutation DeletePost($input: DeletePostInput!) {
  deletePost(input: $input) {
    __typename
    ... on MutationError { message }
  }
}`;
export const ACCOUNT_QUERY = `query Account { account { organizations { id } } }`;
export const CHANNELS_QUERY = `query Channels($input: ChannelsInput!) { channels(input: $input) { id name service } }`;

export type BufferErrorKind = 'rate_limited' | 'refused' | 'unavailable' | 'channel_unknown';

export class BufferError extends Error {
  constructor(
    public readonly kind: BufferErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export interface BufferPost { id: string; status: string | null; externalLink: string | null; sentAt: Date | null }
export interface BufferImage { url: string; altText: string }
export interface BufferPart { text: string; images: BufferImage[] }
export interface BufferDeps { fetch: typeof fetch; apiKey: string; channelId?: string; timeoutMs?: number; now?: () => number }

/** The input types the schema check always reads (read-only introspection), in this order; others are read when the input reaches them. */
export const SCHEMA_CHECK_TYPES = ['CreatePostInput', 'AssetInput', 'ImageAssetInput', 'TwitterPostMetadataInput', 'ThreadedPostInput'] as const;
/** How long an introspection answer is reused. */
export const SCHEMA_CACHE_MS = 3_600_000;
export const SCHEMA_TYPE_QUERY = `query SchemaType($name: String!) {
  __type(name: $name) {
    name kind
    inputFields { name type { ...TypeRef } }
    enumValues { name }
  }
}
fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }`;

export interface TypeRef { kind: string; name: string | null; ofType?: TypeRef | null }
export interface IntroType { name: string; kind: string; inputFields?: { name: string; type: TypeRef }[] | null; enumValues?: { name: string }[] | null }
export interface TypeDef { kind: string; fields?: Record<string, string>; values?: string[] }
export interface SchemaCheck { ok: boolean; problems: string[]; checked_types: string[]; types: Record<string, TypeDef> }

type Gql = { data?: Record<string, any> | null; errors?: { message?: unknown }[] };

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}...` : s);

const assetList = (images: BufferImage[]) => images.map((i) => ({ image: { url: i.url, altText: i.altText } }));
const assets = (images: BufferImage[]) => (images.length > 0 ? { assets: assetList(images) } : {});

/** The exact `input` of the createPost mutation (also what the schema check validates). A thread part always carries `assets` (required by ThreadedPostInput). */
export function buildCreateInput(channelId: string, first: BufferPart, thread: BufferPart[]): Record<string, unknown> {
  return {
    text: first.text, channelId, shareMode: 'shareNow', ...assets(first.images),
    ...(thread.length > 0 ? { metadata: { twitter: { thread: thread.map((p) => ({ text: p.text, assets: assetList(p.images) })) } } } : {}),
  };
}

/** A post with one image and one thread part that carries an image: the shape the schema check validates. */
export const SAMPLE_INPUT = buildCreateInput(
  'schema-check-sample',
  { text: 'sample', images: [{ url: 'https://example.invalid/media/sample', altText: 'sample' }] },
  [{ text: 'sample part', images: [{ url: 'https://example.invalid/media/sample', altText: 'sample' }] }],
);

const SCHEMA_TYPES_MAX = 25;
const BUILTIN_SCALARS = new Set(['String', 'Boolean', 'Int', 'Float', 'ID']);
const baseName = (t: TypeRef | null | undefined): string | null => (!t ? null : t.ofType ? baseName(t.ofType) : t.name);

/** GraphQL's __TypeKind, lower-cased (so the kind names are not mistaken for API error codes). */
const kindOf = (t: TypeRef): string => t.kind.toLowerCase();
const typeText = (t: TypeRef | null | undefined): string => (!t ? '?' : kindOf(t) === 'non_null' ? `${typeText(t.ofType)}!` : kindOf(t) === 'list' ? `[${typeText(t.ofType)}]` : (t.name ?? '?'));

/** Checks `value` against the introspected type: every field exists, lists and nesting match, required fields are present. Pure; `load` reads one type by name. */
export async function validateAgainstSchema(
  value: unknown, ref: TypeRef, path: string, load: (name: string) => Promise<IntroType | null>, problems: string[],
): Promise<void> {
  if (kindOf(ref) === 'non_null') {
    if (value === null || value === undefined) { problems.push(`${path} is required (${typeText(ref)}) but missing`); return; }
    return validateAgainstSchema(value, ref.ofType!, path, load, problems);
  }
  if (value === null || value === undefined) return;
  if (kindOf(ref) === 'list') {
    if (!Array.isArray(value)) { problems.push(`${path} must be a list (${typeText(ref)}) but is not`); return; }
    for (const [i, v] of value.entries()) await validateAgainstSchema(v, ref.ofType!, `${path}[${i}]`, load, problems);
    return;
  }
  const name = ref.name ?? '?';
  if (Array.isArray(value)) { problems.push(`${path} must not be a list (${name})`); return; }
  if (kindOf(ref) === 'scalar') {
    if ((name === 'String' || name === 'ID') && typeof value !== 'string') problems.push(`${path} must be a string (${name})`);
    return;
  }
  const t = await load(name);
  if (!t) { problems.push(`${path}: Buffer has no type ${name}`); return; }
  if (kindOf(ref) === 'enum') {
    const names = (t.enumValues ?? []).map((e) => e.name);
    if (typeof value !== 'string' || !names.includes(value)) problems.push(`${path}: ${JSON.stringify(value)} is not a value of ${name} (${names.join(', ')})`);
    return;
  }
  if (kindOf(ref) !== 'input_object') return;
  if (typeof value !== 'object') { problems.push(`${path} must be an object (${name})`); return; }
  const obj = value as Record<string, unknown>;
  const fields = t.inputFields ?? [];
  for (const k of Object.keys(obj)) {
    if (!fields.some((f) => f.name === k)) problems.push(`${path}.${k} is not a field of ${name}`);
  }
  for (const f of fields) {
    const present = obj[f.name] !== undefined && obj[f.name] !== null;
    if (kindOf(f.type) === 'non_null' && !present) problems.push(`${path}.${f.name} is required (${typeText(f.type)}) but missing`);
    else if (present) await validateAgainstSchema(obj[f.name], f.type, `${path}.${f.name}`, load, problems);
  }
  if (name === 'AssetInput' && Object.keys(obj).length !== 1) problems.push(`${path} must have exactly one of its fields (image, link, video, document)`);
}

export class BufferClient {
  private channel: string | undefined;
  private readonly types = new Map<string, { at: number; type: IntroType | null }>();

  constructor(private readonly deps: BufferDeps) {}

  private scrub(s: string): string {
    return clip(scrubSecrets(s, [this.deps.apiKey]));
  }

  private async call(query: string, variables: Record<string, unknown>): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await this.deps.fetch(BUFFER_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.deps.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? BUFFER_TIMEOUT_MS),
      });
    } catch (e) {
      const name = (e as Error).name;
      throw new BufferError('unavailable', name === 'TimeoutError' || name === 'AbortError' ? 'Buffer did not answer in time' : 'Buffer could not be reached');
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      throw new BufferError('rate_limited', 'Buffer answered 429 (too many requests)', 429, Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : undefined);
    }
    const text = await res.text().catch(() => '');
    let body: Gql | null = null;
    try { body = JSON.parse(text) as Gql; } catch { body = null; }
    if (body && Array.isArray(body.errors) && body.errors.length > 0) {
      const msg = body.errors.map((e) => (typeof e?.message === 'string' ? e.message : '')).filter(Boolean).join('; ') || 'Buffer refused the request';
      throw new BufferError('refused', this.scrub(msg), res.status);
    }
    if (!res.ok) throw new BufferError('unavailable', `Buffer answered HTTP ${res.status}`, res.status);
    if (!body || !body.data) throw new BufferError('unavailable', 'Buffer sent an answer this service cannot read', res.status);
    return body.data;
  }

  /** BUFFER_CHANNEL_ID, else the account's single X channel (cached). */
  async resolveChannel(): Promise<string> {
    if (this.deps.channelId) return this.deps.channelId;
    if (this.channel) return this.channel;
    const acc = await this.call(ACCOUNT_QUERY, {});
    const orgs: { id?: unknown }[] = acc.account?.organizations ?? [];
    const found: string[] = [];
    for (const o of orgs) {
      if (typeof o.id !== 'string') continue;
      const ch = await this.call(CHANNELS_QUERY, { input: { organizationId: o.id } });
      for (const c of (ch.channels ?? []) as { id?: unknown; service?: unknown }[]) {
        if (typeof c.id === 'string' && typeof c.service === 'string' && ['twitter', 'x'].includes(c.service.toLowerCase())) found.push(c.id);
      }
    }
    if (found.length !== 1) {
      throw new BufferError('channel_unknown', found.length === 0 ? 'No X channel found in the Buffer account; set BUFFER_CHANNEL_ID' : 'More than one X channel in the Buffer account; set BUFFER_CHANNEL_ID');
    }
    this.channel = found[0]!;
    return this.channel;
  }

  /** One `__type` introspection (read-only, publishes nothing), cached in memory for an hour. */
  private async introspect(name: string): Promise<IntroType | null> {
    const now = (this.deps.now ?? Date.now)();
    const hit = this.types.get(name);
    if (hit && now - hit.at < SCHEMA_CACHE_MS) return hit.type;
    const data = await this.call(SCHEMA_TYPE_QUERY, { name });
    const t = data.__type as IntroType | null | undefined;
    const type = t && typeof t.name === 'string' ? t : null;
    this.types.set(name, { at: now, type });
    return type;
  }

  /** Validates the exact createPost input DOM builds (a sample with an image and a thread part by default) against Buffer's own type definitions. Throws BufferError when Buffer cannot be asked. */
  async checkSchema(input: Record<string, unknown> = SAMPLE_INPUT): Promise<SchemaCheck> {
    const checked: string[] = [];
    const load = async (name: string) => { const t = await this.introspect(name); if (!checked.includes(name)) checked.push(name); return t; };
    for (const n of SCHEMA_CHECK_TYPES) await load(n);
    const problems: string[] = [];
    await validateAgainstSchema(input, { kind: 'input_object', name: 'CreatePostInput' }, 'input', load, problems);
    for (const n of SCHEMA_CHECK_TYPES) {
      if (!(await load(n))) problems.push(`Buffer has no type ${n}`);
    }
    // v3.2.1: Buffer's own definitions of every input type reachable from CreatePostInput (names and types only), so a mismatch can be fixed from the answer.
    const types: Record<string, TypeDef> = {};
    const queue = ['CreatePostInput'];
    while (queue.length > 0 && Object.keys(types).length < SCHEMA_TYPES_MAX) {
      const n = queue.shift()!;
      if (types[n]) continue;
      const t = await load(n);
      if (!t) continue;
      const kind = t.kind.toLowerCase();
      if (t.inputFields) {
        types[n] = { kind, fields: Object.fromEntries(t.inputFields.map((f) => [f.name, typeText(f.type)])) };
        for (const f of t.inputFields) { const base = baseName(f.type); if (base && !BUILTIN_SCALARS.has(base) && !types[base]) queue.push(base); }
      } else if (t.enumValues) types[n] = { kind, values: t.enumValues.map((v) => v.name) };
      else types[n] = { kind };
    }
    if (problems.length > 0) this.types.clear(); // a mismatch is never kept: the next check asks Buffer again
    return { ok: problems.length === 0, problems: [...new Set(problems)], checked_types: checked, types };
  }

  /** Publishes now (shareNow). `thread` = the later parts of a thread, in order. */
  async createPost(channelId: string, first: BufferPart, thread: BufferPart[]): Promise<BufferPost> {
    const input = buildCreateInput(channelId, first, thread);
    const data = await this.call(CREATE_POST_MUTATION, { input });
    const r = data.createPost as { __typename?: string; message?: unknown; post?: Record<string, unknown> } | null | undefined;
    if (!r) throw new BufferError('unavailable', 'Buffer sent an answer this service cannot read');
    if (typeof r.message === 'string' && !r.post) throw new BufferError('refused', this.scrub(r.message));
    const post = readPost(r.post);
    if (!post) throw new BufferError('refused', this.scrub(`Buffer did not confirm the post (${r.__typename ?? 'unknown answer'})`));
    return post;
  }

  async getPost(id: string): Promise<BufferPost | null> {
    const data = await this.call(GET_POST_QUERY, { input: { id } });
    return readPost(data.post);
  }

  /** Throws BufferError(refused) when Buffer says no (for example it cannot remove a published post). */
  async deletePost(id: string): Promise<void> {
    const data = await this.call(DELETE_POST_MUTATION, { input: { id } });
    const r = data.deletePost as { message?: unknown } | null | undefined;
    if (r && typeof r.message === 'string') throw new BufferError('refused', this.scrub(r.message));
  }
}

function readPost(p: Record<string, unknown> | null | undefined): BufferPost | null {
  if (!p || typeof p.id !== 'string') return null;
  const sent = typeof p.sentAt === 'string' ? new Date(p.sentAt) : null;
  return {
    id: p.id,
    status: typeof p.status === 'string' ? p.status : null,
    externalLink: typeof p.externalLink === 'string' && p.externalLink ? p.externalLink : null,
    sentAt: sent && !Number.isNaN(sent.getTime()) ? sent : null,
  };
}
