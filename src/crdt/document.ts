import { compareCharIds, makeCharId, parseCharId, registerWins } from "./identity";
import type { Operation } from "./operations";
import type {
  AttrValue,
  Block,
  BlockId,
  BlockType,
  Char,
  CharId,
  DocumentState,
  MarkType,
  MarkValue,
  Register,
  RenderedBlock,
} from "./types";

/**
 * The merge engine.
 *
 * `apply(state, op)` is a pure function. Given the same *set* of operations — in any order, with any
 * duplicates — it produces byte-identical state on every replica. That is the entire contract, and
 * it is what the property test in `convergence.test.ts` actually verifies. The prose in this file is
 * the argument for why it holds; the fuzz test is the proof. If they ever disagree, the fuzz test is
 * right.
 *
 * Three merge strategies, one per data shape (DECISIONS.md D-002):
 *
 *   text        → RGA sequence CRDT   (inserts are additive: concurrent writes must BOTH survive)
 *   block order → fractional index    (coarse-grained; interleaving is not a hazard between blocks)
 *   scalars     → LWW register + HLC  (no merge exists for "heading level 2 vs 3"; one must win)
 *
 * Applying RGA to a boolean is waste. Applying LWW to prose is destruction. The whole design is
 * choosing correctly between them.
 */

export function emptyDocument(): DocumentState {
  return { blocks: new Map(), serverSeq: 0n };
}

/** Why an operation could not be applied yet — i.e. which dependency is missing. */
export type MissingDependency = { kind: "block"; id: BlockId } | { kind: "char"; id: CharId };

export type ApplyResult =
  | { status: "applied"; state: DocumentState }
  /**
   * The operation is well-formed but references something this replica has not seen yet — an insert
   * anchored to a character whose own insert is still in flight. It is NOT dropped and NOT applied:
   * it is buffered until its dependency lands. (ARCHITECTURE.md §6.6.)
   *
   * This is what makes delivery order irrelevant, which in turn is what lets the WebSocket path and
   * the HTTP-pull path race each other harmlessly.
   */
  | { status: "pending"; state: DocumentState; missing: MissingDependency };

/**
 * A batch of operations, applied into ONE copy of the state.
 *
 * The problem it solves. `apply()` was persistent per *operation*: every single operation cloned the
 * whole blocks Map and the target block's entire character array. That is fine for one keystroke and
 * catastrophic for a batch — replaying N operations into a block copied the array N times, at growing
 * length, which is O(N²). A benchmark measured it: doubling a batch made it 5× slower. The cases that
 * hit it are the ones that matter most — hydrating a document from its log, a client catching up after
 * a week offline, an AI rewrite, a version restore — i.e. precisely when the user is already waiting.
 *
 * The fix is not to abandon immutability but to move the copy boundary. A Draft copies the Map once,
 * clones each *touched* block once, and mutates those clones freely for the rest of the batch. What
 * escapes at `commit()` is a fresh state whose untouched blocks are shared by reference with the old
 * one — the same persistent guarantee, with the copies amortised across the batch instead of paid per
 * operation.
 *
 * Three invariants keep it honest, and all three are load-bearing:
 *
 *   1. **Only clones are mutated.** A Block from the base state is never written to; `own()` clones it
 *      first and every later write in the batch goes to that clone. An old `DocumentState` handed out
 *      earlier — to a snapshot, to the render cache, to a version preview — must remain exactly what it
 *      was, or the render cache (keyed on Block identity) would serve a projection of a block that has
 *      since changed underneath it.
 *   2. **Characters are still replaced, never edited.** Char objects are shared with the previous
 *      state; a delete writes a NEW `{...char, deleted: true}` into the owned array rather than setting
 *      the flag on the shared object. Only the array itself is mutable.
 *   3. **Validate fully, then mutate.** Every operation checks its dependencies (does the block exist?
 *      do all the characters exist?) BEFORE it touches the draft, so an operation that turns out to be
 *      `pending` leaves no partial write behind. Without this, a buffered operation would corrupt the
 *      state it was too early to be applied to — a bug that would only appear under out-of-order
 *      delivery, which is to say only in production.
 *
 * A Draft is single-use: create one, apply a batch, commit, discard. Reusing one after `commit()` would
 * mutate a state someone else is now holding, which is invariant 1 violated by the back door.
 */
