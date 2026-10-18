
import * as z from 'zod';
import { fromJson } from '../shared/contracts.ts';
import { messageOf } from '../shared/errors.ts';
import { boxOfOrigin, HOST } from '../shared/names.ts';
import { cloudflare, list } from './boxes.ts';
import type { HostEnv } from './env.ts';

// Each sleep stores a snapshot in the account's registry, as a btrfs delta on the snapshot the box woke from, and
// nothing deletes them. A delta can't be restored without its ancestors, so the sweep keeps every snapshot in the
// chain of a box's current snapshot (`restore_chain`), and of any snapshot under an hour old (a save whose id the box
// hasn't stored yet), and deletes the rest: those of this host's container application and of applications that no
// longer exist. It deletes only when the host's SWEEP var is `delete`; otherwise it only reports.
const REGISTRY = 'https://registry.cloudflare.com';
const GRACE_MS = 60 * 60 * 1000;
const SNAPSHOT_TAG = 'rootfs-snapshot-';
const SNAPSHOT_ARTIFACT = 'application/vnd.cloudchamber.rootfs-snapshot.v1';
const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

const Namespaces = z.array(z.object({ id: z.string(), script: z.string().nullish(), class: z.string().nullish() }));
const Objects = z.array(z.object({ id: z.string(), hasStoredData: z.boolean().optional() }));
const Applications = z.array(z.object({ id: z.string(), durable_objects: z.object({ namespace_id: z.string() }).nullish() }));
const Credentials = z.object({ password: z.string() });
const Catalog = z.object({ repositories: z.record(z.string(), z.array(z.string())) });
const Manifest = z.object({ artifactType: z.string().optional(), config: z.object({ digest: z.string() }) });
const SnapshotConfig = z.object({
  snapshot_id: z.string(),
  snapshot_set_id: z.string(),
  application_id: z.string(),
  blob_size_bytes: z.number(),
  created_at_unix_seconds: z.number(),
  restore_chain: z.object({ entries: z.array(z.object({ snapshot_id: z.string() })) }),
});

interface Snapshot {
  readonly id: string;
  readonly repo: string;
  readonly tag: string;
  readonly setTag: string | null;
  readonly digest: string;
  readonly app: string;
  readonly chain: ReadonlyArray<string>;
  readonly bytes: number;
  readonly created: number;
}

export interface Root {
  readonly box: string;
  readonly phase: string;
  readonly snapshot: string | null;
}

interface Listed {
  readonly id: string;
  readonly repo: string;
  readonly gigabytes: number;
  readonly created: string;
}

export interface SweepReport {
  readonly deleting: boolean;
  readonly roots: ReadonlyArray<Root>;
  readonly missing: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<Listed & { readonly for: string }>;
  readonly unreachable: ReadonlyArray<Listed & { readonly app: string }>;
  readonly deleted: ReadonlyArray<string>;
  readonly gigabytes: { readonly kept: number; readonly unreachable: number };
  readonly blocked: string | null;
}

export async function sweep(env: HostEnv, { dryRun }: { readonly dryRun: boolean }): Promise<SweepReport> {
  const deleting = env.SWEEP === 'delete' && !dryRun;
  const namespace = await boxNamespace(env);
  const roots = await rootsOf(env, namespace);
  const ownApp = await applications(env, namespace);
  const registry = await registryOf(env, deleting);
  const snapshots = await inventory(registry);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));

  const keep = new Map<string, string>();
  const mark = (snapshot: Snapshot, why: string) => {
    for (const id of [...snapshot.chain, snapshot.id]) if (!keep.has(id)) keep.set(id, why);
  };
  const missing: Array<string> = [];
  for (const { box, snapshot } of roots) {
    if (!snapshot) continue;
    const found = byId.get(snapshot);
    if (found) mark(found, box);
    else missing.push(`${box}: ${snapshot}`);
  }
  for (const snapshot of snapshots) {
    if (Date.now() - snapshot.created < GRACE_MS) mark(snapshot, 'under an hour old');
    else if (snapshot.app !== ownApp.id && ownApp.existing.has(snapshot.app)) mark(snapshot, 'another application');
  }
  const unreachable = snapshots.filter((snapshot) => !keep.has(snapshot.id));
  const blocked = missing.length
    ? `the registry lacks the current snapshot of ${missing.join(', ')}`
    : !roots.some((root) => root.snapshot)
      ? 'no box has a snapshot'
      : null;

  const deleted: Array<string> = [];
  if (deleting && !blocked && unreachable.length) {
    for (const snapshot of unreachable) {
      await registry.delete(snapshot.repo, snapshot.tag);
      if (snapshot.setTag && (await registry.digest(snapshot.repo, snapshot.setTag)) === snapshot.digest)
        await registry.delete(snapshot.repo, snapshot.setTag);
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
    roots,
    missing,
    kept: kept.map((snapshot) => ({ ...listed(snapshot), for: keep.get(snapshot.id) ?? '' })),
    unreachable: unreachable.map((snapshot) => ({ ...listed(snapshot), app: snapshot.app })),
    deleted,
    gigabytes: { kept: sum(kept), unreachable: sum(unreachable) },
    blocked,
  };
}

const gigabytes = (bytes: number) => +(bytes / 1e9).toFixed(2);

async function boxNamespace(env: HostEnv): Promise<string> {
  const answer = await cloudflare(env, 'GET', '/workers/durable_objects/namespaces?per_page=1000');
  const namespace = Namespaces.parse(answer?.result).find((entry) => entry.script === HOST && entry.class === 'Box');
  if (!namespace) throw new Error(`no Durable Object namespace for ${HOST}'s Box class`);

  return namespace.id;
}

// Every Box object that stores anything, and every box the host lists; a box that can't answer stops the sweep.
async function rootsOf(env: HostEnv, namespace: string): Promise<Array<Root>> {
  const ids = new Map<string, DurableObjectId>();
  for (let cursor: string | null | undefined = ''; cursor !== undefined && cursor !== null; ) {
    const query = new URLSearchParams({ limit: '1000', ...(cursor && { cursor }) });
    const answer = await cloudflare(env, 'GET', `/workers/durable_objects/namespaces/${namespace}/objects?${query}`);
    const objects = Objects.parse(answer?.result);
    for (const { id, hasStoredData } of objects) if (hasStoredData !== false) ids.set(id, env.BOX.idFromString(id));
    cursor = objects.length ? answer?.result_info?.cursor : null;
  }
  for (const box of await list(env)) {
    const id = env.BOX.idFromName(box);
    ids.set(id.toString(), id);
  }

  return Promise.all(
    [...ids].map(async ([key, id]) => {
      const state = await env.BOX.get(id)
        .state()
        .catch((error: unknown) => Promise.reject(new Error(`the state of Box ${key}: ${messageOf(error)}`)));

      return {
        box: state.origin ? boxOfOrigin(state.origin) : key,
        phase: state.phase,
        snapshot: state.snapshot?.id ?? null,
      };
    })
  );
}

async function applications(env: HostEnv, namespace: string) {
  const apps = Applications.parse((await cloudflare(env, 'GET', '/containers/applications'))?.result);
  const own = apps.find((app) => app.durable_objects?.namespace_id === namespace);
  if (!own) throw new Error(`no container application for ${HOST}'s Box class`);

  return { id: dashed(own.id), existing: new Set(apps.map((app) => dashed(app.id))) };
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
      await (await send('PUT', 'gc/layers')).body?.cancel();
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
    chain: config.restore_chain.entries.map((entry) => entry.snapshot_id),
    bytes: config.blob_size_bytes,
    created: config.created_at_unix_seconds * 1000,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
