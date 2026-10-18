import * as z from 'zod';
import { fromJson } from '../shared/contracts.ts';
import { messageOf } from '../shared/errors.ts';
import { boxOfOrigin, HOST } from '../shared/names.ts';
import { cloudflare, list } from './boxes.ts';
import type { HostEnv } from './env.ts';

// Each sleep stores a snapshot in the account's registry, as a btrfs delta on the snapshot the box woke from, and
// nothing deletes them. A delta can't be restored without its ancestors, so the sweep keeps every snapshot in the
// chain of a box's current snapshot (`restore_chain`, and each `parent_snapshot_id`), of a snapshot base replaced in
// the last hour, and of any snapshot under an hour old (a save whose id the box hasn't stored yet), and deletes the
// rest of this host's container application's snapshots; other applications' are never touched. It deletes only when
// the host's SWEEP var is `delete`; otherwise it only reports.
const REGISTRY = 'https://registry.cloudflare.com';
const GRACE_MS = 60 * 60 * 1000;
// Cloudflare deletes a snapshot 30 days after it was made or last restored; a box asleep longer woke from it last.
const EXPIRED_MS = 30 * 24 * 60 * 60 * 1000;
// Container snapshots began in 2026; an earlier time is no time.
const SNAPSHOTS_BEGAN = Date.UTC(2026, 0, 1);
const SNAPSHOT_TAG = 'rootfs-snapshot-';
const SNAPSHOT_ARTIFACT = 'application/vnd.cloudchamber.rootfs-snapshot.v1';
const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

const Namespaces = z.array(z.object({ id: z.string(), script: z.string().nullish(), class: z.string().nullish() }));
const Objects = z.array(z.object({ id: z.string(), hasStoredData: z.boolean().optional() }));
const Applications = z.array(z.object({ id: z.string(), durable_objects: z.object({ namespace_id: z.string() }).nullish() }));
const Credentials = z.object({ password: z.string() });
const Catalog = z.object({ repositories: z.record(z.string(), z.array(z.string())) });
const GcPage = z.object({ last: z.string().nullish() });
const Manifest = z.object({ artifactType: z.string().optional(), config: z.object({ digest: z.string() }) });
const SnapshotConfig = z.object({
  snapshot_id: z.string(),
  snapshot_set_id: z.string(),
  application_id: z.string(),
  parent_snapshot_id: z.string().nullish(),
  blob_size_bytes: z.number(),
  created_at_unix_seconds: z.number().nullish(),
  restore_chain: z.object({ entries: z.array(z.object({ snapshot_id: z.string() })) }),
});

interface Snapshot {
  readonly id: string;
  readonly repo: string;
  readonly tag: string;
  readonly setTag: string | null;
  readonly digest: string;
  readonly app: string;
  readonly parent: string | null;
  readonly chain: ReadonlyArray<string>;
  readonly bytes: number;
  readonly created: number;
}

interface Root {
  readonly box: string;
  readonly phase: string;
  readonly since: number;
  readonly snapshot: string | null;
  readonly replaced: string | null;
}

export interface Chain {
  readonly snapshots: number;
  // The deltas after the first, full snapshot.
  readonly deltaGigabytes: number;
  // When the first snapshot was saved: when the box, or the box it started from, was baked.
  readonly began: string | null;
}

interface Listed {
  readonly id: string;
  readonly repo: string;
  readonly gigabytes: number;
  readonly created: string;
}

export interface SweepReport {
  readonly deleting: boolean;
  readonly roots: ReadonlyArray<Omit<Root, 'since'> & { readonly chain: Chain | null }>;
  readonly missing: ReadonlyArray<string>;
  readonly expired: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<Listed & { readonly for: string }>;
  readonly unreachable: ReadonlyArray<Listed>;
  readonly deleted: ReadonlyArray<string>;
  readonly gigabytes: { readonly kept: number; readonly unreachable: number };
  readonly blocked: string | null;
}