export class Draft {
  readonly #blocks: Map<BlockId, Block>;
  /** Blocks cloned during THIS batch, and therefore safe to mutate in place. */
  readonly #owned = new Map<BlockId, MutableBlock>();
  /** Character-id lookup per block, built lazily. Batch-scoped — see `hasChar`. */
  readonly #charIds = new Map<BlockId, Set<CharId>>();

  constructor(base: DocumentState) {
    this.#blocks = new Map(base.blocks);
  }

  /** Read-only lookup — may return a block shared with the base state. Never write to it. */
  read(id: BlockId): Block | undefined {
    return this.#blocks.get(id);
  }

  /**
   * Does this character already exist in the block? O(1), and that matters more than it looks.
   *
   * Every TEXT_INSERT asks this — it is the character-level idempotence check, which catches an
   * operation replayed under a *different* operationId (a client bug, a malicious retry) that the
   * Replica's dedup by operationId cannot see. The honest answer is almost always "no", which is
   * exactly why it was so expensive: a linear scan that finds nothing has to look at every character
   * in the block, on every insert, so appending N characters to a block costs O(N²).
   *
   * That was the second quadratic in this file, and it hid behind the first. After the batch draft
   * fixed the copies, per-operation cost was still doubling as the batch doubled — 7µs/op at 1k
   * operations, 46µs/op at 8k — because of this one lookup.
   *
   * The index is built lazily, once per block per batch (O(block length) — the same walk the first
   * scan would have done anyway), then answers in O(1) forever after. It is kept alive only for the
   * duration of the batch, which is what keeps it from becoming a second source of truth that can
   * drift from `chars`.
   */
  hasChar(blockId: BlockId, charId: CharId): boolean {
    return this.#index(blockId)?.has(charId) ?? false;
  }

  #index(blockId: BlockId): Set<CharId> | undefined {
    const existing = this.#charIds.get(blockId);
    if (existing !== undefined) return existing;

    const block = this.#blocks.get(blockId);
    if (block === undefined) return undefined;

    const ids = new Set<CharId>();
    for (const char of block.chars) ids.add(char.id);

    this.#charIds.set(blockId, ids);
    return ids;
  }

  /** Register characters this batch has just inserted, so the index stays in step with `chars`. */
  noteChars(blockId: BlockId, ids: readonly CharId[]): void {
    const index = this.#charIds.get(blockId);
    if (index === undefined) return; // never built for this block; it will be built with them present

    for (const id of ids) index.add(id);
  }

  /** The block, cloned at most once per batch, safe to mutate. */
  own(id: BlockId): MutableBlock | undefined {
    const existing = this.#owned.get(id);
    if (existing !== undefined) return existing;

    const block = this.#blocks.get(id);
    if (block === undefined) return undefined;

    const clone: MutableBlock = {
      ...block,
      attrs: new Map(block.attrs),
      chars: [...block.chars],
    };

    this.#owned.set(id, clone);
    this.#blocks.set(id, clone);
    return clone;
  }

  insert(block: MutableBlock): void {
    this.#owned.set(block.id, block);
    this.#blocks.set(block.id, block);
  }

  commit(base: DocumentState): DocumentState {
    return { blocks: this.#blocks, serverSeq: base.serverSeq };
  }
}

/** A Block the Draft owns. Same shape, without the `readonly`s — see Draft's invariant 1. */
interface MutableBlock {
  id: BlockId;
  type: Register<BlockType>;
  fracIndex: Register<string>;
  attrs: Map<string, Register<AttrValue>>;
  chars: Char[];
  deleted: boolean;
}

/** The result of folding one operation into a draft. */
export type DraftResult =
  | { status: "applied" }
  | { status: "pending"; missing: MissingDependency };

/**
 * Fold one operation into a draft.
 *
 * **This does not deduplicate.** Duplicate delivery — the same operation arriving over the WebSocket
 * and again in an HTTP pull — is filtered by `Replica`, which is the only boundary operations enter
 * through. Do not call this on an ingress path directly; go through `Replica.ingest`, or a re-delivered
 * TEXT_INSERT will insert its characters a second time.
 *
 * The idempotence *guarantee* is unchanged, and the property test still asserts it — it is enforced one
 * layer out, where the duplicate actually arrives, rather than by carrying a forever-growing set of
 * seen ids inside the document's value. (See the note on `DocumentState`.)
 *
 * Every case below is individually convergent under reordering; that is what the fuzz test checks, and
 * it is a stronger property than idempotence.
 */
