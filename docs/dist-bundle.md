# Self-contained daemon dist bundle (Plan C Task 5 spike)

**Result: PASS.** `pnpm build:dist` produces `dist/daemon/` (daemon.mjs +
node_modules, 99M total) that boots and answers RPCs on a bare `node`, with
the repo's node_modules renamed away, and — after the Kink 8 integrity
sweep (below) — every symlink inside `dist/daemon` resolves to a real
target that is itself inside `dist/daemon`. That's what actually backs the
"relocatable" claim: the tree can be moved as a whole (another directory,
another machine with the same OS/arch) without a dangling or repo-escaping
link anywhere in it.

Build script: `scripts/build-dist.mjs`. Command: `pnpm build:dist`.

**Not a pinned, reproducible artifact.** `dist/daemon/` is rebuilt from
whatever `pnpm-lock.yaml` resolves to *at build time* — `pnpm deploy`
re-resolves the workspace's dependency graph fresh each run, it doesn't
replay a frozen snapshot. The three native deps' `package.json` ranges are
caret ranges, so two builds run on different days (or different machines
with different pnpm/store states) can legitimately pick up different
patch/minor versions of `better-sqlite3-multiple-ciphers`,
`node-llama-cpp`, `sqlite-vec`, or any of their transitive deps, without
any change to this script or to `pnpm-lock.yaml` itself needing a bump in
between (a `pnpm install` refresh, or CI running on a different day against
an unpinned range, is enough). Treat `dist/daemon/` as build output, not a
versioned release artifact — don't diff two builds' `node_modules` and
expect byte-identical trees, and don't archive a `dist/daemon/` build as
"the v-whatever bundle" without also recording the exact lockfile commit it
came from.

## Approach summary

