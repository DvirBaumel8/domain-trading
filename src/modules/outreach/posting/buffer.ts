// The ONLY file in the service that talks to Buffer (v2.12.0, CR-011 part A; founder rule 10: publish to the company's own X account only).
// Buffer's GraphQL API, POST https://api.buffer.com with `Authorization: Bearer <key>`, 30 s timeout. The key is never logged, stored or returned.
// This client has no call that replies, quotes, likes, follows or messages anyone: it can create a post, read a post, delete a post and
// find the channel.
//
// ASSUMED SHAPES (from Buffer's public docs, not verified against the live API; every one is a constant below):
//   createPost(input: {text, channelId, schedulingType: automatic, mode: shareNow, assets: {images: [{url, altText}]},
//                      metadata: {twitter: {thread: [{text, assets}]}}})  ->  union: PostActionSuccess {post {id status externalLink sentAt}} | MutationError {message}
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
export interface BufferDeps { fetch: typeof fetch; apiKey: string; channelId?: string; timeoutMs?: number }

type Gql = { data?: Record<string, any> | null; errors?: { message?: unknown }[] };

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}...` : s);

const assets = (images: BufferImage[]) => (images.length > 0 ? { assets: { images: images.map((i) => ({ url: i.url, altText: i.altText })) } } : {});

export class BufferClient {
  private channel: string | undefined;

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

  /** Publishes now (shareNow). `thread` = the later parts of a thread, in order. */
  async createPost(channelId: string, first: BufferPart, thread: BufferPart[]): Promise<BufferPost> {
    const input = {
      text: first.text, channelId, schedulingType: 'automatic', mode: 'shareNow', ...assets(first.images),
      ...(thread.length > 0 ? { metadata: { twitter: { thread: thread.map((p) => ({ text: p.text, ...assets(p.images) })) } } } : {}),
    };
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
