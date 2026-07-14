import type { CharId, ClientId } from "./types";

/**
 * The total order on character identities.
 *
 * Everything in this engine reduces to this function. If it is not a *strict total order* — total,
 * antisymmetric, transitive — then two replicas can order the same two characters differently and
 * the document diverges. It has no other job, and it must never depend on anything but the two ids
 * it is given: not on local state, not on arrival order, not on wall-clock time.
 */

export interface ParsedCharId {
  readonly clientId: ClientId;
  readonly counter: number;
}

const cache = new Map<CharId, ParsedCharId>();

export function parseCharId(id: CharId): ParsedCharId {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;

  // Split on the LAST colon: a clientId is opaque and could, in principle, contain one. The counter
  // never can.
  const separator = id.lastIndexOf(":");
  if (separator <= 0) {
    throw new Error(`malformed CharId: ${id}`);
  }

  const parsed: ParsedCharId = {
    clientId: id.slice(0, separator),
    counter: Number(id.slice(separator + 1)),
  };

  if (!Number.isSafeInteger(parsed.counter) || parsed.counter < 0) {
    throw new Error(`malformed CharId counter: ${id}`);
  }

  // The cache is unbounded by design and bounded in practice: it holds one entry per distinct
  // character id this replica has ever seen, which is the same order as the document itself. A
  // document large enough to make this a memory problem is a document that is already too large.
  cache.set(id, parsed);
  return parsed;
}

export function makeCharId(clientId: ClientId, counter: number): CharId {
  return `${clientId}:${counter}`;
}

/**
 * Compare two character ids. Returns > 0 when `a` is GREATER — i.e. later in the total order.
 *
 * Ordering is by (counter, clientId), both ascending. The counter is a **Lamport clock**, not a
 * per-replica sequence, and that distinction is the load-bearing one. It buys the invariant on which
 * the entire insertion algorithm rests:
 *
 *      ────────────────────────────────────────────────────────────
 *       A character's id is ALWAYS greater than its origin's id.
 *      ────────────────────────────────────────────────────────────
 *
 * Because a replica advances its clock past every character it observes before minting a new one, a
 * character inserted after some origin necessarily carries a higher counter than that origin. Always.
 * Even when the origin was authored by a different replica that had raced far ahead.
 *
 * Why that invariant is everything: the insertion scan (document.ts) skips over any sibling whose id
 * is greater than the incoming character's. If ids grow away from their origin, then skipping a
 * sibling automatically skips that sibling's *entire subtree* — every descendant has an even larger
 * id, so the scan keeps walking. Runs therefore stay contiguous, and two users typing at the same
 * caret produce "helloworld" or "worldhello" (deterministically one of the two, on every replica) and
 * never "hweolrllod".
 *
 * This was got wrong first, and the property test in convergence.test.ts caught it: with per-replica
 * counters and a descending order, the scan could stop *inside* another user's word, shredding two
 * concurrent inserts into each other. The result was perfectly convergent — every replica agreed on
 * the same garbage. Convergence is the floor, not the goal.
 */
export function compareCharIds(a: CharId, b: CharId): number {
  if (a === b) return 0;

  const left = parseCharId(a);
  const right = parseCharId(b);

  if (left.counter !== right.counter) {
    return left.counter - right.counter;
  }

  // Equal counters mean the two characters were authored concurrently — neither replica had seen the
  // other's clock. The clientId tiebreak decides which run goes first. It does not need to be
  // *meaningful*, only *identical on every replica*, which a string comparison is.
  return left.clientId < right.clientId ? -1 : 1;
}

/**
 * The total order used to break ties between registers (block attributes, marks, positions).
 *
 * Lamport clock first — it captures causality, so a value written with knowledge of another always
 * wins over it. Then clientId, purely to break the remaining ties deterministically.
 *
 * Wall-clock time is deliberately absent. Device clocks are wrong: by seconds routinely, by years
 * when a laptop's battery dies. A merge that trusts them is a merge that silently loses a user's
 * work to someone else's broken BIOS.
 */
export function registerWins(
  incoming: { clock: number; clientId: ClientId },
  existing: { clock: number; clientId: ClientId },
): boolean {
  if (incoming.clock !== existing.clock) return incoming.clock > existing.clock;
  if (incoming.clientId === existing.clientId) return true; // same replica, later write
  return incoming.clientId > existing.clientId;
}