export function applyTo(draft: Draft, op: Operation): DraftResult {
  switch (op.operationType) {
    case "BLOCK_INSERT":
      return applyBlockInsert(draft, op);
    case "BLOCK_REMOVE":
      return applyBlockRemove(draft, op);
    case "BLOCK_MOVE":
      return applyBlockMove(draft, op);
    case "BLOCK_SET_ATTRS":
      return applyBlockSetAttrs(draft, op);
    case "TEXT_INSERT":
      return applyTextInsert(draft, op);
    case "TEXT_DELETE":
      return applyTextDelete(draft, op);
    case "MARK_SET":
      return applyMarkSet(draft, op);
  }
}

/**
 * Fold a single operation into a state, purely.
 *
 * The one-operation convenience over `Draft` — it pays for a full Map copy, so it is for callers with
 * exactly one operation, not for loops. `Replica.ingest` shares one Draft across the whole batch, which
 * is the entire point of the Draft existing.
 */
export function apply(state: DocumentState, op: Operation): ApplyResult {
  const draft = new Draft(state);
  const result = applyTo(draft, op);

  return result.status === "applied"
    ? { status: "applied", state: draft.commit(state) }
    : { status: "pending", state, missing: result.missing };
}

const APPLIED: DraftResult = { status: "applied" };

function register<T>(value: T, op: Operation): Register<T> {
  return { value, clock: op.logicalClock, clientId: op.clientId };
}

// ─── blocks ──────────────────────────────────────────────────────────────────────────────────────

function applyBlockInsert(
  draft: Draft,
  op: Extract<Operation, { operationType: "BLOCK_INSERT" }>,
): DraftResult {
  const { blockId, blockType, fracIndex, attrs } = op.payload;

  if (draft.read(blockId) !== undefined) {
    // Two replicas independently creating the same blockId is not something a correct client does —
    // block ids are ULIDs. But an operation log is replayed, re-pulled, and re-delivered constantly,
    // so "insert an existing block" must be a well-defined no-op rather than a corruption. Treating
    // it as a fresh insert would discard the block's accumulated text.
    return APPLIED;
  }

  const attrRegisters = new Map<string, Register<AttrValue>>();
  for (const [key, value] of Object.entries(attrs)) {
    attrRegisters.set(key, register(value, op));
  }

  draft.insert({
    id: blockId,
    type: register(blockType, op),
    fracIndex: register(fracIndex, op),
    attrs: attrRegisters,
    chars: [],
    deleted: false,
  });

  return APPLIED;
}

function applyBlockRemove(
  draft: Draft,
  op: Extract<Operation, { operationType: "BLOCK_REMOVE" }>,
): DraftResult {
  const block = draft.own(op.payload.blockId);
  if (block === undefined) {
    return { status: "pending", missing: { kind: "block", id: op.payload.blockId } };
  }

  // A tombstone, not a deletion. Concurrent text inserts into this block still apply (they will land
  // on a deleted block and be invisible, which is correct); crucially, if the block is later restored
  // by a version rollback, the text those inserts carried is still there. Hard-deleting would make
  // "delete a block while your colleague is typing in it" silently destroy what they typed.
  block.deleted = true;
  return APPLIED;
}

function applyBlockMove(
  draft: Draft,
  op: Extract<Operation, { operationType: "BLOCK_MOVE" }>,
): DraftResult {
  const current = draft.read(op.payload.blockId);
  if (current === undefined) {
    return { status: "pending", missing: { kind: "block", id: op.payload.blockId } };
  }

  // LWW on position. Two users concurrently dragging the SAME block to different places: one wins,
  // deterministically. This loses a *position*, never *content* — an explicit, documented trade
  // (D-004). A move-tree CRDT would preserve both intents at a complexity cost far beyond what the
  // frequency of the event justifies.
  const next = register(op.payload.fracIndex, op);
  if (!registerWins(next, current.fracIndex)) return APPLIED;

  // Read first, own only once the operation is known to change something. A losing move must not
  // clone the block — it would churn the block's identity and, with it, invalidate the render cache
  // for a block whose rendered output is provably unchanged.
  const block = draft.own(op.payload.blockId)!;
  block.fracIndex = next;
  return APPLIED;
}

