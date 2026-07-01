# Design Notes — forward-compatibility constraints (not yet implemented)

Ideas we are deliberately *not* building yet, but whose possibility the architecture MUST preserve. Treat these as
constraints when designing any phase: do not build something that forecloses them.

---

## 1. Every agent is a seat that a human could play

The engine treats the AI-DM, every NPC, and every player as the same kind of thing: a **`presence` occupying a
seat** on one shared op bus + journal ("everything is a client"). A logical consequence we explicitly want to keep
alive: **any AI-driven seat (the DM, any NPC) could instead be driven by a human** — and vice versa. A human could
puppet an NPC; the AI could fill an absent player's seat. This is the same autonomous↔human "slider" as the DM seat,
generalized to every actor.

**Invariants to preserve (cheap to hold, expensive to retrofit):**
1. Every actor is a `presence` with a `seat` (`dm` | `npc` | `player` | `spectator`) **and a `controller`**
   (`ai` | `<clientId>`). The `agent` component carries `controller` (default `ai`).
2. "Produce a beat for seat X" is dispatched through an **indirection** (a responder lookup), not a hardcoded call to
   the LLM. For now it always resolves to the LLM agent runner; later it may resolve to "wait for the human who holds
   seat X." The orchestrator must not assume an NPC is always AI.
3. An LLM agent's output and a human's input both produce the **same** `event:dialogue` / ops. Nothing downstream
   (journal, reconciler, memory, other agents) may care who authored a beat.

As long as these hold, human-playable agents are an *addition*, not a rewrite.

## 2. A floor / turn system (DM-adjustable on the fly)

NPCs talking over each other — and people talking over each other — is the same problem: **who has the floor?**
Today's "routing" (pick one responder) is a degenerate, implicit 1-beat floor decision. The general form we want
eventually:

- A **`floor` state** (a small component on a `world-state`/`scene` entity or a dedicated entity):
  `{ order: [presenceId...], current: presenceId|null, mode }`.
- **Modes:** `free` (anyone may act), `round-robin`, `initiative` (combat, stat-ordered), `spotlight` (DM grants the
  floor to one actor). Start with one simple fixed mode; make mode + order **mutable by the DM on the fly via ops**
  (e.g. `set floor ...`), because the DM is the director.
- Acting is gated by the floor: an actor (AI or human) may emit a beat only when it holds the floor, or when the DM
  grants an interjection. The current router becomes "grant the floor to NPC X for one beat."
- Client UX: show whose turn it is; gate/queue input for actors who don't hold the floor.

**Invariant to preserve:** routing/“who responds” should be expressed as a *floor decision*, so swapping the simple
P2 router for a real floor manager is a substitution, not a teardown.

---

*Status: both are post-P2. P2 honors invariant 1 (the `agent.controller` field + responder indirection) and treats
routing as a floor-of-one so #2 slots in later.*
