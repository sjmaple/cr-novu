# Novu Box

One container that runs the Novu Cloud stack (enterprise API, worker, socket worker, dashboard) with all of its
data stores, so a PR can be tried end to end before it merges. Where it differs from staging, and why, is in
[FIDELITY.md](./FIDELITY.md).

Boxes run on Cloudflare Containers. The image holds tools only. The Novu checkout, `node_modules`, builds and
database files live under `/data`, which a box keeps in its snapshot while it sleeps, so one image serves every box:

1. `box bake` builds a "golden" `/data` from a ref (13 to 16 minutes).
2. `box start` boots from it (about 20 seconds to a healthy API).
3. `box apply` puts a PR, or your checkout's changes, on a running box and rebuilds only what they change (about
   20 seconds to 6 minutes).

The box is plain TypeScript on Node's built-ins, with [zod](https://zod.dev) for the data that comes from outside,
in its own `package.json`, outside the pnpm workspace; Node runs the `.ts` files as they are. Run
`npm ci --prefix docker/box` once.

| Folder | What it is |
|---|---|
| `src/box` | The commands inside the box (`src/box/main.ts`: `bake`, `start`, `apply`, `doctor`, ...), and `sink.ts` |
| `src/cli` | The CLI on your machine (`src/cli/main.ts`), which drives the boxes (see "From your machine" below) |
| `src/cloud` | The Cloudflare host Worker, box Workers and Slack router (see "How it runs on Cloudflare") |
| `src/ci` | The pull request workflow's tasks (see "Per pull request") |
| `src/shared` | What they share: names, the JSON they exchange (zod schemas, `contracts.ts`), and the token check |
| `src/node` | What the Node sides share: child processes, `poll`, JSON over HTTP, the command table, `log` |
| `image` | The image: `Dockerfile`, `process-compose.yaml`, `config/` |
| `wrangler.jsonc` | The host Worker on Cloudflare (`box deploy`); `wrangler.slack.jsonc`, the Slack router's address |

`npm run typecheck --prefix docker/box` type-checks all of it (CI does, for PRs that change `docker/box`).

## What runs inside

process-compose supervises everything under tini (`image/process-compose.yaml`):

| Process | What it is |
|---|---|
| `mongo` | MongoDB 8, single-node replica set `rs0` |
| `redis-7000..7002` | Redis 7.2 cluster, TLS with a self-signed certificate made per box |
| `clickhouse` | ClickHouse 24.3 |
| `s3` | versitygw (S3 API), random keys per start, bucket `novu-box` |
| `sqs` | ElasticMQ (SQS API), the 5 Novu queues and their DLQs (`config/elasticmq.conf`) |
| `mail` | Mailpit: catches all email, plus SMS, push and chat through `sink` |
| `sink` | `src/box/sink.ts`: receives what the `generic-sms`, `push-webhook` and `chat-webhook` providers send and shows it in Mailpit |
| `migrate` | `box migrate`: replica set, Redis cluster, Mongo indexes, ClickHouse migrations, S3 bucket |
| `api`, `worker` | `pnpm deploy` output under `pm2-runtime` in cluster mode, as in the production images (`PM2_INSTANCES=1`) |
| `socket` | The socket worker (Cloudflare Worker) under `wrangler dev`, for realtime Inbox |
| `dashboard` | The built dashboard served by Caddy, with runtime env injected into `index.html` |
| `stripe` | `stripe listen`, forwarding sandbox webhooks to the API |
| `bridge` | `next start` of `playground/nextjs`: a self-hosted Novu app with code-first workflows and agents (`src/app/novu/`) on the checkout's `@novu/framework`, at `http://bridge.box.internal:4000/api/novu` |

Settings shared by every box are in `image/config/box.env`. The host adds each box's address and secrets to its
environment when it starts it (`boxEnv` in `src/cloud/container.ts`).

## Address

