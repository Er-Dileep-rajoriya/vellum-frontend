# Vellum — Frontend

A local-first collaborative document editor. Type with no internet, reload, and your work is still
there — then watch it merge with your team's without losing a character.

**Live:** `https://vellum.paperflow.in` · **API:** `https://api-vellum.paperflow.in` (separate repo)

```
Next.js 16  ·  React 19  ·  TypeScript (strict, zero `any`)  ·  Tailwind 4  ·  shadcn/ui
Auth.js  ·  Dexie (IndexedDB)  ·  a hand-rolled CRDT  ·  deployed on Vercel
```

---

## The three ideas

### 1. The client is the source of truth

A keystroke is applied to an in-memory CRDT and painted **before any promise resolves**. IndexedDB is a
write-behind log, flushed on idle. The server is a replica that happens to be shared.

Nothing on the typing path awaits anything. Turn off your Wi-Fi and the only thing that changes is a chip
in the corner that says *"Saved locally"* instead of *"Saved"* — which is the truth, and is why it does
not say "Saved".

### 2. The server never merges

The backend is a dumb, ordered, idempotent log: it validates, authorizes, dedupes, assigns a gapless
`serverSeq`, persists, broadcasts. **The entire merge algorithm lives in this repository**, so there is no
second implementation that can drift out of sync with this one.

### 3. Everything that changes a document is an operation

A keystroke, a paste, an AI rewrite, a version restore, an undo. All of them go through the same
`OperationFactory` and the same merge engine.

So an AI rewrite is undoable, offline-queued, merged with a collaborator's concurrent typing, versioned
and audited **for free** — there is no code anywhere that special-cases "an edit that came from the AI".
Neither is a special case in the merge engine, and that is precisely why neither can corrupt a live
session.

---

## The merge algorithm

Three strategies, chosen per data shape — **the weakest primitive that cannot lose data**:

| Data | Strategy | Why |
|---|---|---|
| Characters | **RGA** (tombstones, Lamport-minted ids) | Inserts are additive: two concurrent writes must **both** survive |
| Block order | **Fractional index** | Coarse-grained; interleaving is not a hazard *between* blocks |
| Attributes & marks | **LWW register** (per key, HLC) | For "heading level 2 vs 3" there *is* no merge — one must win, and nothing a human typed is lost |

Applying RGA to a boolean is waste. Applying LWW to prose is destruction. The whole design is choosing
correctly between them.

**Explicitly not last-write-wins on content.** Every client converges to byte-identical state, in any
delivery order, with duplicates.

### The invariant everything rests on

> **A character's id is always greater than its origin's id.**

That is what makes "skip a sibling" implicitly skip that sibling's *entire subtree*. I got it wrong the
first time — per-replica counters broke it — and the property test caught it immediately: three replicas
typing at one caret produced `A<<<B012>>>`. Perfectly convergent word salad. **Convergence was never the
bug — every replica agreed on the garbage.** Fixed by minting character ids from the Lamport clock.

That is the entire reason a hand-rolled CRDT is defensible here: it is fuzz-tested, and the fuzz test
found the bug that review did not.

---

## Features

### Offline / sync engine
Change queue · retry queue · dead-letter queue · **exponential backoff with full jitter** · batch sync ·
network detection · sync progress · optimistic updates · partial sync · **sync lock** (in-tab *and*
cross-tab via Web Locks) · duplicate detection · idempotent requests · checkpoints · resume · conflict
queue · background sync.

The failure it is built around is not exotic: **the server commits your batch and the response is lost.**
The client cannot tell that apart from "the request never arrived", so it retries — and the retry must not
double your text. It doesn't, because the idempotency key is derived from the batch *contents* and the
operation ids are stable across retries and reloads. This is what happens every time someone walks into a
lift.

Permanent failures go to a **dead-letter queue** — written in the *same transaction* that removes them
from the outbox, so a crash between the two cannot lose a write. Loss must be loud.

### Collaboration
- Live remote cursors, drawn in an overlay and **never injected into the contenteditable** (that would
  corrupt the offsets the editor reads from the selection, and be clobbered by the next CRDT render).
- Positioned with a DOM `Range`, so they survive line wraps, bidi text and variable-width fonts —
  computing from character widths would be re-implementing the browser's layout engine, badly.
- Anchored to a **character id**, not an offset: otherwise a colleague's caret drifts every time *you* type
  above them.
- **Presence is state, not an event** — the caret is remembered at every layer that could fail to deliver
  it, and resent when delivery becomes possible. Five separate bugs came out of modelling it as an event;
  every one of them presented to the user as *"your colleague is invisible"*.
- **Two tabs are two replicas.** They sync to each other over BroadcastChannel, instantly, with no server
  round-trip for data already on the device — and a Web Lock stops them both syncing at once (a checkpoint
  that moves out of order lets a pull skip a page of operations: silent, permanent loss dressed up as an
  optimisation).