function applyBlockSetAttrs(
  draft: Draft,
  op: Extract<Operation, { operationType: "BLOCK_SET_ATTRS" }>,
): DraftResult {
  const block = draft.own(op.payload.blockId);
  if (block === undefined) {
    return { status: "pending", missing: { kind: "block", id: op.payload.blockId } };
  }

  // Per-KEY LWW, not per-object. This is the difference between a merge and a clobber: if Alice sets
  // `checked: true` while Bob sets `language: "rust"` on the same code block, both survive. Merging
  // the attrs object wholesale would let the later operation erase the earlier one's unrelated key —
  // data loss that the user would experience as "the app randomly forgets my settings".
  for (const [key, value] of Object.entries(op.payload.attrs)) {
    const existing = block.attrs.get(key);
    const next = register(value, op);
    if (existing === undefined || registerWins(next, existing)) {
      block.attrs.set(key, next);
    }
  }

  if (op.payload.blockType !== undefined) {
    const next = register(op.payload.blockType, op);
    if (registerWins(next, block.type)) block.type = next;
  }

  return APPLIED;
}

// ─── text: the RGA ───────────────────────────────────────────────────────────────────────────────

function applyTextInsert(
  draft: Draft,
  op: Extract<Operation, { operationType: "TEXT_INSERT" }>,
): DraftResult {
  const { blockId, charId, originLeft, value } = op.payload;

  const current = draft.read(blockId);
  if (current === undefined) {
    return { status: "pending", missing: { kind: "block", id: blockId } };
  }

  // Causal readiness. The origin must exist before we can position this run relative to it. If it
  // does not, this operation arrived before the one that created its anchor — buffer it, do not drop
  // it, and do not guess. Guessing is how a replica ends up with text in a different order than
  // everyone else and no way to ever notice.
  if (originLeft !== null && findCharIndex(current.chars, originLeft) === -1) {
    return { status: "pending", missing: { kind: "char", id: originLeft } };
  }

  // Idempotence at the character level, independent of the operationId check. Belt and braces: an
  // operation replayed under a *different* id (a client bug, a malicious retry) must still not
  // duplicate text.
  //
  // O(1) via the draft's index, not a scan. The answer here is nearly always "no", and a linear scan
  // that finds nothing still reads the whole block — which made appending N characters O(N²). This one
  // lookup was the difference between a 1,000-operation catch-up costing 7ms and 8,000 costing 372ms.
  if (draft.hasChar(blockId, charId)) {
    return APPLIED;
  }

  // An empty insert must be a well-defined no-op, not a crash. This client cannot author one (the
  // factory throws — the server's validator requires at least one character), but a peer, a replayed
  // log, or another tab could still hand us one, and `apply` must stay total against anything it is
  // given. The per-character loop this replaced tolerated it by accident, simply by never iterating;
  // reading `run[0]` of an empty run turned that silent tolerance into a TypeError that took the
  // editor down. Total functions, not lucky ones.
  if (value.length === 0) {
    return APPLIED;
  }

  const { clientId, counter } = parseCharId(charId);

  /**
   * Build the run, then splice it in ONCE.
   *
   * The first version spliced each character separately — N splices of an array of length n, which is
   * O(N·n). A benchmark caught it: doubling a batch made it 5.5× slower, which is the signature of a
   * quadratic. It is invisible on the ten operations a unit test uses, and it is forty seconds on the
   * five thousand a real reconnect delivers.
   *
   * A single splice is *correct*, not just faster, and the argument is short. Character `i+1` is
   * anchored to character `i`, and its id is one greater. When character `i` was placed, the scan
   * stopped at the first existing character `X` with `X.id < char_i.id`. Since
   * `char_{i+1}.id > char_i.id > X.id`, the scan for `i+1` stops immediately at `X` too — so `i+1`
   * always lands directly after `i`. The whole run is therefore contiguous, and its position is fully
   * determined by where the FIRST character goes.
   *
   * That is the same anti-interleaving property from identity.ts, viewed from the other side: a run
   * cannot be split by an existing character, which is exactly why it can be inserted in one piece.
   */
  const run: Char[] = [];
  let origin = originLeft;

  for (let i = 0; i < value.length; i += 1) {
    const id = makeCharId(clientId, counter + i);
    run.push({
      id,
      value: value[i]!,
      originLeft: origin,
      deleted: false,
      marks: new Map(),
    });
    origin = id;
  }

  const first = run[0];
  if (first === undefined) return APPLIED;

  // Own the block only now — after every dependency check has passed, so a `pending` operation can
  // never leave a half-written draft behind (Draft invariant 3).
  const block = draft.own(blockId)!;
  const index = findInsertIndex(block.chars, first);
  block.chars.splice(index, 0, ...run);

  // Keep the id index in step with `chars`. If it drifts, the idempotence check above starts lying —
  // it would either re-insert a character it already holds, or silently drop one it does not.
  draft.noteChars(
    blockId,
    run.map((char) => char.id),
  );

  return APPLIED;
}