A box has one address, `https://novu-box-<box>.cli-shortener.workers.dev`, which reaches port 18080 in the box.
Caddy (`image/config/Caddyfile`) routes it by path: `/v1` `/v2` `/.well-known` to the API, `/ws` to the socket
worker, `/novu-box` to S3 (presigned upload URLs point here), `/mail` to Mailpit, `/cdn` to uploaded files, and the
rest to the dashboard. The dashboard calls the API same-origin there: unlike production, CORS isn't exercised.

## Secrets

Every secret is a Worker secret of the host, `novu-box-hub`, and is set or changed only in Cloudflare: in the
dashboard (Workers → novu-box-hub → Settings → Variables and Secrets) or with `npx wrangler secret put <NAME>` in
`docker/box`. Nobody keeps them on their machine. `box deploy` deploys code only (wrangler keeps a Worker's secrets
between deploys); it first reads the host's secret names, never their values, and warns about each required one
below that the host lacks. Set them all once, when the host is first deployed: the host can't create boxes'
Workers without `CLOUDFLARE_API_TOKEN`.

The host passes the box secrets (`SECRETS` in `src/shared/names.ts`) into each box's environment; no box gets the
host-only ones. A box runs PR code, and that code can read its environment, so:

- never use production keys, or Novu's own account (`NOVU_API_KEY`);
- use a staging key only when it can't change anything (the LaunchDarkly SDK key only reads flags);
- never name a secret `VITE_*`: those end up in the dashboard's public `index.html`;
- don't run boxes for PRs from forks.