### Editor
Markdown shortcuts · slash commands · keyboard shortcuts · undo/redo · formatting · lists · to-dos ·
quotes · code blocks · dividers · callouts · autosave.

Built on native `beforeinput` with `preventDefault()` on everything: **the browser reports intent, the CRDT
decides what happens, and the DOM is a projection.** One `contenteditable` per block, so the browser's DOM
normalisation is confined to a paragraph instead of the whole document.

> React's `onBeforeInput` is **not** the native event — the synthetic one has no `inputType`, so every
> keystroke silently fell through to `default` and did nothing. The block rendered, the caret blinked, and
> typing was discarded. Hence a native listener.

### Undo / redo
**Local-origin only, and forward-only.** Ctrl+Z reverts *your* edit, never the document's last operation —
otherwise you revert a colleague's sentence while their cursor sits in it. And you cannot un-delete a
character: resurrecting a tombstone would undo a *collaborator's* deletion, so undo re-inserts the text as
new characters.

### Version history
Named + automatic snapshots, timeline, preview, diff, restore, rollback. **Every restore creates a new
version; historical versions are never mutated** (the database refuses `UPDATE`/`DELETE` by trigger).

Restore is a **forward operation**, never `state = version.content` — that is whole-document LWW, and it
annihilates whatever a collaborator typed while you were restoring.

### AI
Rewrite · improve · summarise · translate · grammar · tone · meeting notes · action items · continue
writing · explain · generate title · insights · usage history. Streamed token by token.

Output re-enters as **ordinary CRDT operations**, so an AI rewrite merges with a collaborator's live typing
and is undoable like anything else.

### UX
Dark/light mode · presence indicators · connection status · offline banner · sync progress · toasts ·
skeletons · responsive · keyboard navigable · semantic elements (an `<h2>` really is an `<h2>`, so a screen
reader announces "heading level 2" — a styled `<div>` looks identical and is invisible to assistive tech).

---

## Performance — measured, not asserted

`pnpm bench` runs the real keystroke path — mint the operation, fold it into the CRDT, re-derive the
rendered view — on a 500-block document, and **fails the build** if it regresses.

| | before | after |
|---|---|---|
| keystroke, 500 blocks (p50 / p99) | 19ms / **135ms** | **0.36ms / 1.3ms** |
| 1,000-operation batch | 68ms | **2.7ms** |
| 16,000-operation batch (a week offline) | ~90s | **44ms** |

The "before" column is what the docs used to *claim*. The benchmark was written to defend the claim and
immediately refuted it, finding four algorithmic bugs that review had not:

1. **`render()` rebuilt the entire document on every keystroke.** The React `memo` was doing its job
   perfectly and could not help — the work happened *upstream of React*, in the function producing its
   props. Memoising a component is worthless if you rebuild its props from scratch first.
2. A `TEXT_INSERT` of N characters did N array splices.
3. Every operation copied the whole blocks Map and the target block's char array — quadratic on any batch,
   and batches are exactly where the user is already waiting (first load, reconnect, AI rewrite, restore).
4. Hiding *behind* (3): the character-level idempotence check scanned the whole block to answer *"no"*.

The benchmark asserts **scaling laws** ("a 10× larger document must not cost 10× more per keystroke";
"doubling a batch must not more-than-double its cost"), so it fails on an algorithmic regression rather
than on a busy CI runner.

**Virtualisation:** `content-visibility: auto`, not a JS virtualiser. The browser skips layout and paint
for off-screen blocks — the entire win — while the node **stays in the DOM**, so Ctrl+F, screen readers,
`#anchor` links and Select-All all keep working. A virtualiser that unmounts your text is a permanent
regression for a writing tool.

---

## Project structure

Business logic never lives in a component.

```
src/
├── app/            Next 16 routes (RSC). Thin.
├── components/     UI only. editor/, ai/, versions/, ui/ (shadcn)
├── crdt/           THE MERGE ENGINE. document.ts, replica.ts, factory.ts, identity.ts
├── sync-engine/    State machine, backoff, DLQ, idempotency, cross-tab locks
├── editor/         beforeinput → operations, selection, markdown, history (undo)
├── collaboration/  WebSocket client, presence
├── versioning/     Snapshots, diff (LCS), restore-as-forward-ops
├── services/       DocumentStore — the ONE choke point where state changes
├── database/       Dexie schema (IndexedDB)
└── hooks/ lib/ types/ constants/ validators/
```

**`DocumentStore.#absorb()` is the single choke point.** Observe the clock → ingest into the CRDT →
re-render → notify. Every operation — local, remote, cross-tab, AI, undo, restore — passes through it.
There is no second path that can mutate state.

---

## Local setup

**Prereqs:** Node ≥22.13, pnpm 11, and the backend running (see its repo).

```bash
cp .env.example .env.local
pnpm install
pnpm dev            # :3000
```

Open http://localhost:3000, sign up, and write. **Then turn off your Wi-Fi and keep writing.**

### Environment variables