/**
 * Where does `incoming` go?
 *
 * Start immediately right of its origin, then walk right past every character whose id is GREATER
 * than the incoming one's. Stop at the first character whose id is smaller. Insert there.
 *
 * That is the entire algorithm. Its correctness rests on the invariant established in identity.ts —
 * **a character's id is always greater than its origin's id**, because ids are minted from a Lamport
 * clock advanced past everything observed. Two consequences, and they are the whole proof:
 *
 *   1. **Skipping a sibling skips its whole subtree, for free.** If we walk past some character `x`
 *      (because `x.id > incoming.id`), then every character anchored to `x` — and everything anchored
 *      to those — has an id greater than `x.id`, hence greater than `incoming.id`, so the scan keeps
 *      walking through all of them without needing to know they are related. This is what keeps a
 *      typed word contiguous: you cannot land in the middle of someone else's run, because their run
 *      is a subtree and subtrees are skipped atomically.
 *
 *   2. **Every replica computes the same index.** The scan starts at the origin (which every replica
 *      has — guaranteed by the causal-readiness check above, which is why buffering is not optional)
 *      and its stopping condition reads nothing but `compareCharIds`, a strict total order over ids
 *      that depends on no local state, no arrival order, and no clock. Same start, same rule, same
 *      data ⇒ same index. By induction on the number of operations: convergence.
 *
 * Getting this backwards — descending ids, or per-replica counters that break the invariant — still
 * converges, and still produces "hweolrllod" from two people typing at once. The fuzz test is what
 * distinguishes those two worlds, and it is why it exists.
 */
function findInsertIndex(chars: readonly Char[], incoming: Char): number {
  const originIndex =
    incoming.originLeft === null ? -1 : findCharIndex(chars, incoming.originLeft);

  let index = originIndex + 1;

  while (index < chars.length) {
    const candidate = chars[index]!;
    if (compareCharIds(candidate.id, incoming.id) > 0) {
      index += 1;
      continue;
    }
    break;
  }

  return index;
}

/**
 * Linear scan — **backwards**.
 *
 * A Map<CharId, index> would be O(1) lookup and would be invalidated by every splice, so maintaining
 * it costs O(n) anyway. The data structure stays a plain array: it can be reasoned about, snapshotted,
 * and fuzz-tested, and a rope or skip list here would buy an optimisation nobody needs at the price of
 * subtle, rare, unreproducible bugs.
 *
 * The direction is the optimisation, and it is free. Almost every lookup is for a character at or near
 * the END of the block: text is typed by appending, so the anchor of the next insert is the character
 * just placed, and the anchor of a backspace is the character just typed. Scanning from index 0 makes
 * that O(n) — and since it runs once per operation, replaying N appended characters into one block is
 * O(N²). A benchmark measured it: doubling the batch made it 5× slower, which is exactly the shape of
 * a quadratic and exactly what a client catching up after a week offline would run into.
 *
 * Scanning from the end makes the common case O(1) with an identical worst case (an anchor at the very
 * start of a long paragraph, which is a cursor position, not a loop). No new data structure, no new
 * invariant to maintain, no new way to be wrong.
 */
function findCharIndex(chars: readonly Char[], id: CharId): number {
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    if (chars[i]!.id === id) return i;
  }
  return -1;
}