- esbuild bundles `packages/daemon/src/main.ts` (and everything it
  transitively imports, including all of `@shyn/engine`'s TS source) into a
  single `dist/daemon/daemon.mjs`.
- The three native packages (`better-sqlite3-multiple-ciphers`,
  `sqlite-vec`, `node-llama-cpp`) are esbuild `external` — can't bundle
  native `.node` addons — and are carried alongside as a real (non-symlink)
  `dist/daemon/node_modules/`.
- That node_modules tree is produced by `pnpm --filter @shyn/daemon deploy
  <scratch> --prod`, not by hand-walking each native's `package.json`
  `dependencies` as the task brief sketched. Rationale in Kink 2 below.
- Output is ESM (`daemon.mjs`, `dist/daemon/package.json` has `"type":
  "module"`), not CJS as the brief's sketch had it. Rationale in Kink 1.

## Every kink, and its resolution

### Kink 1 — top-level await rules out `format: "cjs"`

`main.ts` does `const server = serverHandle = await startServer(...)` at
module top level. esbuild's `cjs` output format hard-rejects this:

```
✘ [ERROR] Top-level await is currently not supported with the "cjs" output format
```

**Resolution:** build with `format: "esm"`, `outfile: dist/daemon/daemon.mjs`,
and `dist/daemon/package.json` set to `{"type": "module"}`. No banner/shim
needed — `__dirname`/`__filename` are never used in `main.ts` or anything it
imports (checked: no references survive in the bundle). Node 22 supports
top-level await in ESM natively, and CJS native addons (`better-sqlite3-*`,
which does `module.exports = ...`) import cleanly into ESM via the default
namespace object, which the code already assumed (`import Database from
"better-sqlite3-multiple-ciphers"`).

### Kink 2 — hand-walking native deps' `package.json` is the wrong tool; `pnpm deploy` is the right one

The brief's sketch called for copying each native's directory and then
"walking their package.json dependencies transitively." In practice
`node-llama-cpp` alone declares ~25 runtime `dependencies` (`chalk`,
`ora`, `cmake-js`, `ipull`, `lifecycle-utils`, `simple-git`, `yargs`, …),
several of which have their own transitive deps, plus platform-specific
`optionalDependencies` (`@node-llama-cpp/mac-arm64-metal`, etc., only the
matching platform actually gets installed).

**Resolution:** use `pnpm deploy <dir> --prod` for `@shyn/daemon`, which is
pnpm's own supported mechanism for producing a pruned, production-only,
already-fully-resolved node_modules for a single workspace package,
including nested workspace deps (`@shyn/engine`) and everything *their*
`dependencies` need. It is the same resolver pnpm workspaces already trust
for real deploys, so reimplementing that resolution logic by hand would be
more code and strictly more fragile for zero benefit. Deploy output is real
files hardlinked from `~/Library/pnpm/store/v3`, not symlinks back into the
live repo, so it doesn't reintroduce a dependency on the repo's own
node_modules.

`pnpm deploy` throws a couple of harmless warnings unrelated to our natives
(failing to link `.bin/tsc` and `.bin/tsserver` — typescript is a devDep,
excluded by `--prod`, so there's nothing at those paths to link to). Not
treated as fatal.

### Kink 3 — pnpm's virtual store nests direct deps inside the *requiring* package's private node_modules, invisible to the bundled entry point

`pnpm deploy`'s output places each of the 3 natives — because they're
direct `dependencies` of `@shyn/engine`, not phantom/transitive deps —
inside `@shyn/engine`'s own private node_modules:
`node_modules/.pnpm/@shyn+engine@.../node_modules/node-llama-cpp`. That's
correct and normal for a package that `require()`s its own deps from its
own file location.

But esbuild inlined all of `@shyn/engine`'s source directly into
`dist/daemon/daemon.mjs`. The "requiring module" for `import
"node-llama-cpp"` is now `daemon.mjs`, sitting directly in `dist/daemon/`.
Node's ancestor-directory module resolution walking up from *that* file's
location passes through `dist/daemon/node_modules` — never through
`@shyn/engine`'s private node_modules three levels down inside `.pnpm`.
Naively copying the deploy output as-is left the natives unreachable
(`Cannot find module 'node-llama-cpp'`/etc. would have been the failure
mode, caught before it got that far — see Kink 4).

**Resolution:** after copying the deploy's node_modules tree, add one
top-level symlink per native pointing into the copied `.pnpm` store, e.g.
`dist/daemon/node_modules/node-llama-cpp -> .pnpm/node-llama-cpp@3.19.0_typescript@5.9.3/node_modules/node-llama-cpp`
— exactly the shape a real top-level pnpm dependency has (compare the
*repo root's own* `node_modules/node-llama-cpp` symlink, which has this
identical shape). The `.pnpm` store directory name is looked up at build
time by prefix-matching `readdirSync(...).find(d => d.startsWith(pkg + "@"))`,
since the exact resolved name includes a peer-hash suffix for
`node-llama-cpp` (`_typescript@5.9.3`) that isn't worth hardcoding.

### Kink 4 — `pnpm deploy`'s virtual store uses absolute symlinks baked to the scratch path

This was the subtle one, and the actual sequence that surfaced it:

1. First build attempt copied the deploy's `node_modules` verbatim
   (`cpSync(..., {recursive: true})`, no dereference — reasoning: pnpm's
   own internal symlinks are usually relative and self-contained, so a
   whole-tree copy should carry the graph over intact).
2. Boot smoke test (repo node_modules still present, so this wasn't even
   the "no repo node_modules" check yet) failed:
   ```
   Error: Cannot find module 'bindings'
   Require stack:
   - dist/daemon/node_modules/.pnpm/better-sqlite3-multiple-ciphers@12.11.1/node_modules/better-sqlite3-multiple-ciphers/lib/database.js
   ```
3. `bindings` (better-sqlite3's own runtime dep) *was* present in the
   copied tree, correctly hoisted to `dist/daemon/node_modules/.pnpm/node_modules/bindings`.
   `readlink` on it revealed why resolution still failed:
   ```
   node_modules/.pnpm/node_modules/bindings -> ~/Code/shyn/dist/.deploy-scratch/node_modules/.pnpm/bindings@1.5.0/node_modules/bindings
   ```
   An **absolute** path, pointing at the scratch deploy directory —
   which the script deletes at the end of the build. Every hoisted
   symlink in a `pnpm deploy` output (checked `bindings`, `chalk`, `ora`,
   `prebuild-install`, `detect-libc`, and others — all absolute) has this
   shape. This differs from a normal `pnpm install`'s virtual store, whose
   symlinks are relative and therefore portable when the whole tree is
   copied elsewhere. `pnpm deploy` apparently doesn't apply that same
   relative-linking behavior to its output.

**Resolution:** after the whole-tree copy, walk `dist/daemon/node_modules`
recursively; for every symlink whose target starts with the scratch dir's
`node_modules` path, rewrite it to a path computed relative to the
*copied* location instead (swap the scratch prefix for the dist prefix,
then `path.relative` from the symlink's own directory). 319 symlinks got
rewritten on the build that produced this doc.

This rewrite pass alone does **not** make `dist/daemon/` relocatable —
see Kink 8, which found two more symlink shapes it misses.

### Kink 8 — the scratch-absolute rewrite doesn't cover every bad symlink; a final integrity sweep is required

An earlier version of this doc claimed the Kink 4 rewrite alone made
`dist/daemon/` "genuinely relocatable." That claim was false, confirmed by
inspecting the actual build output:

- Pruning `@shyn/engine`'s directories (the step right after Kink 4, to drop
  its dead-weight TS source now that esbuild has inlined it) deletes
  `node_modules/@shyn` and the matching `.pnpm/@shyn+engine@...` directory,
  but leaves pnpm's *hoisted* mapping link at
  `node_modules/.pnpm/node_modules/@shyn/engine` untouched — that link now
  points at a target the prune step just deleted. **Dangling.**
- `node_modules/.pnpm/node_modules/@shyn/daemon` (the workspace package's
  own hoisted entry) was never scratch-absolute to begin with — pnpm links
  workspace packages straight at their live source location, e.g.
  `~/Code/shyn/packages/daemon`. The Kink 4 rewrite
  only matches targets starting with the *scratch* `node_modules` path, so
  this one passes through untouched, silently coupling the "self-contained"
  bundle to the exact live checkout path it was built from. **Escapes
  `dist/daemon` outside a live-repo build machine.**

Both are symlink-graph edge cases the targeted rewrite pass wasn't written
to catch, and no amount of extending that one pass to special-case each new
shape found is a substitute for actually checking the invariant.

**Resolution:** after all other symlink surgery (rewrite, prune, and the
top-level native symlinks added afterward), the build runs a final
recursive integrity sweep over the whole `dist/daemon` tree:

1. Walk every symlink under `dist/daemon`.
2. For each, resolve it with `realpathSync`. If that throws (dangling) or
   the resolved real path isn't inside `dist/daemon`'s own real path
   (escaping), delete the symlink.
3. Walk again and assert: every remaining symlink resolves, and every
   resolved target is inside `dist/daemon`. Throw if not — this is what
   actually proves the tree is self-contained, rather than trusting that
   the individual rewrite/prune passes above covered every case.

On the build that produced this revision of the doc, the sweep removed
**2** symlinks (the dangling `@shyn/engine` hoist link and the
live-repo-absolute `@shyn/daemon` hoist link). Confirmed clean afterward:
`find dist/daemon -xtype l` is empty, and resolving every remaining symlink
with `readlink -f` stays under `dist/daemon`'s own real path.

If a future symlink shape slips past both this sweep's removal and its
own assertion, the boot smoke test below is the backstop — a required
runtime path pointing outside the tree would surface as a `Cannot find
module` failure there, not silently pass.

### Kink 5 — dynamic `await import("node-llama-cpp")` stays dynamic under esbuild's `external`

Confirmed directly by grepping the bundle output: `packages/engine/src/embedder.ts`'s
`const { getLlama } = await import("node-llama-cpp");` survives verbatim in
`daemon.mjs` (line ~405 of the bundle) as a real dynamic `import()`, not
rewritten to `require()` or inlined. Marking a package `external` for ESM
output leaves both static and dynamic references to that specifier
untouched — esbuild has no reason to touch what it isn't bundling. This
resolves at runtime via the same node_modules resolution as the static
imports (Kinks 3–4 apply equally to it).

### Kink 6 — node-llama-cpp's prebuilt Metal binary discovery inside the dist tree

Verified directly, independent of the daemon (`SHYN_SKIP_MODEL_DOWNLOAD=1`
means the real embed path never actually exercises this in the pass-
criteria run):

```js
const mod = await import("/…/dist/daemon/node_modules/node-llama-cpp/dist/index.js");
const llama = await mod.getLlama();
console.log(llama.gpu); // -> "metal"
```

Output: `getLlama() OK, gpu: metal`. node-llama-cpp resolves and loads its
own platform package (`@node-llama-cpp/mac-arm64-metal`, hoisted into
`.pnpm/node_modules` by the deploy, only the matching-platform optional
dep gets installed at all) purely from paths inside `dist/daemon/node_modules`
— no dependency on anything outside the copied tree.

### Kink 7 — `pnpm deploy` computes a stray, empty scratch-lookalike path under the wrong directory

While emitting the (harmless — see Kink 2) `.bin/tsc`/`.bin/tsserver`
warnings, `pnpm deploy` also created an empty stub directory at
`packages/daemon/dist/.deploy-scratch/node_modules/.bin/` — a
path-computation quirk in pnpm's bin-linking step that appears to
concatenate the deployed package's own directory with a relative form of
the scratch target instead of using the scratch target's absolute path
directly. Nothing we need lives there. **Resolution:** the build script
`rmSync`s that stray path at the end, and does the same for the top-level
`dist/.deploy-scratch` used for the real deploy output.

## What the build script does NOT need to do (checked, ruled out)

- No other native/binary npm deps beyond the 3 named ones — grepped
  `packages/engine/src` for all non-`node:` imports; only
  `better-sqlite3-multiple-ciphers` and `sqlite-vec` are statically
  imported, `node-llama-cpp` only dynamically.
- Keychain access (`KeychainKeyProvider`) shells out to the macOS `security`
  CLI via `node:child_process`, no native npm dep involved.
- No `worker_threads` — `embed-worker.ts` is a same-thread module despite
  the name, so a single-file bundle covers it; no separate worker entry
  point to bundle.

## Pass-criteria run (transcript)

Repo's `node_modules` (258M) renamed to `node_modules.bak` for the whole
window; a `finally`-style bash `trap` on `EXIT` restored it unconditionally
(covers success, failure, and Ctrl-C). Live launchd daemon
(`com.shyn.daemon`, tsx-based, `~/Library/Application Support/shyn`)
confirmed running with PID **85615** before the window opened, and confirmed
**still running, same PID 85615**, after — it never restarted, so
`KeepAlive` recovery was not exercised on this run.

```
=== bundle size ===
 99M  dist/daemon
 40K  dist/daemon/daemon.mjs
 99M  dist/daemon/node_modules
=== renaming node_modules away ===
SHYN_HOME=/var/folders/49/cv9636rx0qxfm45lc3105mp00000gn/T/tmp.6jYnwmKVsB
daemon pid: 9007
OK: socket appeared at /var/folders/49/cv9636rx0qxfm45lc3105mp00000gn/T/tmp.6jYnwmKVsB/shyn.sock
=== RPC round-trip ===
STATUS_1: {"documents":0,"chunks":0,"vectors":0,"pendingEmbeds":0,"failedEmbeds":0,"modelLoaded":false,"schemaVersion":"3","daemonVersion":"0.1.0","protocolVersion":1,"modelDownloadPct":0,"modelDownloaded":false,"readers":[]}
INGEST: {"docId":1,"chunks":1,"deduped":false}
SEARCH: {"mode":"keyword-only","hits":[{"docId":1,"chunkId":1,"source":"file","uri":"/tmp/dist-bundle-check/meeting.md","title":"meeting","ts":1783008318,"text":"# Standup\n\nDecided to ship the shyn dist bundle spike to five friendly users by August.","score":0.06639343691307453}]}
STATUS_2: {"documents":1,"chunks":1,"vectors":0,"pendingEmbeds":1,"failedEmbeds":0,"modelLoaded":false,"schemaVersion":"3","daemonVersion":"0.1.0","protocolVersion":1,"modelDownloadPct":0,"modelDownloaded":false,"readers":[]}
PASS: ingest + keyword search round-trip OK
=== daemon log ===
shynd listening on /var/folders/49/cv9636rx0qxfm45lc3105mp00000gn/T/tmp.6jYnwmKVsB/shyn.sock
[restore] moving node_modules.bak back to node_modules
[restore] killing test daemon pid 9007
```

Raw ndjson RPC client used `node:net` + `node:readline` only (no repo
deps), sending `{"jsonrpc":"2.0","id":1,"method":...,"params":...}\n` and
parsing the single-line ndjson response — matching the wire format in
`packages/daemon/src/server.ts`/`rpc.ts`, without importing either (the CLI
needs node_modules; this check deliberately doesn't).

`node_modules.bak` confirmed gone and `node_modules` (258M) confirmed
restored after the run. `launchctl list | grep shyn` confirmed PID 85615
throughout.

## Integrity sweep re-check (post-Kink-8 fix)

Re-ran `pnpm build:dist` after adding the Kink 8 sweep/assert:

```
    rewriting deploy-scratch-absolute symlinks -> relative
    rewrote 319 symlinks
    integrity sweep: removed 2 dangling/escaping symlink(s)
done: ~/Code/shyn/dist/daemon
```

Confirmed clean:

```
$ find dist/daemon -xtype l
(empty)

$ DIST_REAL=$(cd dist/daemon && pwd -P)
$ for l in $(find dist/daemon -type l); do
    t=$(readlink -f "$l")
    case "$t" in "$DIST_REAL"/*|"$DIST_REAL") ;; *) echo "ESCAPE: $l -> $t";; esac
  done
(no ESCAPE lines)
```

Re-ran the boot check (bare `node`, no repo `node_modules` rename needed
this time — the sweep only *removes* links, it doesn't add any new runtime
dependency, and the original pass-criteria run above already proved the
tree boots detached from the live repo; this re-check scopes down to
confirming the sweep didn't remove something the daemon actually needs):

```
$ SHYN_HOME=$(mktemp -d) SHYN_TEST_NO_KEYCHAIN=1 SHYN_SKIP_MODEL_DOWNLOAD=1 \
    node ~/Code/shyn/dist/daemon/daemon.mjs
shynd listening on /var/…/tmp.qm9nDTWynw/shyn.sock

$ (raw ndjson status RPC over node:net, no repo deps)
STATUS: {"jsonrpc":"2.0","id":1,"result":{"documents":0,"chunks":0,"vectors":0,
"pendingEmbeds":0,"failedEmbeds":0,"modelLoaded":false,"schemaVersion":"3",
"daemonVersion":"0.1.0","protocolVersion":1,"modelDownloadPct":0,
"modelDownloaded":false,"readers":[]}}
```

Daemon booted and answered `status` cleanly with the two now-removed
symlinks gone, confirming neither was actually load-bearing at runtime —
they were pure debris from the prune/deploy steps, not something the
running daemon ever resolved through.

## Bundle size

| Component | Size |
|---|---|
| `daemon.mjs` | 40K |
| `node_modules` (3 natives + full transitive closure) | 99M |
| **Total `dist/daemon/`** | **99M** |

`node-llama-cpp` and its runtime deps (`cmake-js`, `ipull`, `simple-git`,
the Metal platform package, etc.) dominate this — `better-sqlite3-*` and
`sqlite-vec` are a few MB each. Not further pruned in this spike (e.g.
`cmake-js` is only needed as a from-source build fallback when no prebuilt
binary matches, and could plausibly be dropped for a shipping build) —
noted as a follow-up, not attempted here to keep the spike's diff small and
because pruning risks breaking a legitimate fallback path.

## Follow-ups for later tasks (not done here — out of scope for a spike)

- Investigate trimming `node-llama-cpp`'s from-source build toolchain
  (`cmake-js` and friends) if only the prebuilt-binary path is ever needed
  in shipped builds.
- No Linux/Windows verification — this spike only confirms macOS ARM64
  (Metal). The `@node-llama-cpp/*` optional platform packages should mean
  the same approach generalizes, but that's unverified.
- `scripts/build-dist.mjs`'s `.pnpm` store directory prefix-match
  (`readdirSync(...).find(d => d.startsWith(pkg + "@"))`) assumes exactly
  one resolved version per native across the workspace; would need
  disambiguation logic if that ever stops being true.