| Key | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | ✅ | **The only value the browser ever sees.** Baked in at *build* time — changing it needs a rebuild, not a restart. |
| `BACKEND_URL` | ✅ | Server-side only |
| `AUTH_SECRET` | ✅ | `openssl rand -base64 32` |
| `API_JWT_SECRET` | ✅ | **Must byte-match the backend's.** Mints the 15-minute access token. |
| `SERVICE_TOKEN` | ✅ | **Must byte-match the backend's.** The frontend has no database of its own. |
| `API_JWT_ISSUER` / `API_JWT_AUDIENCE` | | `vellum-web` / `vellum-api` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | | Optional — credentials login works without them |

> **Auth tokens never touch `localStorage`.** The Auth.js session cookie is exchanged for a short-lived
> access token held **in memory only**. `localStorage` is readable by any XSS, and a token that outlives the
> page is a token an attacker can steal at leisure.

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server |
| `pnpm test` | 68 unit tests — **incl. the CRDT convergence fuzz test** |
| `pnpm bench` | Typing latency + scaling laws (runs alone — see below) |
| `pnpm test:e2e` | 12 Playwright tests — real sign-in, then **the network is severed** |
| `pnpm lint` / `pnpm typecheck` | Zero warnings, **no `any`** |
| `pnpm build` | Production build |

---

## Testing

| Suite | Count | What it actually proves |
|---|---|---|
| **CRDT convergence (property)** | 500 histories/run | N replicas × random ops × random delivery × duplicates ⇒ **byte-identical** state. *If this fails, the algorithm is wrong and does not ship.* |
| Sync engine | 16 | A **hostile** network: drops responses *after committing*, 429s, permanent failures |
| Editor / versioning / AI | 42 | Backspace-merge, restore-during-concurrent-edit, **AI rewrite doesn't eat a collaborator's sentence** |
| **Benchmark** | 4 | Typing p99, and the scaling laws |
| E2E | 12 | Real sign-in, real Postgres, then **the network is severed mid-session** |

The **benchmark runs alone** (`fileParallelism: false`, its own config). Sharing cores with the fuzz test,
it misreported a 2× batch as 4.6× *and* starved the property test into a timeout — a red build caused
entirely by the timing suite standing next to it. **A measurement that perturbs what it measures is not a
measurement.**

---

## Deployment — Vercel

The frontend is stateless, so it suits serverless. **The backend cannot live here**: the WebSocket relay
needs a long-lived process, and a serverless function is not one. It runs on EC2 under pm2.

### Setup

1. Import the repo in Vercel.
2. **Settings → Environment Variables → Production** — add every variable from the table above.
   `vercel build` pulls env from **Vercel**, not from GitHub, so GitHub secrets alone are not enough.
3. Point the domain at it.

> **`NEXT_PUBLIC_API_URL` is baked into the bundle at build time.** If it is missing you get a green build
> and an app that silently cannot reach the API. CI has a guard that fails the build rather than ship that.

### Google OAuth

**Google Cloud Console → APIs & Services → Credentials → your OAuth client:**

- **Authorized redirect URI:** `https://<your-domain>/api/auth/callback/google`
- **Authorized JavaScript origin:** `https://<your-domain>`

Google matches these **byte for byte** — a trailing slash makes it a different URI, and `http` is not
`https`. `redirect_uri_mismatch` means it compared and found no match. Keep the `localhost:3000` entries so
local dev keeps working.

### After deploying

Set the backend's `CORS_ORIGINS` to exactly your frontend origin. A mismatch presents as *"logged in, but
nothing syncs"* — which reads like a sync bug and is not one.

---

## CI/CD

`.github/workflows/ci.yml`

```
install → guard(NEXT_PUBLIC_API_URL) → lint → typecheck → test → bench → build
                                                                            │
                                                    (main only) → deploy to Vercel
```

- The **convergence fuzz test** gates every deploy. If the merge algorithm is wrong, it does not ship.
- The **benchmark** gates every deploy — on scaling laws, not stopwatch numbers.
- The **`NEXT_PUBLIC_API_URL` guard** fails at the *start*, rather than shipping a bundle that points at
  nowhere. A missing `NEXT_PUBLIC_*` is invisible: the build succeeds, the app deploys, and every API call
  goes to the empty origin.

### Required secrets

| Secret | Where to get it |
|---|---|
| `VERCEL_TOKEN` | vercel.com/account/tokens |
| `VERCEL_ORG_ID` | Vercel → Team Settings → General ("Team ID"), or `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | Vercel → Project → Settings → General ("Project ID") |
| `NEXT_PUBLIC_API_URL` | `https://api-vellum.paperflow.in` |

---

## Further reading

`ARCHITECTURE.md` (C1–C10, merge algorithm, sync state machine) · `DECISIONS.md` (every trade-off with the
alternatives scored — including the interleaving bug, on the record) · `DEPLOYMENT.md` · `TASKS.md` (every
bug the tests caught, and how)