function applyTextDelete(
  draft: Draft,
  op: Extract<Operation, { operationType: "TEXT_DELETE" }>,
): DraftResult {
  const current = draft.read(op.payload.blockId);
  if (current === undefined) {
    return { status: "pending", missing: { kind: "block", id: op.payload.blockId } };
  }

  /**
   * A delete for a character we have not seen is NOT buffered — it is applied as a no-op.
   *
   * This looks like a bug and is the opposite of one. Delete is a *set union* of tombstoned ids:
   * commutative, idempotent, and order-independent. If the insert arrives later, the reconciliation
   * happens then... except it cannot, because we would have forgotten the delete.
   *
   * So we buffer instead — the delete waits for its target. The alternative (dropping it) would mean
   * a character deleted on one replica and alive on another: permanent, silent divergence. The
   * alternative (applying it blind, remembering the id in a "graveyard" set) also works and is what
   * a production system would eventually need for compaction — but buffering is strictly simpler and
   * is correct as long as inserts are never garbage-collected before their deletes, which the
   * snapshot watermark guarantees (ARCHITECTURE.md §8).
   */
  // Every target must exist BEFORE anything is written (Draft invariant 3). The indices are kept, so
  // the write below is a direct assignment per target rather than a second scan of the whole block —
  // the difference between O(targets) and O(block length) on a delete.
  const indices: number[] = [];
  for (const charId of op.payload.charIds) {
    const index = findCharIndex(current.chars, charId);
    if (index === -1) {
      return { status: "pending", missing: { kind: "char", id: charId } };
    }
    indices.push(index);
  }

  const block = draft.own(op.payload.blockId)!;
  for (const index of indices) {
    const char = block.chars[index]!;
    // A NEW Char, not a mutation of the existing one: the old state still holds that object, and
    // flipping its flag would retroactively delete the character from a snapshot taken before this
    // operation existed (Draft invariant 2).
    if (!char.deleted) block.chars[index] = { ...char, deleted: true };
  }

  return APPLIED;
}

function applyMarkSet(
  draft: Draft,
  op: Extract<Operation, { operationType: "MARK_SET" }>,
): DraftResult {
  const current = draft.read(op.payload.blockId);
  if (current === undefined) {
    return { status: "pending", missing: { kind: "block", id: op.payload.blockId } };
  }

  const indices: number[] = [];
  for (const charId of op.payload.charIds) {
    const index = findCharIndex(current.chars, charId);
    if (index === -1) {
      return { status: "pending", missing: { kind: "char", id: charId } };
    }
    indices.push(index);
  }

  /**
   * Marks are stored per (character, markType) as an LWW register — NOT as a range with anchors.
   *
   * Ranges are the obvious model and they are a trap: a range anchored to offsets breaks the moment
   * someone inserts text inside it concurrently, and a range anchored to characters needs its own
   * split/merge/repair logic on every concurrent edit. That is the entire class of mark-anchoring
   * bugs that rich-text CRDT integrations are famous for, and this design simply does not have it.
   *
   * The cost is storing a mark map per character. It is sparse (absent = default), and the alternative
   * is a category of bug that appears only under concurrency and is nearly impossible to reproduce.
   */
  const next: Register<MarkValue> = register(op.payload.value, op);
  const block = draft.own(op.payload.blockId)!;

  for (const index of indices) {
    const char = block.chars[index]!;

    const existing = char.marks.get(op.payload.mark);
    if (existing !== undefined && !registerWins(next, existing)) continue;

    const marks = new Map(char.marks);
    marks.set(op.payload.mark, next);
    block.chars[index] = { ...char, marks };
  }

  return APPLIED;
}

// ─── rendering ───────────────────────────────────────────────────────────────────────────────────

/**
 * Materialise the document for the editor.
 *
 * Tombstones are filtered here and ONLY here: they must remain in the CRDT (they are insertion
 * anchors), and they must never reach the UI. Blocks are sorted by (fracIndex, blockId) — the
 * blockId tiebreak makes the order total, so two blocks that somehow land on the same fractional
 * index still render in the same order on every replica rather than in Map-insertion order, which
 * would differ per replica and would be a divergence the CRDT itself could not see.
 */