| Secret | Boxes get it | Service | Used by |
|---|---|---|---|
| `LAUNCH_DARKLY_SDK_KEY` | yes | LaunchDarkly project `default`, environment `dev` (staging's) | API, worker |
| `CLERK_SECRET_KEY` | yes | Clerk app `novu-box` (`app_3KN3iEbdMZ8XqqRpi3hIC6wzzLE`), development instance | Bake (seeds the user and org), API |
| `BOX_SEED_PASSWORD` | yes | The seed user's dashboard password (`openssl rand -base64 24`), shared through the password manager | Bake (sets it on the Clerk user) |
| `STRIPE_API_KEY` | yes | Stripe sandbox `Novu Box` (`acct_1UODPmFKxZbFmwjX`), `sk_test_...` | Bake (puts the org on Team), `stripe listen`, API |
| `NOVU_MANAGED_CLAUDE_API_KEY` (optional) | yes | Anthropic, a workspace with a monthly spend limit, never Novu's production key | Start (runs thalamus and seeds the `box-managed` agent), API, bridge app (real models for its agents) |
| `BULL_MQ_PRO_NPM_TOKEN` (optional) | yes | Taskforce.sh registry | Bake; without it the box runs open-source BullMQ |
| `GITHUB_READ_TOKEN` | no | GitHub, fine-grained, `novuhq`, repositories `novu` and `packages-enterprise`, Contents and Checks read | Every bake's and apply's git fetches and CI lookup (never the installs, builds or apps), instead of the caller's token, so no push-capable token reaches a box. Without it, people's calls use their own `gh` token, and CI can't apply |
| `CLOUDFLARE_API_TOKEN` | no | Cloudflare, Account, Workers Scripts, Edit, on the Novu account only | The `/__box/boxes` routes, which create and delete boxes' Workers |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | no | Novu Bot (see "Slack") | The Slack router; without them, boxes get no Slack |

A new fine-grained GitHub token needs an org owner's approval (the current one expires 2027-10-17). Until it's
approved it reads only public `novuhq/novu`: applying a PR works, but a bake (so the nightly rebake, and a box
started when `base` has no snapshot) and an apply that moves `.source` fail at the enterprise submodule.

The dashboard signs in as `agent@novu.co` with `BOX_SEED_PASSWORD`. All boxes share the Clerk
development instance and its one seed org. Every bake gives that org the same Novu ID (`SEED.novuOrgId` in
`src/box/clerk.ts`), so the Clerk org links to it in every box, older bakes included. Boxes also share its Stripe
customer, so a billing change made in one box reaches the others through their `stripe` process.

Box URLs are public, like staging's. Anyone with a `@novu.co` address can sign up (the allowlist) and gets their own
org; the code Clerk emails them proves they own the address. The seed org stays behind the password. That holds
only while the Clerk instance has these two settings:

1. **User & authentication → Email → Sign-in with email → Email verification code: off.** Sign-in needs the
   password.
2. **Settings → Test mode: off.** With it on, Clerk accepts `424242` as the code for any made-up
   `+clerk_test@novu.co` address, so anyone could sign up.

Check them with `curl -s https://electric-sponge-6737.clerk.accounts.dev/v1/environment`: `email_address` must not
list `email_code` in `first_factors`, and `auth_config.test_mode` must be `false`.

## Use it

Everything goes through the CLI on your machine (see "From your machine"). In the box, `box apply` (which `sync`
and the PR workflow run) puts a PR, a branch, a full SHA or your checkout on a running box: it merges it onto the
baked commit (like CI's merge ref) and stops if the two conflict. It then
reinstalls if the lockfile changed, builds the projects `nx affected` reports, redeploys the API and worker,
runs migrations and restarts what changed. A PR that changes `@novu/framework`, `@novu/agent-toolkit` or
`playground/nextjs` also rebuilds the bridge app (about 55 s), restarts it and syncs it again, so the PR's
workflows and agents run on the PR's framework. It logs the plan before it runs it, for example
`plan: install no, build @novu/worker, restart worker` (about 15 s for that one).

It builds only what the change needs (`src/box/build.ts`):

- **API or worker sources:** it compiles only the changed files, with Nest's own SWC compiler and the app's
  config (the same output as `nest build`), and the API regenerates its metadata. A new, deleted or renamed file,
  or a change to the app's config or the root `tsconfig.json`, builds the app in full.
- **A library:** it builds that library, then each library depending on it whose output can change: for one tsc
  builds, only when the declarations (`.d.ts`) it compiles against changed; for one a bundler builds, always. The
  apps don't recompile for a library change (SWC reads no other files), and the API regenerates its metadata only
  when declarations changed. `@novu/framework` builds without its declarations (90 of its 92 s) unless a library
  changed in the same apply compiles against them; the old ones stay, marked stale, and the next apply that builds
  such a library builds the framework's declarations first. A change outside every project (a root config) builds
  every library the apps use, as a bake does (nx's cache replays the unchanged ones).
- **The lockfile:** it reinstalls, then rebuilds and restarts only the apps whose locked dependencies changed, by
  comparing what each installs at the two commits (`src/box/lockfile.ts`; nx can't tell from a changed lockfile).
  Its devDependencies and the root's count (a new SWC, TypeScript or Nest CLI rebuilds every app); only a change to
  an app's production dependencies redeploys it (`pnpm deploy`). The API and worker deploy at once, offline first.
  After an interrupted apply, a lockfile change rebuilds and redeploys everything. A changed `package.json` alone
  doesn't reinstall: a dependency change always changes the lockfile.

Add `--full` to install, build and restart everything, as a bake does (about 5 minutes), when the box behaves in a
way the PR doesn't explain. `apply` also logs the PR's `PR Checks Passed` result from GitHub, and a `WARN` if
CI failed: the box skips type checks, so it can run code CI rejects.

One apply runs at a time; a second one stops with `another apply is running`. An apply that fails or is killed
after its checkout leaves `/data/.applying.json`, `doctor` reports it, and the next apply rebuilds what that one
touched as well as its own changes.

### From your machine: `src/cli/main.ts`

`node docker/box/src/cli/main.ts` (or `npm run box --` in `docker/box`) drives the boxes from your checkout. Run
it from anywhere in the checkout; `--box <name>` picks the box, by default the current branch's. You need `gh`
signed in as someone with push access to `novuhq/novu` (the box's Worker checks it on every control call). To
deploy the host you also need `npx wrangler login` on the Novu Cloudflare account and Docker, which wrangler builds
the image with. No secrets (see "Secrets").

| Command | What it does |
|---|---|
| `node docker/box/src/cli/main.ts up` | Starts the box and waits until `doctor` passes: deploys the host if it isn't there, has the host create the box's Worker, then wakes the box from its snapshot or, the first time, bakes `next`. Without `--box`, a new box starts from `base` and gets your checkout (see "How it runs on Cloudflare") |
| `node docker/box/src/cli/main.ts sync` | Puts this checkout on the box, committed or not, and rebuilds what it changes. `--full` as for `apply` |
| `node docker/box/src/cli/main.ts doctor` | Whether the box is fit to test on, as JSON; `problems` says what isn't, and it exits 1 if any |
| `node docker/box/src/cli/main.ts mail [search \| id]` | What the box sent, from its Mailpit: the newest messages (email, and SMS, push and chat from the sink), a search (`to:a@b.c`, `subject:Welcome`, `tag:sms`), or one message with its headers, links, Mailpit's HTML check (which email clients break on what) and a `view` URL to screenshot; `--html`, `--check-links`, `--limit <n>` |
| `node docker/box/src/cli/main.ts logs [process]` | The last 200 lines (`--tail <n>`) of one process, or of all of them merged, as `name \| LEVEL context: message`; `--errors` keeps warnings and errors, `--follow` streams new lines. An unknown name lists the processes |
| `node docker/box/src/cli/main.ts exec -- <command>` | Runs a command in the box's checkout (`/data/novu`) |
| `node docker/box/src/cli/main.ts down` | Saves the box to its snapshot and stops it; the next request, or `up`, wakes it with its data |
| `node docker/box/src/cli/main.ts delete` | Stops the box and deletes it with its snapshot and Worker (see below) |
| `node docker/box/src/cli/main.ts deploy` | Deploys the host, its image and the Slack router (see below) |

`sync` puts the checkout on the box as `apply` puts a PR: it commits HEAD plus every change, untracked files
included and ignored files not, into one commit, and sends it as a git bundle. The box merges it onto the baked
commit and runs the same plan (times are under "How it runs on Cloudflare"). Your own index and staging stay as
they are.

| Change | Plan |
|---|---|
| None since the last sync | nothing |
| An API file, plus a new untracked file | build the API |
| A library (`@novu/application-generic`) | build the API and worker |

Untracked files are sent only inside the top-level folders the repo already has (`apps`, `libs`, `packages`, ...).
Untracked files elsewhere, such as scratch folders, tool state, or a screenshot or `.env` at the root, stay on your
machine; `sync` names them in its first line. `sync` stops before sending more than 25 MB, which code changes never
reach, and names the biggest changed files. It sends the enterprise submodule's commit, not uncommitted changes
inside `.source`.

### How it runs on Cloudflare

Every box's container runs in one host Worker, `novu-box-hub` (`src/cloud/host.ts`, one Durable Object per box),
and each box has its own small Worker for its address, `novu-box-<box>` (`src/cloud/thin.ts`, no container), at
`https://novu-box-<box>.cli-shortener.workers.dev` (see "Address").

The host and its image are `wrangler.jsonc`, the Slack router's address `wrangler.slack.jsonc`; the boxes aren't in
them (the host creates their Workers at runtime). `box deploy` runs `wrangler deploy` for both with your wrangler
login, adding the thin Worker's bundle, which the host uploads for every box. It needs wrangler 4.150 (the package's own,
`node_modules/.bin/wrangler`): 4.68 rejects this config's `exports` (Durable Objects on SQLite without
`migrations`), the container's `images` and `scheduling_policy: "durable_object"`. wrangler builds the image (for
amd64) from what `image/Dockerfile.dockerignore` lets in and pushes it only when it changed.
`up --deploy` (or `box deploy`) redeploys the host (after a change to `docker/box`), which applies to every box; with the
same image, running boxes usually keep running, but once a box's container restarted from its last snapshot
minutes after a deploy, losing what wasn't saved (an applied PR). The likely cause: a deploy restarts every Durable
Object, which drops the container's inactivity timeout until the next alarm; the Box now sets it again as it
restarts. Until that is proven, `down` a box worth keeping before deploying. A save that a deploy cuts off resumes
the box at its next alarm. `delete` has the host stop a box, forget its snapshot and delete its Worker; when
the box doesn't stop, its Worker stays and `delete` fails.

After an hour without requests the box saves itself to a snapshot and stops; the next request gets a "waking up"
page and the box is back with its data. `BOX_IDLE_MINUTES=4 node docker/box/src/cli/main.ts deploy` sets a
shorter wait for every box, to test the sleep; the next deploy without it goes back to 60. Asking a box for its
state (`/__box/state`) doesn't count as a request. While a box saves, its address and every control call but
`state`, `down`, `delete`, `discard` and `adopt` answer 503 with `Retry-After` (the CLI waits); a `delete`, `discard`
or `adopt` during a save wins.

`state` gives the box's `phase`, with `since` and the last `error`: `new` (never started, or its bake failed:
`error` holds the end of `/data/logs/up.log`, and the next `up` bakes again), `baking`, `running`, `saving`,
`asleep` (with its snapshot), or `lost` (its snapshot couldn't be restored). Measured on standard-4:

| Step | Time |
|---|---|
| First `up` of a box (bake `next`) | 13 to 16 min |
| `down` (stop every process, snapshot, stop) | 18 s to 6 min (the box saves on its own; `down` waits, and fails unless a new snapshot is stored) |
| Wake, from the first request to a healthy API | 33 to 42 s |
| `sync`, an API change | 57 to 83 s |
| `apply` in the box, to healthy apps | an API change 40 s, a worker change 16 s, a library change 51 to 69 s (more when the declarations of `@novu/shared` change: 119 s), `@novu/framework` 114 s, a lockfile change that changes no app's dependencies 20 s |
| Smoke over the public address (a box started from `base`) | 43/43 in 70 to 75 s |
| `up --from base` for a new box (deploy its Worker, then wake from base's snapshot, no bake) | 80 to 106 s, of which about 40 s is the wake |
| The same, seen three times | 4 to 6 min (inside the start); cause unknown |
| `box deploy` of a code change with the same image | 12 to 16 s; running boxes usually keep running (see above). Nothing changed: 5 s |

`up --box <new> --from <box>` starts a new box from another box's latest snapshot instead of baking: all
boxes share one Durable Object class, which is how Cloudflare documents snapshot sharing. Keep a `base` box, baked
from `next`, to start new boxes from, and leave it asleep: every sleep gives it a new snapshot, and twice the first
box started from a snapshot waited 4 to 6 minutes. `up` without `--box` is your branch's box: a new one
starts from `base`, then gets your checkout, committed or not (as `sync`; `--no-sync` skips it). A branch that
doesn't contain `base`'s commit may conflict; rebase it on `next`.

Cloudflare deletes a snapshot 30 days after it was made or last restored, and nothing extends it. The workflow
keeps `base` fresh (see "Per pull request"): every push to `next` refreshes it, and it's rebaked nightly, which also
moves it onto the current image, since a snapshot only restores on the image it was taken on. A box whose snapshot
can't be restored forgets it and is `lost`. A PR box, and your branch's box (`up` without `--box`), then start
again from `base` and apply the PR or your checkout; `up --box <name>` says so, and the next `up` bakes.

#### Snapshots

Each save is a btrfs delta on the snapshot the box woke from, stored in the account's registry (two tags,
`rootfs-snapshot-*` and `rootfs-set-*`, on the repository of the box image; `npx wrangler containers images list`),
and its metadata lists its whole chain back to the first full snapshot (about 3.7 GB). A box started from `base`
continues `base`'s chain. A refresh adds a delta to `base`'s chain (0.4 GB for 56 changed files); the nightly
rebake starts a new chain. Nothing deletes old snapshots (`FIDELITY.md`, "Snapshot storage").

Limits for now: requests the box makes to its own public address go out through the internet; a host redeploy with a new
image is untested with boxes running. A `sync` whose rebuild runs longer than 5 minutes (a playground change, with
`pnpm install`) ends with `fetch failed` and leaves the bundle unapplied; apply it in the background and follow
its log:
`node docker/box/src/cli/main.ts exec -- sh -c 'nohup node /opt/box/src/box/main.ts apply --bundle /data/run/sync.bundle > /data/logs/apply-sync.log 2>&1 &'`.

#### Per pull request: the `box` label

`.github/workflows/novu-box.yml` gives a PR in `novuhq/novu` its own box, `pr-<number>`, while we battle-test
boxes on demand only:

- Adding the `box` label starts the box from `base` (as `up --box pr-<n> --from base`; it bakes `next`
  when `base` has no snapshot) and applies the PR's head commit as soon as the box answers (the apply restarts
  the API anyway; the comment waits for a healthy box). A PR box whose snapshot is gone starts from `base` again
  the same way. Only someone with write access to `novuhq/novu`
  can start one: the workflow checks who added the label, on every run, and otherwise only says so in the PR. PRs
  from forks get no box (`pull_request` gives them no OIDC token; the workflow doesn't use `pull_request_target`).
- Every push applies the new head (`box apply <sha>`). One run per PR at a time: a newer push cancels the older
  run, and the newer run stops the older run's apply in the box before it starts its own (the apply's marker makes
  the next apply redo its files).
- One comment on the PR, edited in place, says "applying", then the box's address, the applied commit, the apply's
  plan line and how long it took, or what failed and where its log is. When the apply ran but `doctor` then finds
  problems (the PR broke the worker), the comment is ⚠️ with them, and the next push still applies.
- Events on a closed PR create nothing. Every wait ends 5 minutes before the job's 60-minute timeout, so the
  comment says the time ran out instead of staying on "applying".
- Closing the PR or removing the label deletes the box. At most 30 PR boxes exist at once; over that, the comment
  says so. Nightly, the workflow deletes `pr-*` boxes whose PR is closed or no longer labeled.
- Every push to `next` refreshes `base` (`refresh`): it wakes `base`, applies `next`'s head with
  `box apply <sha> --baseline`, which also makes that commit the baked one, so a PR box started from `base` merges
  onto the new `next` and builds only the PR's changes, then saves it (3.7 minutes for 56 changed files that
  rebuild the API, worker and dashboard, of which the apply is 2.5). One refresh runs at a time; pushes during it
  leave one waiting run, for the newest `next`, and a running refresh is never cancelled (that would lose the
  save). A `base` already on `next`'s head is stopped again without a save. A failed apply (a `next` that doesn't
  build) stops `base` without a save (`/__box/discard`), so it keeps its last snapshot, and the job fails; the next
  push tries again. It rebakes instead when `base` has no snapshot or doesn't wake (a snapshot from an older image),
  or when `base` was baked over 26 hours ago (a skipped nightly rebake; a refresh keeps the bake's time).
- Nightly, the workflow also rebakes `base` from `next` (`rebake`), starting a new snapshot chain, so refreshes
  don't grow one chain forever, and keeping its snapshot from expiring. It bakes in a box of its own,
  `base-next`, saves it, and only then does `base` take over that snapshot (`/__box/adopt`) and `base-next` go:
  `base` always has a snapshot, and a failed bake leaves the old one. A push that arrives while the rebake waits to
  start replaces it with a refresh (the 26-hour rule catches up). `cleanup`, `rebake` and `refresh` also run by
  hand with "Run workflow".

`docker/box/src/ci/ci.ts` does all of it, through the CLI's cloud target (`src/cli/cloud.ts`);
the workflow runs `npm ci` in `docker/box` first. The workflow holds no secret. It signs in to the boxes with its
GitHub Actions OIDC token (audience `novu-box`), which `src/shared/auth.ts` verifies in the Workers (RS256 against
GitHub's keys; issuer, audience, time, repository `novuhq/novu` and workflow `novu-box.yml`), next to the
push-capable GitHub tokens people use. Boxes' Workers are created and deleted only by the host
(`src/cloud/boxes.ts`, which holds their bindings), not wrangler, at the host's own address:

| Route on `novu-box-hub` | What it does |
|---|---|
| `GET /__box/boxes` | Lists the boxes (every `novu-box-<name>` Worker but the host and the router) |
| `PUT /__box/boxes/<box>` | Uploads the box's Worker (`thin.ts`, bundled into one module by `box deploy`, bound to the host's Box class) and puts it on workers.dev |
| `DELETE /__box/boxes/<box>` | Stops the box and forgets it, then deletes its Worker; keeps the Worker (502) when the box didn't stop |

The Slack router's Worker, `novu-box-slack` (`wrangler.slack.jsonc`), deploys with the host.

#### Slack: Novu Bot in `#novu-box`

Boxes' agents can be used from the company Slack through one app, Novu Bot, in `#novu-box` and in DMs with
the bot. The Slack router (`src/cloud/slack/router.ts`; each box's part is `src/cloud/slack/box.ts`) runs in the
host Worker as one more Durable Object, at its own address `novu-box-slack` (a small Worker like a box's, deployed
with the host); it holds the real bot token and signing secret and stands between Slack and every box; no box ever
sees them.

- Slack is on when the host has Novu Bot's credentials (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, host secrets
  which no box gets; see "Secrets"). Then every box gets `SLACK_API_URL`, the router's `/api/`.
  `box deploy` always deploys `novu-box-slack`; its address and the channel are in `wrangler.jsonc`'s `vars`. Novu Bot's Events, Interactivity
  and `/novu-box` request URLs are `https://novu-box-slack.cli-shortener.workers.dev/slack`.
- Once a box is up, and again when its agents change (a `sync`), the host gives each of the bridge app's agents a
  Slack integration (`box-slack-<agent>`) and a workspace connection through the box's API, with a bot token
  and signing secret the router made up for that box. The router posts "<box> ready · Talk to: …" in
  `#novu-box`; `delete` removes it and the box's tokens.
- In Slack, pick a box and agent with a Talk to button (or `/novu-box <box> [agent]`, or the bot's Home tab),
  then @mention Novu Bot in `#novu-box` or DM it. A thread keeps its box and agent; the main DM follows your
  pick. Replies show as "<box> · <agent>". The agents answer only people linked to a subscriber, so the first
  time someone writes to a box's agent, the router has the host link them as subscriber `slack-<user id>`.
  Start a thread with a mention; `custom-code-agent` reads the first word, so `@Novu Bot card` gets its command
  list, and `card` as a reply in the thread (or in a DM) gets the card. For a sleeping box the router answers Slack at once, posts
  "Waking <box> (about 40 s)…" in the thread, and delivers the message when the box is up (it retries for 8
  minutes). In a thread of a deleted box, the router tells you so and to start a new message.
- The router passes only the Slack methods the agents use, only to `#novu-box` and DMs a person started, and
  edits only a box's own messages; anything else gets `ok: false`
  with a `…_by_novu_box` error. A token it didn't make (a Slack app you connect in the box's dashboard) goes to
  Slack unchanged. It doesn't keep boxes
  apart within those: a box's code can read every thread in `#novu-box` and any DM with the bot, which is fine
  for a channel only Novu's developers and TesterArmy use.

Each box's `/__box/state` lists `slackEvents`, the last events its agents got, to check where a message went.

Cloudflare ties each snapshot to the image it came from, so a new image means boxes bake or start from a snapshot of
that image. To deploy only Worker changes on a given image:
`BOX_IMAGE=registry.cloudflare.com/<account>/<image>@sha256:<digest> node docker/box/src/cli/main.ts deploy`
(the image is in `npx wrangler containers images list`).

The playground (`playground/nextjs`) is the catalog of agent features: every new feature gets a demo there. It has
one agent per `novu connect` runtime, all built on the same features
(`playground/nextjs/src/app/novu/agents/features.ts`), and all three share the reaction, edit, delete, resolve and
card-click handlers:

- `custom-code-agent` (`agent()` from `@novu/framework`) has no model. Each feature is a typed command (`card`,
  `remember <text>`, `recall`, `notify <name>`, `done`, `progress`, `delete`, `file`, `quote`, `react`, `emit`,
  `approve`, `multi-approve`, `custom-approve`, `custom-chrome-approve`, `ask`, `choose`, `tell`,
  `weather <city>`); anything else lists them. It works the same with or without the key. It's the only agent
  with HITL (`approve`, `ask`, `choose`, `tell`), because only plain `agent()` handles the answer. `file`,
  `quote`, `react` and `multi-approve` need Slack (see `FIDELITY.md`, "Web chat limits").
- `ai-sdk-agent` and `langchain-agent` get every other feature as a tool and, with
  `NOVU_MANAGED_CLAUDE_API_KEY`, run on Claude Haiku, which picks the tools from plain sentences and also reads
  attached images and PDFs (this spends from the key's workspace, not Novu's managed-Claude quota). Without the
  key they run on scripted fakes that only know the gated `get_weather` tool.

With `NOVU_MANAGED_CLAUDE_API_KEY`, `start` also runs the thalamus observer and seeds `box-managed`, a managed
agent on the Novu-managed Claude integration (Claude Haiku, only the `bash` tool, which asks before it runs).
It calls Anthropic for real; Novu's own caps still apply (100,000 tokens per conversation, and 200 managed-Claude
conversations per org per month instead of the default 10, see FIDELITY.md).

