import fs from 'node:fs';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { log } from '../node/main.ts';
import { messageOf } from '../shared/errors.ts';
import { REPO } from './paths.ts';
import { PROCESS_DIRS } from './processes.ts';
import { output } from './runtime.ts';

type Dependencies = Record<string, string>;
interface Lockfile {
  readonly importers?: Record<string, Record<string, Record<string, { readonly version: string }>>>;
  readonly packages?: Record<string, unknown>;
  readonly snapshots?: Record<
    string,
    { readonly dependencies?: Dependencies; readonly optionalDependencies?: Dependencies }
  >;
}

const PROD = ['dependencies', 'optionalDependencies'];

// The code processes whose locked dependencies differ between the two commits. nx can't tell: given the changed
// files, it reads a lockfile change as touching every project, or (in its `auto` mode) none.
export async function relockedProcesses(from: string, to: string): Promise<Array<string>> {
  try {
    const [before, after] = await Promise.all([readLockfile(from), readLockfile(to)]);

    return PROCESS_DIRS.filter(
      ({ dir, deployed }) => locked(before, dir, !deployed) !== locked(after, dir, !deployed)
    ).map(({ name }) => name);
  } catch (error) {
    log(`WARN: couldn't compare the lockfiles (${messageOf(error)}); every app counts as changed`);

    return PROCESS_DIRS.map(({ name }) => name);
  }
}

async function readLockfile(commit: string): Promise<Lockfile> {
  // The checkout's own YAML parser, the one nx reads the lockfile with.
  const yaml = createRequire(fs.realpathSync(`${REPO}/node_modules/nx/package.json`))('@zkochan/js-yaml');

  return yaml.load(await output('git', ['show', `${commit}:pnpm-lock.yaml`]));
}

// What `dir` installs: its dependencies, theirs, and those of the workspace packages it links, each with its
// resolution and what it links to. devDependencies count only for `dir` itself, and only when it isn't a
// `pnpm deploy --prod` (bundlers read them).
function locked(lock: Lockfile, dir: string, withDev: boolean): string {
  const packages = new Map<string, unknown>();
  const dirs = new Map<string, unknown>();
  const visitPackage = (name: string, version: string) => {
    const key = /^(@[^/@]+\/)?[^@(]+@/.test(version) ? version : `${name}@${version}`;
    if (packages.has(key)) return;
    const snapshot = lock.snapshots?.[key];
    packages.set(key, [lock.packages?.[key.replace(/\(.*$/, '')] ?? null, snapshot ?? null]);
    for (const [dep, depVersion] of Object.entries({ ...snapshot?.dependencies, ...snapshot?.optionalDependencies }))
      visitPackage(dep, depVersion);
  };
  const visitDir = (current: string, groups: ReadonlyArray<string>) => {
    if (dirs.has(current)) return;
    const importer = lock.importers?.[current] ?? {};
    dirs.set(
      current,
      groups.map((group) => importer[group] ?? null)
    );
    for (const group of groups)
      for (const [name, { version }] of Object.entries(importer[group] ?? {}))
        if (version.startsWith('link:')) visitDir(posix.join(current, version.slice('link:'.length)), PROD);
        else visitPackage(name, version);
  };
  visitDir(dir, withDev ? [...PROD, 'devDependencies'] : PROD);
  const sorted = (entries: Map<string, unknown>) => [...entries].sort(([a], [b]) => (a < b ? -1 : 1));

  return JSON.stringify([sorted(dirs), sorted(packages)]);
}
