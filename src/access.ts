// Who may do what.
//
// This file imports NOTHING. Every rule about permission lives here as a pure function over plain
// values, so the whole matrix can be tested exhaustively without a database, a request or a server —
// and so the answer cannot depend on anything the caller happens to have in scope. A permission
// check that reads global state is a permission check nobody can reason about.
//
// ── The four roles ───────────────────────────────────────────────────────────────────────────────
//
// Deliberately four, and deliberately a ladder rather than a set of independent switches. A checkbox
// grid is more expressive and nobody configures it correctly; four rungs can be explained in one
// sentence each and read off a members list at a glance.
//
//   viewer  — can look. Cannot change a cell and cannot start a run. The important half is the
//             second one: running SPENDS MONEY, so "read only" that can still press Run is not read
//             only, it is an unlimited budget with a polite name.
//   member  — the ordinary person. Makes tables, writes columns, runs them, spends.
//   admin   — the above, plus the settings that affect everyone: the API keys, the budgets, the
//             members list. Cannot touch the owner.
//   owner   — the admin who cannot be removed or demoted by anyone else, and the only one who can
//             hand that position on. Exactly one exists.
//
// ── Why "spend" is its own capability ────────────────────────────────────────────────────────────
//
// Every other permission question here is about data, and the worst case is a bad edit somebody can
// undo. Starting a run is the one action whose worst case is a bill, and it is irreversible in the
// way an edit is not — so it is separated from ordinary writing rather than folded into it.