Other commands of the box, run with `node docker/box/src/cli/main.ts exec -- node /opt/box/src/box/main.ts <command>`:

- `status` lists processes. Logs are in `/data/logs/process-compose.log`.
- `doctor` and `logs [process]`, which the CLI runs. `logs` reads `/data/logs/process-compose.log`, where
  process-compose writes every process's output.
- `state` prints the baked and applied commits, an unfinished apply, and the bake or apply running now (`lock`,
  `/data/run/box.lock`), as JSON. `stop-apply` stops that apply (CI does, before applying a newer push).
- `quiesce` stops every running process, the data stores last, leaving the supervisor up for a snapshot; it fails
  if anything still runs. `resume` starts again what it stopped (the Cloudflare Worker runs it when a save fails).
- The processes are listed once, in `PROCESSES` in `src/box/processes.ts`; `doctor` reports a process that
  `image/process-compose.yaml` and that list don't both have.

## What the bake seeds

- A Novu user and org from the Clerk seed user and org, created by the API on first sign-in, as in production.
- Mailpit (`nodemailer` over SMTP) as the primary email integration in every environment.
- `generic-sms`, `push-webhook` and `chat-webhook` integrations pointing at the sink, and a phone number, push
  token and chat webhook on the seed user's subscriber, so the dashboard's Test Workflow reaches every channel.