export async function sweep(env: HostEnv, { dryRun }: { readonly dryRun: boolean }): Promise<SweepReport> {
  const deleting = env.SWEEP === 'delete' && !dryRun;
  const namespace = await boxNamespace(env);
  const roots = await rootsOf(env, namespace);
  const ownApp = await ownApplication(env, namespace);
  const registry = await registryOf(env, deleting);
  const snapshots = await inventory(registry);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const now = Date.now();

  const keep = new Map<string, string>();
  const mark = (id: string, why: string) => {
    for (const queue = [id]; queue.length; ) {
      const current = queue.pop() ?? '';
      if (keep.has(current)) continue;
      keep.set(current, why);
      const found = byId.get(current);
      if (found) queue.push(...found.chain, ...(found.parent ? [found.parent] : []));
    }
  };
  const missing: Array<string> = [];
  const expired: Array<string> = [];
  for (const { box, phase, since, snapshot, replaced } of roots) {
    if (replaced) mark(replaced, `${box} (replaced)`);
    if (!snapshot) continue;
    if (byId.has(snapshot)) mark(snapshot, box);
    else if (phase === 'asleep' && now - since > EXPIRED_MS) expired.push(`${box}: ${snapshot}`);
    else missing.push(`${box}: ${snapshot}`);
  }
  for (const snapshot of snapshots) {
    if (dashed(snapshot.app) !== ownApp) mark(snapshot.id, 'another application');
    else if (!(snapshot.created > SNAPSHOTS_BEGAN) || now - snapshot.created < GRACE_MS)
      mark(snapshot.id, 'under an hour old');
  }
  const unreachable = snapshots.filter((snapshot) => !keep.has(snapshot.id));
  const blocked = missing.length
    ? `the registry lacks the current snapshot of ${missing.join(', ')}`
    : !roots.some((root) => root.box === 'base' && root.snapshot)
      ? 'base has no snapshot'
      : null;

  const deleted: Array<string> = [];
  if (deleting && !blocked && unreachable.length) {
    // Deleting the tags leaves the manifest (listed by its digest) and frees nothing; the layer GC then frees only
    // blobs no manifest references.
    for (const snapshot of unreachable) {
      await registry.delete(snapshot.repo, snapshot.tag);
      if (snapshot.setTag && (await registry.digest(snapshot.repo, snapshot.setTag)) === snapshot.digest)
        await registry.delete(snapshot.repo, snapshot.setTag);
      await registry.delete(snapshot.repo, snapshot.digest);
      deleted.push(snapshot.id);
    }
    await registry.collectGarbage();
  }

  const listed = (snapshot: Snapshot): Listed => ({
    id: snapshot.id,
    repo: snapshot.repo.replace(/^[^/]+\//, ''),
    gigabytes: gigabytes(snapshot.bytes),
    created: new Date(snapshot.created).toISOString(),
  });
  const sum = (list: ReadonlyArray<Snapshot>) => gigabytes(list.reduce((total, { bytes }) => total + bytes, 0));
  const kept = snapshots.filter((snapshot) => keep.has(snapshot.id));

  return {
    deleting,
    roots: roots.map(({ since: _, ...root }) => ({ ...root, chain: chainOf(byId, root.snapshot) })),
    missing,
    expired,
    kept: kept.map((snapshot) => ({ ...listed(snapshot), for: keep.get(snapshot.id) ?? '' })),
    unreachable: unreachable.map(listed),
    deleted,
    gigabytes: { kept: sum(kept), unreachable: sum(unreachable) },
    blocked,
  };
}

const gigabytes = (bytes: number) => +(bytes / 1e9).toFixed(2);

function chainOf(byId: ReadonlyMap<string, Snapshot>, id: string | null): Chain | null {
  const snapshot = id ? byId.get(id) : undefined;
  if (!snapshot) return null;
  const [first, ...deltas] = [...new Set([...snapshot.chain, snapshot.id])].map((entry) => byId.get(entry));

  return {
    snapshots: deltas.length + 1,
    deltaGigabytes: gigabytes(deltas.reduce((total, entry) => total + (entry?.bytes ?? 0), 0)),
    began: first && first.created > SNAPSHOTS_BEGAN ? new Date(first.created).toISOString() : null,
  };
}

async function boxNamespace(env: HostEnv): Promise<string> {
  const answer = await cloudflare(env, 'GET', '/workers/durable_objects/namespaces?per_page=1000');
  const namespace = Namespaces.parse(answer?.result).find((entry) => entry.script === HOST && entry.class === 'Box');
  if (!namespace) throw new Error(`no Durable Object namespace for ${HOST}'s Box class`);

  return namespace.id;
}

// Every Box object that stores anything, and every box the host lists; a box that can't answer stops the sweep.
async function rootsOf(env: HostEnv, namespace: string): Promise<Array<Root>> {
  const ids = new Map<string, { id: DurableObjectId; name?: string }>();
  for (let cursor: string | null | undefined = ''; cursor !== undefined && cursor !== null; ) {
    const query = new URLSearchParams({ limit: '1000', ...(cursor && { cursor }) });
    const answer = await cloudflare(env, 'GET', `/workers/durable_objects/namespaces/${namespace}/objects?${query}`);
    const objects = Objects.parse(answer?.result);
    for (const { id, hasStoredData } of objects)
      if (hasStoredData !== false) ids.set(id, { id: env.BOX.idFromString(id) });
    cursor = objects.length ? answer?.result_info?.cursor : null;
  }
  for (const name of await list(env)) {
    const id = env.BOX.idFromName(name);
    ids.set(id.toString(), { id, name });
  }

  return Promise.all(
    [...ids].map(async ([key, { id, name }]) => {
      const stored = await env.BOX.get(id)
        .stored()
        .catch((error: unknown) => Promise.reject(new Error(`what Box ${name ?? key} stores: ${messageOf(error)}`)));
      const { origin, ...root } = stored;

      return { box: name ?? (origin ? boxOfOrigin(origin) : key), ...root };
    })
  );
}

// Only one application can be named by the namespace; a page that lacks it stops the sweep.
async function ownApplication(env: HostEnv, namespace: string): Promise<string> {
  const apps = Applications.parse((await cloudflare(env, 'GET', '/containers/applications'))?.result);
  const own = apps.find((app) => app.durable_objects?.namespace_id === namespace);
  if (!own) throw new Error(`no container application for ${HOST}'s Box class`);

  return dashed(own.id);
}

const dashed = (id: string) =>
  id.includes('-') ? id : id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

interface Registry {
  readonly get: (path: string, accept?: string) => Promise<Response>;
  readonly digest: (repo: string, tag: string) => Promise<string | null>;
  readonly delete: (repo: string, tag: string) => Promise<void>;
  readonly collectGarbage: () => Promise<void>;
}

async function registryOf(env: HostEnv, push: boolean): Promise<Registry> {
  const answer = await cloudflare(
    env,
    'POST',
    '/containers/registries/registry.cloudflare.com/credentials',
    JSON.stringify({ expiration_minutes: 15, permissions: push ? ['pull', 'push'] : ['pull'] })
  );
  const authorization = `Basic ${btoa(`v1:${Credentials.parse(answer?.result).password}`)}`;
  const send = async (method: string, path: string, accept?: string) => {
    const response = await fetch(`${REGISTRY}/v2/${path}`, {
      method,
      headers: { Authorization: authorization, 'Cache-Control': 'no-cache', ...(accept && { Accept: accept }) },
    });
    if (!response.ok && response.status !== 404)
      throw new Error(`registry ${method} ${path.split('?')[0]} -> ${response.status}: ${(await response.text()).slice(0, 200)}`);

    return response;
  };

  return {
    get: (path, accept) => send('GET', path, accept),
    digest: async (repo, tag) => {
      const response = await send('HEAD', `${repo}/manifests/${tag}`, MANIFEST);

      return response.ok ? response.headers.get('Docker-Content-Digest') : null;
    },
    delete: async (repo, tag) => {
      await (await send('DELETE', `${repo}/manifests/${tag}`, MANIFEST)).body?.cancel();
    },
    collectGarbage: async () => {
      for (let last = '', pages = 0; pages < 100; pages++) {
        const response = await send('PUT', `gc/layers${last ? `?last=${encodeURIComponent(last)}` : ''}`);
        const next = fromJson(GcPage).parse(await response.text()).last;
        if (!next || next === last) return;
        last = next;
      }
    },
  };
}

async function inventory(registry: Registry): Promise<Array<Snapshot>> {
  const repositories = new Map<string, Set<string>>();
  for (let last: string | null = ''; last !== null; ) {
    const response = await registry.get(`_catalog?tags=true${last ? `&last=${encodeURIComponent(last)}` : ''}`);
    for (const [repo, tags] of Object.entries(fromJson(Catalog).parse(await response.text()).repositories))
      repositories.set(repo, new Set([...(repositories.get(repo) ?? []), ...tags]));
    const next: string | null = response.headers.get('Link')?.match(/[?&]last=([^&>]+)/)?.[1] ?? null;
    last = next && next !== last ? decodeURIComponent(next) : null;
  }
  const tags = [...repositories].flatMap(([repo, names]) =>
    [...names].filter((tag) => tag.startsWith(SNAPSHOT_TAG)).map((tag) => ({ repo, tag, names }))
  );

  return (await Promise.all(tags.map(({ repo, tag, names }) => snapshotAt(registry, repo, tag, names)))).flatMap(
    (snapshot) => snapshot ?? []
  );
}

async function snapshotAt(registry: Registry, repo: string, tag: string, tags: ReadonlySet<string>) {
  const response = await registry.get(`${repo}/manifests/${tag}`, MANIFEST);
  if (response.status === 404) return null;
  const digest = response.headers.get('Docker-Content-Digest');
  const manifest = fromJson(Manifest).parse(await response.text());
  if (manifest.artifactType !== SNAPSHOT_ARTIFACT || !digest) return null;
  const config = fromJson(SnapshotConfig).parse(await (await registry.get(`${repo}/blobs/${manifest.config.digest}`)).text());
  const setTag = `rootfs-set-${await sha256(config.snapshot_set_id)}`;

  return {
    id: config.snapshot_id,
    repo,
    tag,
    setTag: tags.has(setTag) ? setTag : null,
    digest,
    app: config.application_id,
    parent: config.parent_snapshot_id || null,
    chain: config.restore_chain.entries.map((entry) => entry.snapshot_id),
    bytes: config.blob_size_bytes,
    created: (config.created_at_unix_seconds ?? 0) * 1000,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