export const ROLES = ["viewer", "member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

/** Rung numbers, so "at least an admin" is a comparison rather than a list of three strings. */
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

/**
 * A role from whatever was stored, never throwing.
 *
 * Falls to `viewer`, the LEAST privileged, because the only ways to get here are a corrupted row or
 * a version that wrote a role this one does not know — and in both cases the safe reading of "I do
 * not understand this" is "then you may not change anything".
 */
export function asRole(v: unknown): Role {
  return isRole(v) ? v : "viewer";
}

export const atLeast = (role: Role, floor: Role): boolean => RANK[role] >= RANK[floor];

/** What one may do to a particular workbook, once role and grants are both taken into account. */
export type Access = "none" | "view" | "edit";

export interface Actor {
  id: number;
  role: Role;
  disabled: boolean;
}

/**
 * Every distinct thing the app can be asked to do, as far as permission is concerned.
 *
 * A closed union rather than free-form strings: a typo in a capability name would otherwise fail
 * open at the one call site that mattered, silently, and only in production.
 */
export type Capability =
  /** Look at tables, rows, runs, costs. */
  | "read"
  /** Change data or structure — cells, columns, tables, views, imports. */
  | "write"
  /** Start a run, enable a schedule, retry a cell. Costs money. */
  | "spend"
  /** Provider keys, models, engines, budgets, the instance's own settings. */
  | "settings"
  /** Invite, remove, or change the role of another person. */
  | "people"
  /** Hand over the instance. Owner only, always. */
  | "own";

/**
 * The matrix, stated once.
 *
 * A disabled account gets nothing at all, checked FIRST — a suspension has to bite immediately and
 * everywhere, including for someone whose session is still valid, or it is not a suspension.
 */
export function can(actor: Actor | null, capability: Capability): boolean {
  if (!actor || actor.disabled) return false;
  switch (capability) {
    case "read":     return true;                          // every signed-in person can look
    case "write":    return atLeast(actor.role, "member");
    case "spend":    return atLeast(actor.role, "member");
    case "settings": return atLeast(actor.role, "admin");
    case "people":   return atLeast(actor.role, "admin");
    case "own":      return actor.role === "owner";
  }
}

/**
 * What this person may do to this particular workbook.
 *
 * Two independent questions, in this order: may they REACH it, and may they CHANGE anything. The
 * grant answers the first; the role answers the second, and the grant can never raise it — a viewer
 * listed with "edit" access is still a viewer, because a grant widens which workbooks a person can
 * see, never what a person is allowed to do. Getting that backwards is how a read-only account ends
 * up able to spend.
 */
export function workbookAccess(
  actor: Actor | null,
  workbook: { restricted: boolean; createdBy?: number | null },
  grant: "view" | "edit" | null,
): Access {
  if (!actor || actor.disabled) return "none";
  // An admin is not kept out of a workbook on their own instance. They can already read the database
  // and rotate the keys; a restriction that "hid" a table from them would be a comforting fiction,
  // and a fiction in a permission system is worse than an honest permission.
  const reaches =
    atLeast(actor.role, "admin") ||
    !workbook.restricted ||
    grant != null ||
    (workbook.createdBy != null && workbook.createdBy === actor.id);
  if (!reaches) return "none";
  // The ceiling their role sets, and then the grant only lowering it.
  const ceiling: Access = atLeast(actor.role, "member") ? "edit" : "view";
  if (ceiling === "view") return "view";
  // A restricted workbook shared read-only stays read-only even for a member. On an unrestricted
  // one there is nothing to lower.
  if (workbook.restricted && grant === "view") return "view";
  return "edit";
}

/**
 * Whether one person may change another's role or account.
 *
 * The rules that keep an instance from being taken over or locked out, in the order they bite:
 *
 *  1. Only admins and the owner get here at all.
 *  2. NOBODY may act on the owner but the owner. Otherwise a second admin can demote the first, and
 *     an instance has no settled answer to who is in charge.
 *  3. Nobody may change their own role — including the owner. Self-demotion by the only owner is how
 *     an instance ends up with nobody who can add anyone, and it always happens by accident.
 *  4. An admin may not promote anyone to owner. That is a transfer, and it goes through the owner.
 */
export function mayManage(
  actor: Actor | null,
  target: { id: number; role: Role },
  nextRole?: Role,
): { ok: true } | { ok: false; because: string } {
  if (!can(actor, "people")) return { ok: false, because: "Only an admin can change who is on this instance." };
  const me = actor as Actor;
  if (target.role === "owner" && me.role !== "owner") {
    return { ok: false, because: "Only the owner can change the owner's account." };
  }
  if (target.id === me.id && nextRole != null && nextRole !== me.role) {
    return { ok: false, because: "You cannot change your own role. Ask another admin, or the owner." };
  }
  if (nextRole === "owner" && me.role !== "owner") {
    return { ok: false, because: "Only the owner can hand the instance to someone else." };
  }
  return { ok: true };
}

/**
 * Whether an account may be removed or suspended.
 *
 * Separate from `mayManage` because of the last rule: the owner cannot be removed at all, not even
 * by themselves. An instance with no owner has no one who can appoint one.
 */
export function mayRemove(actor: Actor | null, target: { id: number; role: Role }):
  { ok: true } | { ok: false; because: string } {
  if (!can(actor, "people")) return { ok: false, because: "Only an admin can remove someone." };
  if (target.role === "owner") {
    return { ok: false, because: "The owner cannot be removed. Hand the instance to someone else first." };
  }
  if (target.id === (actor as Actor).id) {
    return { ok: false, because: "You cannot remove your own account. Ask another admin." };
  }
  return { ok: true };
}

// ── Which capability a request needs ─────────────────────────────────────────────────────────────
//
// One table from URL path to capability, rather than a check written into each of the ~170 handlers.
// The reason is not brevity: a per-handler check is a list you can be one line short of, and the
// missing line is invisible — the route works, for everyone. Here, anything not named falls to the
// default for its method, so a route added tomorrow is gated the day it is written.

/** Read methods. Everything else changes something. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Path prefixes that need more than their method implies, longest match first.
 *
 * `spend` is listed for the run routes because they are POSTs that cost money, and `settings` for
 * the ones that reach the provider account. The GET side of a settings route is deliberately NOT
 * here: seeing that a key is configured is not the same as being able to change or read it, and the
 * routes themselves never return a key's value.
 *
 * EVERY PREFIX BELOW NAMES A ROUTE THAT EXISTS. This table used to list `/api/keys`, `/api/engines`
 * and `/api/connections`, none of which the router has ever served — three entries that read like
 * the credentials were covered while the routes that actually hold them (`/api/secrets`,
 * `/api/providers`, `/api/llm-providers`, `/api/search`, `/api/mcp`) matched nothing and fell to the
 * `write` default, i.e. to any member. A rule for an imaginary route is worse than no rule, because
 * it is the reason nobody looks again. When adding one, grep the router for the prefix first.
 */
const RULES: Array<{ prefix: string; method?: "read" | "write"; need: Capability }> = [
  { prefix: "/api/people",     need: "people" },
  { prefix: "/api/invites",    need: "people" },
  { prefix: "/api/auth",       method: "write", need: "settings" },
  { prefix: "/api/settings",   method: "write", need: "settings" },
  { prefix: "/api/models",     method: "write", need: "settings" },
  // The credential stores. Writing here overwrites or deletes the keys every run pays with.
  { prefix: "/api/secrets",    method: "write", need: "settings" },
  { prefix: "/api/providers",  method: "write", need: "settings" },
  { prefix: "/api/llm-providers", method: "write", need: "settings" },
  // The search screen: the chosen engine, its per-call price and its key. Instance-wide, and the
  // per-call price is what every budget is enforced against.
  { prefix: "/api/search",     method: "write", need: "settings" },
  // A stdio MCP server is a COMMAND THIS MACHINE WILL SPAWN. Registering one is the most dangerous
  // write in the app; it is not an ordinary edit and must never sit behind the `write` default.
  { prefix: "/api/mcp",        method: "write", need: "settings" },
  // Emptying the cache spends money — the next run pays again for every answer thrown away — and
  // the retention setting applies to everyone.
  { prefix: "/api/cache",      method: "write", need: "settings" },
  { prefix: "/api/runs",       method: "write", need: "spend" },
  { prefix: "/api/schedules",  method: "write", need: "spend" },
];

/** How strict a capability is, only for breaking a tie between two rules of the same length. */
const STRICTNESS: Record<Capability, number> = {
  read: 0, write: 1, spend: 1, settings: 2, people: 2, own: 3,
};

/**
 * A path that ends a run costs nothing and must stay reachable to anyone who could start one.
 *
 * Anchored to the run routes rather than matched on any path at all. It is tested BEFORE the table,
 * so an unanchored version would be a way past every rule below it: a future
 * `POST /api/mcp/servers/:id/stop` would have been decided by this line, not by the `settings` rule
 * it sits under.
 */
const STOPPING = /^\/api\/runs\/[^/]+\/(cancel|pause|stop)$/;

/**
 * The capability a request needs, from its method and path alone.
 *
 * Deliberately ignores the body. A rule that depended on what was posted would be a rule the caller
 * could influence.
 */
export function neededFor(method: string, path: string): Capability {
  const reading = READ_METHODS.has(method.toUpperCase());
  /**
   * Stopping a run needs no more than being able to see it.
   *
   * Not "spend" — obviously — but not "write" either, and that distinction is the whole point: a
   * viewer classified as write-forbidden could WATCH a run burning money and not be allowed to stop
   * it. Cancelling destroys nothing, changes no cell, and its worst case is a job that has to be
   * started again. Its best case is somebody catching a mistake before the bill.
   */
  if (!reading && STOPPING.test(path)) return "read";
  const hit = RULES
    .filter((r) => path === r.prefix || path.startsWith(`${r.prefix}/`))
    .filter((r) => r.method == null || (r.method === "read") === reading)
    // Longest prefix wins, so /api/runs/:id/cancel is decided by the more specific rule if one
    // exists — and on a tie the STRICTER capability wins, so which of two equal-length rules was
    // typed first can never decide the answer.
    .sort((a, b) => b.prefix.length - a.prefix.length || STRICTNESS[b.need] - STRICTNESS[a.need])[0];
  if (hit) return hit.need;
  // Starting a run is a POST to a SHEET, not to /api/runs — the scope belongs to the table. That is
  // the one path where the method alone would get it wrong, so it is named rather than inferred.
  if (!reading && /^\/api\/sheets\/[^/]+\/runs$/.test(path)) return "spend";
  // A workbook's spending ceiling bounds what EVERYONE on the instance can spend in that project, so
  // setting it is a settings-grade decision, not an ordinary edit — the roles list already puts
  // "budgets" on the admin rung. Named here rather than in the prefix table for the same reason the
  // run route above is: the table matches literal prefixes and cannot name a path with an id in the
  // middle of it.
  if (!reading && /^\/api\/workbooks\/[^/]+\/budget$/.test(path)) return "settings";
  // An unnamed write falls to `write`, NOT to `settings`, and the choice is deliberate rather than
  // lazy. Nearly every route in this app is a member doing their job — cells, columns, tables,
  // views, imports, folders, relations, sources, scripts — so a `settings` default would lock the
  // ordinary person out of the product and be relaxed back within a day, one exception at a time,
  // which ends with a table full of holes nobody can audit. The safety this default cannot give is
  // bought above instead: every settings-grade prefix is NAMED, and the note on RULES says how to
  // keep it that way.
  return reading ? "read" : "write";
}