- The bridge app synced to the Development environment. It signs with that environment's secret key, which the
  bake writes to `/data/bridge/secret-key`. Each of its agents is created, linked to web chat and pointed at the
  bridge.
- The org on the Team plan: a test card on its Stripe customer and its subscription moved to the Team prices.
  Novu's own webhook handler, fed by `stripe listen`, then sets the tier. For checkout by hand, use the test card
  `4242 4242 4242 4242`.

## External services

- **Clerk:** app `novu-box`, development instance, with settings copied from staging. Only the development
  instance is used; the production app `Novu Cloud` is never touched.
- **Stripe:** sandbox `Novu Box`, with staging's 12 prices copied and Stripe Tax on, so Upgrade works.
- **LaunchDarkly:** staging's project and environment through a read-only SDK key. Box orgs get staging's
  default rules like any new customer.
- **SQS:** ElasticMQ in `sqs_bullmq` mode: every job goes through the SQS API as on staging, and delays over
  15 minutes are held in BullMQ instead of EventBridge Scheduler.

## Troubleshooting

- **The dashboard signs in but shows the wrong org, or none:** the box was baked before the seed org had a fixed
  ID (October 2026). Bake it again.
- **Mailpit has no SMS, push or chat:** check `sink` in `status`, and that the step's integration is one of
  the `Box ... (sink)` ones.
