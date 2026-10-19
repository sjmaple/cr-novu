---
name: verify-in-box
description: Verify a change end to end on the Novu Box, a full Novu Cloud stack in one container on Cloudflare. Use when a change to apps/, libs/, packages/, enterprise/ or playground/ needs proof that it works, or when asked to check, verify, demo or reproduce something on the box.
---

# Verify in the box

The box runs the whole Novu Cloud stack (API, worker, socket, dashboard, the bridge app, every database) on
Cloudflare, with your checkout on it. `docker/box/README.md` is the reference for every command, URL and credential
named here. The CLI needs `gh` signed in as someone with push access to `novuhq/novu`; no secrets on your machine.

Run each step from the repo root. A step is done when its check passes; the evidence it names goes in your report.

## 1. Launch

```sh
npm ci --prefix docker/box   # once per checkout, and after docker/box/package-lock.json changes
node docker/box/src/cli/main.ts up
node docker/box/src/cli/main.ts sync
```

Done when `sync` exits 0 and ends with `applied sync <branch> at <sha>`. Keep its `plan:` line: it says what the box
rebuilt and restarted, which is part of the evidence.

- One box per branch, shared by everyone on that branch. When agents work in parallel, give each its own
  `--box <name>` on every command, and never drive a box you didn't start.
- `up` is your branch's box: a new one starts from `base` in about 2 minutes and already gets your checkout (the
  `sync` after it then has nothing to do); an existing one wakes in under a minute. Without a `base` snapshot it
  bakes `next` first (13 to 16 minutes).
- It prints the box's one address, `https://novu-box-<branch>.cli-shortener.workers.dev`: the dashboard, the API
  under `/v1`, Mailpit under `/mail`. `<box>` below means that address.
- `sync` sends new files only inside the repo's existing top-level folders. A new file at the root or in a new
  top-level folder isn't sent; commit it or move it if the box needs it.
- `sync` stops over 25 MB and names the biggest changed files. Ask the user before deleting or ignoring any of them.
- A conflict with the box's baked commit stops `sync` before it touches the box. Merge or rebase onto `next`, then
  sync again.

## 2. Doctor

```sh
node docker/box/src/cli/main.ts doctor
```

Done when it prints `"ok": true`. Otherwise read `problems`, then `node docker/box/src/cli/main.ts logs <process>` for the
process named. An unfinished apply is fixed by syncing again. `logs --errors` (no process) shows the warnings and
errors of every process; `logs --follow` streams them while you drive the change.

## 3. Drive

Exercise the change the way a user reaches it, on the path the change touches:

- **API or worker:** call `<box>/v1/...`. The Development environment's secret key is
  `node docker/box/src/cli/main.ts exec -- cat /data/bridge/secret-key`; send it as `Authorization: ApiKey <key>`.
- **Dashboard:** open `<box>` in a browser and sign in with the seed user from the README.
- **Email, SMS, push, chat:** every email the box sends lands in its Mailpit, and the sink puts SMS, push and chat
  messages there too. Trigger the workflow, then:
  1. `node docker/box/src/cli/main.ts mail to:<recipient>` (or `subject:<text>`, `tag:sms`; no argument lists the newest).
     Done when the message is listed; if it isn't, `logs --errors` says why.
  2. `node docker/box/src/cli/main.ts mail <id>`: check the headers, the text and the links against what the change
     should send, and read the `html check`: it names the CSS and HTML features that break in which email clients.
     `--html` prints the source; `--check-links` requests every link (only when the links are safe to request).
  3. For a template change, open the `view` URL it prints with the agent-browser skill and screenshot it at 600 px
     and 375 px wide. That's the HTML alone, as a browser renders it, not Gmail or Outlook; the html check covers
     those.
- **Bridge workflows and agents:** they live in `playground/nextjs`; the box syncs them on every apply that changes
  the framework or the playground.
- **Broad changes** (shared libraries, auth, queues): also drive the main flows the change could break (sign-in,
  trigger a workflow and check the message, an agent reply), not only the changed path.

Done when the changed behaviour is observed working, and the behaviour beside it still works. One happy path is a
_tracer_, not proof: drive at least one failure case the change handles.

The box skips type checks, so it runs code CI would reject. Run the affected project's typecheck as well.

## 4. Evidence

Report, for the user to reproduce:

1. The `plan:` and `applied` lines from `sync`.
2. The `doctor` result.
3. Each check from Drive: the exact command or page, and what came back (status, response body, a screenshot path).
   For a message: the `mail <id>` output (headers, html check) and the screenshot paths.

## 5. Cleanup

Leave the box running while the user may still look at it; it saves itself and sleeps after an hour without
requests, and wakes on the next one. `node docker/box/src/cli/main.ts down` puts it to sleep now; the data stays for
the next `up`.

Ask the user before `node docker/box/src/cli/main.ts delete`, which deletes the box with its data.