export function render(state: DocumentState): RenderedBlock[] {
  const blocks: RenderedBlock[] = [];

  for (const block of state.blocks.values()) {
    if (block.deleted) continue;
    blocks.push(renderBlock(block));
  }

  blocks.sort((a, b) => {
    if (a.fracIndex !== b.fracIndex) return a.fracIndex < b.fracIndex ? -1 : 1;
    // The blockId tiebreak is what makes the order TOTAL. Two blocks can legitimately land on the
    // same fractional index (two replicas inserting into the same gap while offline), and without a
    // tiebreak they would render in Map-iteration order — which differs per replica depending on
    // delivery order. That is a divergence the CRDT itself cannot see, because the state is identical
    // and only the *view* differs. This one comparison closes it.
    return a.id < b.id ? -1 : 1;
  });

  return blocks;
}

/**
 * The per-block projection cache — the reason typing is O(1) in document size.
 *
 * `apply()` is persistent: it rebuilds the block it touched and reuses every other block *by
 * reference*. So a block's identity is a perfect, free content hash — if the object is the same
 * object, its rendered projection cannot have changed. A WeakMap keyed on it is therefore always
 * correct, and it lets `render()` skip the 499 blocks a keystroke did not touch.
 *
 * Without this, `render()` walked every character of every block on every keystroke. A benchmark
 * caught it: p99 was 135ms against an 8ms budget, and a 10× larger document cost 6.5× more *per
 * keystroke* — the exact linear degradation the React memo was supposed to prevent. The memo was
 * doing its job; it just could not help, because the work was happening upstream of React, in the
 * function producing its props. Memoising the component is worthless if you rebuild its props from
 * scratch first.
 *
 * A WeakMap rather than a Map because the keys are superseded block objects: they must be collectable
 * the moment the CRDT drops its last reference, or this cache becomes a leak that grows with every
 * keystroke of the session.
 *
 * The stable identity is a second, quieter win: unchanged blocks now hand React the *same*
 * `RenderedBlock` object across renders, so `memo`'s shallow prop comparison short-circuits on
 * reference equality instead of failing on a fresh-but-identical object.
 */
const renderCache = new WeakMap<Block, RenderedBlock>();

function renderBlock(block: Block): RenderedBlock {
  const cached = renderCache.get(block);
  if (cached !== undefined) return cached;

  const text: string[] = [];
  const charIds: CharId[] = [];
  const marks: Record<MarkType, MarkValue>[] = [];

  for (const char of block.chars) {
    if (char.deleted) continue;
    text.push(char.value);
    charIds.push(char.id);
    marks.push(Object.fromEntries(char.marks.entries().map(([k, v]) => [k, v.value])) as Record<
      MarkType,
      MarkValue
    >);
  }

  const attrs: Record<string, AttrValue> = {};
  for (const [key, value] of block.attrs) {
    attrs[key] = value.value;
  }

  const rendered: RenderedBlock = {
    id: block.id,
    type: block.type.value,
    fracIndex: block.fracIndex.value,
    attrs,
    text: text.join(""),
    charIds,
    marks,
  };

  renderCache.set(block, rendered);
  return rendered;
}

/**
 * A canonical, order-independent serialisation of the FULL state — tombstones included.
 *
 * This is the equality function the convergence test asserts on, and it deliberately does not use
 * `render()`: two replicas could render identically while holding different tombstones or different
 * register clocks, and that divergence would surface later, as a *future* operation lands on
 * different underlying state. Comparing the rendered text would let that through. Comparing this
 * does not.
 */
export function serialize(state: DocumentState): string {
  const blocks = [...state.blocks.values()]
    .map((block) => ({
      id: block.id,
      type: block.type.value,
      typeClock: [block.type.clock, block.type.clientId],
      frac: block.fracIndex.value,
      fracClock: [block.fracIndex.clock, block.fracIndex.clientId],
      deleted: block.deleted,
      attrs: [...block.attrs.entries()]
        .map(([key, reg]) => [key, reg.value, reg.clock, reg.clientId] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      chars: block.chars.map((char) => ({
        id: char.id,
        v: char.value,
        o: char.originLeft,
        d: char.deleted,
        m: [...char.marks.entries()]
          .map(([mark, reg]) => [mark, reg.value, reg.clock, reg.clientId] as const)
          .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      })),
    }))
    // Sorted by id, so Map insertion order — which differs per replica depending on delivery order —
    // cannot leak into the comparison and produce a false divergence.
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  return JSON.stringify(blocks);
}

/** The plain-text projection, for diffing, AI context, and search. */
export function toPlainText(state: DocumentState): string {
  return render(state)
    .map((block) => block.text)
    .join("\n");
}
