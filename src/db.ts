// SQLite via Node's built-in node:sqlite — no native build step, which matters on Windows where
// better-sqlite3 needs Visual Studio Build Tools and breaks on every Node major bump.
//
// ── Why the key design looks like this ────────────────────────────────────────────────────────
// A TEXT uuid primary key on `cells` plus TEXT uuid foreign keys was measured at 317k rows x 6
// columns: a 1GB database, and import throughput decaying from 3,870 rows/sec to 880 rows/sec as the
// table grew, because every cell carried ~144 bytes of uuid text duplicated into four separate
// indexes.
//
// So: `rows` and `columns` use INTEGER primary keys, and `cells` is
//     PRIMARY KEY (row_id, column_id) WITHOUT ROWID
// which stores cells CLUSTERED BY ROW — physically in the order the grid reads them. A window of
// 200 rows is one contiguous primary-key range scan, there is no secondary index to maintain on the
// read path, and a cell's identity costs 12 bytes instead of 144.
//
// A cell therefore has no standalone id column: its public id is derived as `${rowId}:${columnId}`.
//
// Shape: `cells` is CURRENT STATE (what the grid reads), `cell_attempts` is IMMUTABLE HISTORY (what
// the detail drawer reads). The grid must never aggregate over attempts.

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH, ensureDirs } from "./paths.ts";

ensureDirs();
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// page_size MUST come first and MUST come before any table exists. SQLite refuses to change it once
// WAL is on or the file has content, so issuing it after `journal_mode` makes it a permanent no-op
// and every database created runs at the 4096 default. Measured on a real 1.5GB file.
// An existing database keeps its current page size; only a VACUUM under journal_mode=DELETE can
// change that, which is not worth doing to a user's data on boot.
db.exec("PRAGMA page_size = 8192;");

// WAL lets the grid's reads run concurrently with the writer; NORMAL sync is safe under WAL and keeps
// batched imports fast; busy_timeout rides out brief contention. The larger page size and cache cut
// B-tree depth and page churn materially on a multi-million-row cells table.
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA cache_size = -65536;      -- 64MB page cache
  PRAGMA temp_store = MEMORY;
`);
try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* another connection holds it — harmless */ }

export function dbCheckpoint(): void {
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* best-effort */ }
}

// SQLite's LOWER() folds ASCII only: lower('ŠKODA') is 'Škoda' while JS gives 'škoda'. Column keys and
// dedupe keys are WRITTEN from JS, so they must be READ back with the same function or a non-ASCII
// company can never match its own row.
db.function("jslower", { deterministic: true }, (s: unknown) => (s == null ? null : String(s).toLowerCase()));

db.exec(`
  -- ───────────────────────────────────────────────────────────── workbooks → tables
  -- Few of these, and their ids are public URL identifiers, so uuids are fine here.

  -- Folders. A plain tree over workbooks and loose tables, which is the shape every file browser
  -- has and therefore the one nobody has to be taught. Deliberately NOT a tagging system: a thing
  -- is in exactly one place, so "where did I put it" always has one answer.
  CREATE TABLE IF NOT EXISTS folders (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
    starred    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  );

  CREATE INDEX IF NOT EXISTS ix_folders_parent ON folders(parent_id);

  CREATE TABLE IF NOT EXISTS workbooks (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    archived      INTEGER NOT NULL DEFAULT 0,
    -- Templates carry schema + prompts + scripts + views, never data and never credentials.
    is_template   INTEGER NOT NULL DEFAULT 0,
    -- Read-only public share. NULL = not shared.
    public_token  TEXT UNIQUE,
    budget_usd    REAL,
    settings_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS sheets (
    id            TEXT PRIMARY KEY,
    workbook_id   TEXT REFERENCES workbooks(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    position      INTEGER NOT NULL DEFAULT 0,
    -- What the rows ARE. The three values live in SHEET_KINDS in types.ts and nowhere else.
    -- This comment used to claim the field drove default columns and enrichment suggestions while
    -- nothing read it at all; it now seeds the table wizard's dedupe key and decides which column
    -- templates suit a table.
    kind          TEXT NOT NULL DEFAULT 'generic',
    -- The column that NAMES a row: the record view's header, the first field a lookup offers, and
    -- the send column's back-reference when one is set. RESOLVED on read rather than trusted --
    -- see sheetSelect in store.ts. A column delete is soft and undoable, so a pointer at a deleted
    -- column reads as null and comes back when the delete does.
    primary_column_id INTEGER,
    -- The saved view this table opens on. NULL means all rows, which is what every table did before
    -- anything read this. Resolved on read for the same reason as the pointer above.
    default_view_id   INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    archived      INTEGER NOT NULL DEFAULT 0,
    -- Soft delete: a destructive action on a million-row table needs to be recoverable.
    deleted_at    TEXT,
    budget_usd    REAL,
    settings_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS ix_sheets_workbook ON sheets(workbook_id, position);

  -- ───────────────────────────────────────────────────────────── saved views
  -- A view owns everything about how a table is presented AND what a scoped run targets. Storing the
  -- filter here (rather than only in client state) is what lets "run the visible rows" resolve
  -- server-side by predicate instead of shipping a million row ids to the browser.

  CREATE TABLE IF NOT EXISTS views (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id     TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    position     INTEGER NOT NULL DEFAULT 0,
    filter_json  TEXT NOT NULL DEFAULT '{"conj":"and","children":[]}',
    sorts_json   TEXT NOT NULL DEFAULT '[]',   -- [{columnId, dir}] — multi-key, server-side
    columns_json TEXT NOT NULL DEFAULT '{}',   -- {order:[], hidden:[], widths:{}, frozen:n}
    group_by     INTEGER,
    row_height   TEXT NOT NULL DEFAULT 'default',
    search       TEXT,
    is_shared    INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ix_views_sheet ON views(sheet_id, position);

  -- ───────────────────────────────────────────────────────────── relations
  -- Joins between tables. Both sides normalize through a generated "key" hook, because matching
  -- "Acme Inc." to "https://www.acme.com/" is exactly the rule Claude should write once.

  CREATE TABLE IF NOT EXISTS relations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    workbook_id     TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
    from_sheet_id   TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    from_column_id  INTEGER NOT NULL,
    to_sheet_id     TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    to_column_id    INTEGER NOT NULL,
    key_script_id   INTEGER,                   -- generated normalizer, applied to BOTH sides
    cardinality     TEXT NOT NULL DEFAULT 'many_to_one',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ix_relations_from ON relations(from_sheet_id);
  CREATE INDEX IF NOT EXISTS ix_relations_to   ON relations(to_sheet_id);

  -- The normalized match key for both sides of a relation, materialized.
  --
  -- Why a table rather than an index on the cells themselves: matching is on the NORMALIZED value,
  -- not the raw one — "https://www.Acme.com/", "acme.com" and "ACME.com" are one company, and a
  -- relation that cannot see that is a relation that matches almost nothing on real data. That
  -- normalizer is normalizeKey() in dedupe.ts, a JavaScript function registered into SQLite, and an
  -- expression index cannot be built on it: SQLite would need the function present at every open,
  -- and the value type it needs is per-relation rather than a constant.
  --
  -- So the keys are computed once and stored. That turns a lookup over the million-row table from a
  -- full scan per row into an index seek, and it makes the cross-sheet stale cascade expressible as
  -- a join: when a row on one side changes, the rows on the other side that read it are the ones
  -- sharing its key, which is exactly what this index answers.
  --
  -- Rebuilt wholesale per relation, and maintained per row as key cells are written. Both go through
  -- the same SQL so the two cannot drift.
  CREATE TABLE IF NOT EXISTS relation_keys (
    relation_id INTEGER NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
    side        TEXT    NOT NULL,              -- 'from' | 'to'
    row_id      INTEGER NOT NULL REFERENCES rows(id) ON DELETE CASCADE,
    key         TEXT    NOT NULL,
    PRIMARY KEY (relation_id, side, row_id)
  ) WITHOUT ROWID;

  -- The seek that every match performs: given a relation, a side, and a key, which rows hold it.
  CREATE INDEX IF NOT EXISTS ix_relation_keys_match ON relation_keys(relation_id, side, key);

  -- ───────────────────────────────────────────────────────────── columns

  CREATE TABLE IF NOT EXISTS columns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id        TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    key             TEXT NOT NULL,                     -- normalized; what {{refs}} bind to
    position        INTEGER NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'static',    -- static|script|http|mcp|ai|agent
    value_type      TEXT NOT NULL DEFAULT 'text',
    enum_values     TEXT,
    json_schema     TEXT,

    prompt          TEXT,
    prompt_version  INTEGER NOT NULL DEFAULT 1,

    model           TEXT NOT NULL DEFAULT 'auto',
    max_turns       INTEGER NOT NULL DEFAULT 4,
    max_budget_usd  REAL    NOT NULL DEFAULT 0.05,
    timeout_ms      INTEGER NOT NULL DEFAULT 180000,
    allowed_tools   TEXT NOT NULL DEFAULT '[]',        -- JSON array of EXACT tool names
    mcp_servers     TEXT NOT NULL DEFAULT '[]',

    condition_script_id INTEGER,                       -- generated predicate: the cost gate
    transform_script_id INTEGER,
    accept_script_id    INTEGER,                       -- waterfall: "is this result good enough?"
    map_script_id       INTEGER,                       -- HTTP/MCP response -> typed value
    http_config     TEXT,

    -- Presentation + formatting. "format" carries the type's descriptor: currency code, decimals,
    -- date pattern, true/false labels.
    description     TEXT,
    format          TEXT,
    width           INTEGER,
    frozen          INTEGER NOT NULL DEFAULT 0,

    -- Relation/lookup columns read through a relation rather than holding their own value.
    relation_id     INTEGER,
    lookup_column_id INTEGER,
    rollup          TEXT,                              -- count|sum|min|max|avg|concat

    -- Ordered provider list for a waterfall column, tried until "accept" passes.
    waterfall_json  TEXT,

    -- ── multi-value outputs ──────────────────────────────────────────────────────────────────
    -- A derived column projecting a path out of another column's JSON, e.g. "contact.email".
    -- Extraction is deterministic, so expanding a JSON object into six sibling columns costs
    -- nothing and re-running the source updates all six.
    source_column_id INTEGER,
    json_path        TEXT,

    -- RESERVED, NOT YET READ BY ANYTHING. These were written for a per-item RUN lane that does not
    -- exist: a repo-wide grep finds fan_out only in this declaration and its migration entry. The
    -- cap is NOT a live guard against a 10,000-element array becoming 10,000 runs. Whoever builds
    -- that lane must add that guard themselves rather than assume this one covers it.
    --
    -- The only item cap that IS enforced today is SendConfig.cap (src/writeTarget.ts), and it bounds
    -- how many ROWS one list writes into another table, not how many runs it starts.
    fan_out          TEXT,                              -- NULL | 'per_item'
    fan_out_cap      INTEGER NOT NULL DEFAULT 50,

    -- How multiple values collapse back into a single cell, when they are not being written out.
    aggregate        TEXT,                              -- join|first|count|min|max|sum

    -- Where a run's results are written when they belong in another table rather than this cell.
    -- {targetSheetId, mapping:{targetColumnId: path}, keyScriptId, onConflict, backRefColumnId}
    write_target     TEXT,

    -- Auto-run this column when a new row arrives.
    auto_run        INTEGER NOT NULL DEFAULT 0,

    -- The ceiling on ONE auto-run firing, in dollars. NULL means no ceiling.
    --
    -- Its own number rather than a reuse of sheets.budget_usd, because that one counts every run
    -- ever made against the sheet. Sharing it would let a month of unattended auto-runs sit on the
    -- manual run you are trying to do right now, and the fix would be raising a limit you set for
    -- a different reason.
    auto_run_budget_usd REAL,

    -- Cached completion snapshot for the header progress bar.
    stats_json      TEXT,

    on_upstream_empty TEXT NOT NULL DEFAULT 'skip',
    on_upstream_error TEXT NOT NULL DEFAULT 'block',
    auto_recompute    INTEGER NOT NULL DEFAULT 0,

    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (sheet_id, key)
  );
  CREATE INDEX IF NOT EXISTS ix_columns_sheet ON columns(sheet_id, position);

  -- Edge list, rebuilt on every prompt/script/condition save. A column can depend on another via its
  -- PROMPT, its TRANSFORM, or its CONDITION — all three produce edges here, which is why run
  -- conditions are cycle-checked exactly like prompts.
  CREATE TABLE IF NOT EXISTS column_deps (
    sheet_id   TEXT    NOT NULL REFERENCES sheets(id)  ON DELETE CASCADE,
    column_id  INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    depends_on INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    via        TEXT    NOT NULL,                       -- prompt|transform|condition|http
    PRIMARY KEY (column_id, depends_on, via)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ix_deps_producer ON column_deps(depends_on);

  -- ───────────────────────────────────────────────────────────── generated scripts

  CREATE TABLE IF NOT EXISTS scripts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    column_id   INTEGER NOT NULL,
    hook        TEXT NOT NULL,                         -- condition|transform|accept|map|key|score|filter
    runtime     TEXT NOT NULL DEFAULT 'js',
    intent      TEXT NOT NULL,                         -- the plain-English request
    code        TEXT NOT NULL,
    hash        TEXT NOT NULL,                         -- sha256(code); approval is pinned to this
    version     INTEGER NOT NULL DEFAULT 1,
    approved_at TEXT,                                  -- NULL = never runs
    refs        TEXT NOT NULL DEFAULT '[]',
    rationale   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ix_scripts_column ON scripts(column_id, hook, version DESC);

  -- ───────────────────────────────────────────────────────────── rows

  CREATE TABLE IF NOT EXISTS rows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id   TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    dedupe_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- The grid windows by POSITION RANGE, never OFFSET: at row 900,000 an OFFSET walks 900k index
  -- entries, while a range scan seeks straight there.
  CREATE UNIQUE INDEX IF NOT EXISTS ux_rows_sheet_pos ON rows(sheet_id, position);

  -- Rows arriving from outside. See src/sources/webhook.ts for why the token is the whole security
  -- story and what the mapping is protecting against.
  CREATE TABLE IF NOT EXISTS webhook_sources (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id     TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    token        TEXT NOT NULL UNIQUE,
    enabled      INTEGER NOT NULL DEFAULT 1,
    -- targetColumnId -> dotted path into the posted body. What is not in here is not stored.
    mapping_json TEXT NOT NULL DEFAULT '{}',
    key_path     TEXT,
    items_path   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_at      TEXT,
    received     INTEGER NOT NULL DEFAULT 0,
    rejected     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS ix_webhook_sources_sheet ON webhook_sources(sheet_id);

  -- Recent deliveries, successes AND failures. A webhook that silently drops a payload is
  -- indistinguishable from one nobody ever called, which is the single most common thing to have to
  -- debug about an integration.
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id    INTEGER NOT NULL REFERENCES webhook_sources(id) ON DELETE CASCADE,
    at           TEXT NOT NULL,
    ok           INTEGER NOT NULL,
    rows_written INTEGER NOT NULL DEFAULT 0,
    note         TEXT,
    body         TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_webhook_deliveries_src ON webhook_deliveries(source_id, id DESC);
  CREATE INDEX IF NOT EXISTS ix_rows_dedupe ON rows(sheet_id, dedupe_key);

  -- ───────────────────────────────────────────────────────────── cells (current state)
  -- Clustered by (row_id, column_id): physically stored in the order the grid reads.

  CREATE TABLE IF NOT EXISTS cells (
    row_id      INTEGER NOT NULL REFERENCES rows(id)    ON DELETE CASCADE,
    column_id   INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,

    status      TEXT NOT NULL DEFAULT 'empty',
    value_json  TEXT,
    value_text  TEXT,
    confidence  TEXT,
    source_url  TEXT,
    note        TEXT,

    error_type  TEXT,
    error_msg   TEXT,

    stale       INTEGER NOT NULL DEFAULT 0,
    pinned      INTEGER NOT NULL DEFAULT 0,
    input_hash  TEXT,
    rev         INTEGER NOT NULL DEFAULT 0,

    run_id      TEXT,
    attempt     INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL,
    tokens_in   INTEGER,
    tokens_out  INTEGER,
    tokens_cache_read   INTEGER,
    tokens_cache_create INTEGER,
    duration_ms INTEGER,
    updated_at  TEXT,

    PRIMARY KEY (row_id, column_id)
  ) WITHOUT ROWID;

  -- Only for column-scoped queries ("every error in this column"). The grid's row-window read needs
  -- no secondary index at all — it rides the primary key.
  CREATE INDEX IF NOT EXISTS ix_cells_col_status ON cells(column_id, status);

  -- The stale count is asked for beside the status histogram on every column-stats refresh, but
  -- the stale flag is not in the index above, so that query was doing one primary-key lookup per index
  -- entry: measured 933ms against the histogram's 57ms on a 1,000,000-cell column — 16x, and enough
  -- on its own to blow the 250ms budget the stats reader is calibrated against. A partial index is
  -- almost free here because the stale set is tiny by construction (a cell is stale only until its
  -- column is re-run), which is the same reason ix_jobs_leased is partial.
  CREATE INDEX IF NOT EXISTS ix_cells_col_stale ON cells(column_id) WHERE stale = 1;
  -- Hand-typed cells, per column. Partial for the same reason the stale index is: they are a small
  -- minority, so the index stays tiny and counting them is a range scan over just them rather than a
  -- table fetch per row of the column. The run confirmation needs this number to say honestly how
  -- many cells a run will replace, and folding it into the status histogram above would have cost
  -- that query its index-only plan — 57ms to roughly 900ms on a million-cell column.
  CREATE INDEX IF NOT EXISTS ix_cells_col_pinned ON cells(column_id) WHERE pinned = 1;

  -- ───────────────────────────────────────────────────────────── attempts (immutable provenance)
  --
  -- NOTE: row_id and column_id here are PLAIN INTEGERS WITH NO FOREIGN KEY. PRAGMA foreign_key_list(cell_attempts)
  -- returns nothing, so the ON DELETE CASCADE that cleans up cells does NOT reach this table and
  -- deleting a row orphans its attempts permanently. That is deliberate — provenance outliving the
  -- row it describes is useful — but it has two consequences a reader must know:
  --   1. anything aggregating cell_attempts (a cost report, a storage figure) has to filter to rows
  --      that still exist, or it will count deleted work;
  --   2. an attempt is kept for ATTEMPT_RETENTION_DAYS and then swept — see pruneCellAttempts,
  --      which runs once per boot from recoverAfterRestart. Without that this table only ever grew:
  --      one row per paid call, each carrying the whole rendered prompt, and 93.5% of the rows in
  --      the real database described cells that had already been deleted.
  -- SQLite cannot add a foreign key by ALTER, so changing this means rebuilding the table.

  CREATE TABLE IF NOT EXISTS cell_attempts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    row_id          INTEGER NOT NULL,
    column_id       INTEGER NOT NULL,
    run_id          TEXT,
    attempt         INTEGER NOT NULL,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    status          TEXT NOT NULL,

    model           TEXT,
    system_prompt   TEXT,
    rendered_prompt TEXT,
    options_json    TEXT,                              -- secrets redacted before write
    output_schema   TEXT,
    script_hash     TEXT,

    -- The model's own finish-tool envelope and how many turns it took to get there. Both were
    -- declared here from the start and written by nothing until recordOutcome started filling them;
    -- session_id and transcript_path sat beside them describing a transcript file this app has never
    -- produced, and were dropped rather than left as a promise nothing can keep. See DROPS.
    raw_result      TEXT,
    num_turns       INTEGER,
    cost_usd        REAL,
    tokens_in INTEGER, tokens_out INTEGER,
    tokens_cache_read INTEGER, tokens_cache_create INTEGER,
    duration_ms     INTEGER,
    error_type      TEXT, error_msg TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_attempts_cell ON cell_attempts(row_id, column_id, attempt DESC);
  -- The retention sweep asks "what is older than N days" and must not answer it by reading the
  -- largest history table in the file. A million-row AI column is a million rows here.
  CREATE INDEX IF NOT EXISTS ix_attempts_age ON cell_attempts(started_at);

  -- What has been spent, rolled up per day.
  --
  -- The obvious version of usage reporting is a GROUP BY over cell_attempts. That is correct and it
  -- does not survive the product: an AI column over the million-row table is a million attempts, and
  -- a workspace page that scans them on every view gets slower every week the workspace is used.
  -- Reporting is read far more often than written, so the work goes on the write — each attempt
  -- increments one row here, and a workspace-wide answer reads tens of rows instead of millions.
  --
  -- sheet_id is denormalized rather than joined through columns, so a workbook or workspace total
  -- needs no join at all. The model column is empty rather than NULL for lanes that have none: an HTTP column
  -- spends real money and belongs in the totals, and NULL in a primary key would give every one of
  -- its attempts a row of its own.
  CREATE TABLE IF NOT EXISTS usage_daily (
    day          TEXT    NOT NULL,              -- UTC, from the attempt's own timestamp
    sheet_id     TEXT    NOT NULL,
    column_id    INTEGER NOT NULL,
    lane         TEXT    NOT NULL,              -- the column kind that spent it
    model        TEXT    NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    errors       INTEGER NOT NULL DEFAULT 0,
    cost_usd     REAL    NOT NULL DEFAULT 0,
    tokens_in    INTEGER NOT NULL DEFAULT 0,
    tokens_out   INTEGER NOT NULL DEFAULT 0,
    cache_read   INTEGER NOT NULL DEFAULT 0,
    cache_create INTEGER NOT NULL DEFAULT 0,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    -- Third-party units burned, in the provider's own currency: credits, enrichments, lookups.
    -- Kept beside the dollar figure rather than converted into it, because the two answer different
    -- questions -- "am I about to run out of credits" is not "what did this cost".
    units        REAL    NOT NULL DEFAULT 0,
    unit         TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (day, sheet_id, column_id, lane, model)
  ) WITHOUT ROWID;

  -- Every report filters by sheet and by date, in that order.
  CREATE INDEX IF NOT EXISTS ix_usage_scope ON usage_daily(sheet_id, day);

  -- Runs that start themselves on a clock. See schedules.ts for why each guard is there.
  -- (No backticks in this block: the whole DDL is a JS template literal and one would close it.)
  CREATE TABLE IF NOT EXISTS schedules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id     TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    name         TEXT NOT NULL DEFAULT '',
    cadence_json TEXT NOT NULL,             -- interval | daily | weekly
    scope_json   TEXT NOT NULL DEFAULT '{}',-- a RunScope: which columns, which rows
    -- OFF on creation, always. Filling in a form must not start spending money.
    enabled      INTEGER NOT NULL DEFAULT 0,
    force        INTEGER NOT NULL DEFAULT 0,
    budget_usd   REAL,
    next_at      TEXT NOT NULL,             -- UTC
    last_at      TEXT,
    last_run_id  TEXT,
    last_status  TEXT NOT NULL DEFAULT '',
    runs         INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- The ticker's only query: enabled and due, oldest first.
  CREATE INDEX IF NOT EXISTS ix_schedules_due ON schedules(enabled, next_at);

  -- Columns kept to be used again. See columnTemplates.ts: references are stored BY NAME so a
  -- template can land on a different table, and a carried script arrives UNAPPROVED.
  -- (No backticks in this block: the whole DDL is a JS template literal and one would close it.)
  CREATE TABLE IF NOT EXISTS column_templates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    category      TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL,
    value_type    TEXT NOT NULL,
    body_json     TEXT NOT NULL,               -- the definition, references written as names
    scripts_json  TEXT NOT NULL DEFAULT '[]',
    requires_json TEXT NOT NULL DEFAULT '[]',  -- column names its references need to find
    uses          INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ix_coltpl_use ON column_templates(uses DESC, updated_at DESC);
  CREATE INDEX IF NOT EXISTS ix_attempts_run  ON cell_attempts(run_id);

  -- Every tool call an agent made. A denied call is the prompt-injection tripwire.
  CREATE TABLE IF NOT EXISTS cell_tool_calls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL REFERENCES cell_attempts(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    tool_name  TEXT NOT NULL,
    input_json TEXT,
    allowed    INTEGER NOT NULL DEFAULT 1,
    is_error   INTEGER NOT NULL DEFAULT 0,
    at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ix_toolcalls_attempt ON cell_tool_calls(attempt_id, seq);

  -- ───────────────────────────────────────────────────────────── undo

  -- One reversible operation per row, per sheet. "undone" is a flag rather than a cursor column so
  -- the state survives a restart with no extra bookkeeping: everything with undone=0 is behind you,
  -- everything with undone=1 is ahead of you, and the boundary is wherever those two meet.
  -- (No backticks in this block: the whole DDL is a JS template literal and one would close it.)
  CREATE TABLE IF NOT EXISTS undo_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id   TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    label      TEXT NOT NULL,
    payload    TEXT NOT NULL,
    undone     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Both reads are "newest not-undone" and "oldest undone" for one sheet, which this covers.
  CREATE INDEX IF NOT EXISTS ix_undo_sheet ON undo_log(sheet_id, undone, id);

  -- ───────────────────────────────────────────────────────── restore points (before a run)
  --
  -- WHY THIS IS NOT THE UNDO LOG. undo_log deliberately excludes runs, and the reason at the top of
  -- undo.ts still stands: a run that spent $40 cannot be un-spent, so offering "Undo" over one would
  -- imply a refund that is not coming. But the VALUES a run replaced are ordinary data, and losing a
  -- column of answers to a prompt that turned out worse is the one remaining way to destroy something
  -- expensive with a single click. So the values are recoverable and the charge is not, and the two
  -- are kept apart so neither pretends to be the other.
  --
  -- Taken as ONE "INSERT ... SELECT" off the run's own resolved row set, so a million-cell snapshot is
  -- a single statement rather than a million round trips — the same reason the run itself enqueues in
  -- batches instead of building an array.
  --
  -- Only cells with something to lose are copied ("status <> 'empty'"), and a run that would replace
  -- nothing gets no restore point at all. A first run over an empty column has nothing to put back,
  -- and an entry offering to restore emptiness is noise in the one list that has to stay trustworthy.

  CREATE TABLE IF NOT EXISTS run_snapshots (
    run_id      TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    sheet_id    TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    -- What the run was about to do, in the words the confirm dialog used. Read back weeks later, "Run
    -- "Industry" on 40,000 rows" is the only thing that distinguishes one restore point from another.
    label       TEXT NOT NULL,
    cell_count  INTEGER NOT NULL,
    -- The columns the snapshot covers, as a JSON array. Stored here rather than re-derived from the
    -- run's scope, because a scope is a DESCRIPTION and re-resolving it weeks later can answer
    -- differently — a view whose filter has been edited, a column since deleted. Restore has to clear
    -- exactly the columns it saved, not whatever that description means today.
    column_ids  TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    -- Set when the values were put back. The snapshot is KEPT afterwards rather than consumed: a
    -- restore is itself a bulk overwrite, and the honest thing is to leave the record of what was
    -- restored from, not to delete the evidence at the moment it is most likely to be questioned.
    restored_at TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_run_snapshots_sheet ON run_snapshots(sheet_id, created_at DESC);

  -- A MIRROR of "cells", minus "rev". Every field is copied because a restore that returns a thinner
  -- cell than it saved is the loss nobody goes looking for — the lesson undo.ts learned by naming ten
  -- of twenty-three columns by hand. "rev" is excluded on purpose: it is BUMPED on restore, so every
  -- open grid treats the restored value as newer than what it is showing.
  --
  -- The INSERT and the UPDATE are both generated from PRAGMA table_info at run time, and a test
  -- asserts this list still matches "cells" exactly. That test is what stops the next migration adding
  -- a cells column that restore silently drops.
  -- "snapshot_run_id" is the run that TOOK the snapshot; "run_id" below is cells' own field, meaning
  -- the run that produced the value being saved. Two different runs, deliberately two different names:
  -- reusing "run_id" for the taker would have made the mirror inexact and forced the generated SQL to
  -- carry a rename, which is exactly where a field gets quietly dropped.
  CREATE TABLE IF NOT EXISTS run_snapshot_cells (
    snapshot_run_id TEXT NOT NULL REFERENCES run_snapshots(run_id) ON DELETE CASCADE,
    row_id      INTEGER NOT NULL,
    column_id   INTEGER NOT NULL,

    status      TEXT NOT NULL DEFAULT 'empty',
    value_json  TEXT,
    value_text  TEXT,
    confidence  TEXT,
    source_url  TEXT,
    note        TEXT,

    error_type  TEXT,
    error_msg   TEXT,

    stale       INTEGER NOT NULL DEFAULT 0,
    pinned      INTEGER NOT NULL DEFAULT 0,
    input_hash  TEXT,

    run_id      TEXT,                                  -- cells' own: which run produced this value
    attempt     INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL,
    tokens_in   INTEGER,
    tokens_out  INTEGER,
    tokens_cache_read   INTEGER,
    tokens_cache_create INTEGER,
    duration_ms INTEGER,
    updated_at  TEXT,

    PRIMARY KEY (snapshot_run_id, row_id, column_id)
  ) WITHOUT ROWID;

  -- ───────────────────────────────────────────────────────────── runs

  CREATE TABLE IF NOT EXISTS runs (
    id            TEXT PRIMARY KEY,
    sheet_id      TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    scope_json    TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'pending',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    started_at    TEXT, finished_at TEXT,
    total         INTEGER NOT NULL DEFAULT 0,
    done_c        INTEGER NOT NULL DEFAULT 0,
    error_c       INTEGER NOT NULL DEFAULT 0,
    skipped_c     INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0,
    budget_usd    REAL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    pause_reason  TEXT,
    boot_id       TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_runs_sheet ON runs(sheet_id, created_at DESC);

  -- ───────────────────────────────────────────────────────────── what was NOT spent
  --
  -- Every time the engine declines to buy something it could have bought — a row whose inputs have
  -- not changed since it last ran, a row a condition excluded before the paid lane saw it — it
  -- writes what that WOULD have cost here.
  --
  -- Why record it at all: the whole argument for this product over a per-row tool is that most rows
  -- do not need re-buying, and that argument is invisible. A run that skips 940,000 of a million
  -- rows shows the user a smaller bill and no explanation, so the saving reads as the run having
  -- done less rather than as the tool having done its job.
  --
  -- One row per (run, column, reason) rather than per cell. A million-row run must not write a
  -- million ledger rows to record that it wrote nothing.
  --
  -- The usd column is an ESTIMATE and is stored as one — it comes from the same per-row function the
  -- run confirmation quotes from, so the two cannot disagree. cells_unpriced counts the ones whose
  -- price was unknown, so a total can say how much of itself it could not see rather than quietly
  -- under-reporting.
  --
  -- (No backticks anywhere in this block: the whole schema is one JS template literal, and a
  -- backtick in a SQL comment ends it.)
  CREATE TABLE IF NOT EXISTS savings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT REFERENCES runs(id) ON DELETE CASCADE,
    sheet_id      TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    column_id     INTEGER NOT NULL,
    reason        TEXT NOT NULL,
    cells         INTEGER NOT NULL DEFAULT 0,
    cells_unpriced INTEGER NOT NULL DEFAULT 0,
    usd           REAL NOT NULL DEFAULT 0,
    at            TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS ix_savings_sheet ON savings(sheet_id, at DESC);
  CREATE INDEX IF NOT EXISTS ix_savings_run ON savings(run_id);

  -- ───────────────────────────────────────────────────────────── answers already bought
  --
  -- The finished answer to an exact question, so the same question asked from a second table, a
  -- duplicated column or a re-imported list is not bought again. Keyed by a hash of everything that
  -- decides the answer — see answerCache.ts, where the key is built and the reasoning lives.
  --
  -- Deliberately NOT tied to a sheet or a column. Its whole value is being reachable from anywhere:
  -- scoped to one table it would miss every case worth catching.
  --
  -- No foreign keys for the same reason. An entry outlives the column that produced it, and deleting
  -- a table must not throw away answers other tables are still using.
  CREATE TABLE IF NOT EXISTS answer_cache (
    key          TEXT PRIMARY KEY,
    status       TEXT NOT NULL,
    value_text   TEXT,
    model        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    hits         INTEGER NOT NULL DEFAULT 0
  );
  -- Expiry is a range scan over this, rather than a full pass to find what is old.
  CREATE INDEX IF NOT EXISTS ix_answer_cache_age ON answer_cache(created_at);

  -- ───────────────────────────────────────────────────────────── durable queue

  CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    row_id        INTEGER NOT NULL,
    column_id     INTEGER NOT NULL,
    sheet_id      TEXT    NOT NULL,
    depth         INTEGER NOT NULL DEFAULT 0,         -- topological depth; lower runs first
    priority      INTEGER NOT NULL DEFAULT 0,         -- viewport rows and single-cell runs jump
    status        TEXT NOT NULL DEFAULT 'blocked',
    attempt       INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 3,
    scheduled_at  TEXT NOT NULL DEFAULT (datetime('now')),
    leased_at     TEXT, lease_expires_at TEXT, boot_id TEXT,
    last_error    TEXT, last_error_type TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (run_id, row_id, column_id)                -- idempotency: double-click cannot duplicate
  );
  CREATE INDEX IF NOT EXISTS ix_jobs_pick   ON jobs(status, scheduled_at, depth, priority DESC);
  CREATE INDEX IF NOT EXISTS ix_jobs_run    ON jobs(run_id, status);
  CREATE INDEX IF NOT EXISTS ix_jobs_leased ON jobs(lease_expires_at) WHERE status = 'leased';

  -- ───────────────────────────────────────────────────────────── materialized view index
  --
  -- Filtered windowing cannot use position-range seeking, because a filter makes matching rows
  -- sparse. The obvious fallback, LIMIT/OFFSET, re-evaluates the predicate for every row it skips:
  -- measured on a filter matching 147,900 of 1,000,000 rows, a window at offset 140,000 took
  -- 1,106ms — against a 9ms unfiltered read.
  --
  -- So a filtered view materializes its matching row ids ONCE, with a dense sequence, turning every
  -- subsequent window back into an indexed seek. The index is stamped with the table's data version
  -- and rebuilt when that moves.

  CREATE TABLE IF NOT EXISTS view_index (
    view_key TEXT    NOT NULL,      -- sheet id + hash of the filter
    seq      INTEGER NOT NULL,      -- dense 0..n-1, in position order
    row_id   INTEGER NOT NULL,
    PRIMARY KEY (view_key, seq)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS view_index_meta (
    view_key     TEXT PRIMARY KEY,
    sheet_id     TEXT NOT NULL,
    row_count    INTEGER NOT NULL,
    data_version INTEGER NOT NULL,
    built_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- The display index for a GROUPED view: one header row per group, then its member rows, numbered
  -- densely in DISPLAY order so the grid can paginate over headers without knowing where they fall.
  -- view_key here is "g|<the row view's key>|c<column id>", and row_count in view_index_meta —
  -- sharing that table, the same data_version invalidation and the same trim discipline — is the
  -- DISPLAY count (rows + headers), not the row count.
  CREATE TABLE IF NOT EXISTS group_index (
    view_key TEXT    NOT NULL,
    dseq     INTEGER NOT NULL,      -- dense 0..n-1, a header immediately before its group
    row_id   INTEGER,               -- null on a header
    is_head  INTEGER NOT NULL,
    label    TEXT,                  -- the group's value in display form; null = the blank group
    n        INTEGER,               -- rows in the group, counted over the WHOLE view
    PRIMARY KEY (view_key, dseq)
  ) WITHOUT ROWID;

  -- ───────────────────────────────────────────────────────────── ops

  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ───────────────────────────────────────────────────────────── people
  --
  -- Empty on a single-user install, and that is the normal case: Ferrum binds to loopback and
  -- anything running as this user can already read this file. These tables exist for the other
  -- deployment — one copy on a server that several people share — where "who is asking?" has to be
  -- answered before "what may they do?".
  --
  -- The moment ONE row lands in the users table, the instance is claimed and every request needs a session.
  -- That is the switch: there is no separate "auth enabled" setting to be left off by accident.

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Stored lowercased and trimmed. The UNIQUE index is what stops "Sam@x.com" and "sam@x.com"
    -- becoming two accounts that look identical in the members list.
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    -- scrypt, as "scrypt$N$r$p$salt$hash". The parameters travel WITH the hash so raising them later
    -- does not lock out everyone who signed up before.
    password_hash TEXT NOT NULL,
    -- owner | admin | member | viewer. See src/access.ts — that file is the only thing that reads it.
    role          TEXT NOT NULL DEFAULT 'member',
    -- Suspended rather than deleted: their runs, their spend and their edits stay attributable.
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    -- The SHA-256 of the cookie value, never the value. A stolen database is then a list of hashes
    -- rather than a set of working logins.
    id            TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
    -- Shown on the "where you are signed in" list, so a session nobody recognises can be ended.
    user_agent    TEXT NOT NULL DEFAULT '',
    ip            TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS ix_sessions_expiry ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS invites (
    -- Hashed for the same reason a session is: the link IS the credential until it is used.
    token_hash   TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'member',
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    accepted_at  TEXT,
    accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS ix_invites_email ON invites(email);

  -- Who may reach a particular workbook, over and above what their role already allows.
  --
  -- Absent a grant, a member sees every workbook — the common case is a team sharing one workspace,
  -- and making people ask for access to everything is how a tool stops being used. A workbook marked
  -- restricted flips that for itself: then only the people listed here can reach it.
  CREATE TABLE IF NOT EXISTS workbook_grants (
    workbook_id  TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- view | edit. Never higher than the person's own role allows — a viewer granted "edit" is still
    -- a viewer, because the grant widens WHICH workbooks, never WHAT may be done.
    access       TEXT NOT NULL DEFAULT 'view',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workbook_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS ix_grants_user ON workbook_grants(user_id);

  /*
   * The assistant's conversation, per table.
   *
   * It lived in React state, so the panel's own close button destroyed it — and so did a reload, and
   * so did opening another table and coming back. The conversation is about one table and builds up
   * context over several turns ("no, use the website column instead"), which is exactly what made
   * losing it expensive: the value of turn five is everything said in turns one to four.
   *
   * Beside the table rather than in the browser, because the engine is where this app's state lives
   * and because a transcript in localStorage is invisible to the table it describes — a trashed
   * table would leave its conversation behind forever. ON DELETE CASCADE handles that here.
   *
   * applied_json carries which proposals were already applied, so re-opening the panel shows an
   * applied suggestion as applied rather than offering to do it a second time. (No backticks in
   * this block: it sits inside a template literal, and one would end the string.)
   */
  CREATE TABLE IF NOT EXISTS assistant_messages (
    id           INTEGER PRIMARY KEY,
    sheet_id     TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text         TEXT NOT NULL,
    actions_json TEXT,
    applied_json TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS ix_assistant_sheet ON assistant_messages(sheet_id, id);
`);

// ─────────────────────────────────────────────────────────────── additive migrations
//
// `CREATE TABLE IF NOT EXISTS` does NOTHING to a table that already exists, so every column added
// after a database has been created must arrive via ALTER TABLE. Two rules learned the hard way:
//
//   1. Never reference a not-yet-added column from the main CREATE block (an index on it will throw
//      on an existing DB and abort the whole schema init).
//   2. Run migrations BEFORE anything prepares a statement against these tables, and make each one
//      individually safe to re-run.

interface Migration { table: string; column: string; ddl: string }

const MIGRATIONS: Migration[] = [
  // Shared instances. A workbook nobody has been granted is open to the whole team by default —
  // `restricted` is what makes one an exception, so the common case needs no administration at all.
  { table: "workbooks", column: "restricted", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "workbooks", column: "created_by", ddl: "INTEGER" },
  // Who pressed Run. Spend on a shared instance is only answerable if every run names someone.
  { table: "runs",      column: "started_by", ddl: "INTEGER" },
  // Multi-value outputs: JSON projection, list fan-out, and write-to-another-table.
  { table: "columns", column: "source_column_id", ddl: "INTEGER" },
  { table: "columns", column: "json_path",        ddl: "TEXT" },
  { table: "columns", column: "fan_out",          ddl: "TEXT" },
  { table: "columns", column: "fan_out_cap",      ddl: "INTEGER NOT NULL DEFAULT 50" },
  { table: "columns", column: "fan_out_source",   ddl: "INTEGER" },
  { table: "columns", column: "aggregate",        ddl: "TEXT" },
  { table: "columns", column: "write_target",     ddl: "TEXT" },
  // Hooks added after the first schema.
  { table: "columns", column: "accept_script_id", ddl: "INTEGER" },
  { table: "columns", column: "map_script_id",    ddl: "INTEGER" },
  // Presentation.
  { table: "columns", column: "description",      ddl: "TEXT" },
  { table: "columns", column: "format",           ddl: "TEXT" },
  { table: "columns", column: "width",            ddl: "INTEGER" },
  { table: "columns", column: "frozen",           ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "columns", column: "relation_id",      ddl: "INTEGER" },
  { table: "columns", column: "lookup_column_id", ddl: "INTEGER" },
  { table: "columns", column: "rollup",           ddl: "TEXT" },
  // How a relation decides two values are the same thing: exact | normalized | fuzzy.
  //
  // Defaulted to `normalized` rather than to `exact`, and that is the safer default rather than the
  // looser one. Real lists hold the same company as "https://www.Acme.com/", "acme.com" and
  // "ACME.com"; an exact join over those matches almost nothing and reports it as "not found",
  // which reads as missing data rather than as a matching problem. Existing relations were built
  // under exactly this behaviour, so the default also keeps them working unchanged.
  { table: "relations", column: "match_mode",     ddl: "TEXT NOT NULL DEFAULT 'normalized'" },
  { table: "columns", column: "waterfall_json",   ddl: "TEXT" },
  /**
   * Whether this run is allowed to overwrite cells the user typed in by hand.
   *
   * Stored on the RUN rather than passed around, because the decision has to survive a crash: a
   * resumed run that forgot it would quietly start protecting cells the user had explicitly asked it
   * to replace, halfway through, with nothing to indicate why some rows changed and some did not.
   *
   * Defaults to 0, which is the existing behaviour for every run ever created — a hand edit is a
   * deliberate act, and overwriting one silently is the one thing a spreadsheet must never do.
   */
  { table: "runs", column: "overwrite_edited", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "columns", column: "auto_run",         ddl: "INTEGER NOT NULL DEFAULT 0" },
  /**
   * The ceiling on one auto-run firing.
   *
   * NULL on every existing column, which is the behaviour those columns already had: before this
   * migration a paid column could not auto-run at all, so there was nothing to cap. It stays NULL
   * until somebody sets one, and NULL means no ceiling — an honest default, because inventing a
   * limit for a column whose owner never chose one would stop runs nobody asked to stop.
   */
  { table: "columns", column: "auto_run_budget_usd", ddl: "REAL" },
  // Persisted per-column completion snapshot — see columnStats.ts for why it is stored rather than
  // recomputed (404ms per column on a million rows).
  { table: "columns", column: "stats_json",       ddl: "TEXT" },
  // Per-column agent configuration — today the web-search settings. Stored as JSON rather than as a
  // column per option: these are provider-shaped settings that change when a provider adds an
  // option, and a migration per checkbox is not a trade worth making.
  { table: "columns", column: "agent_json",       ddl: "TEXT" },
  // Workbook/table structure.
  // The column a webhook drops its whole payload into. Clay's model, and the right one: the
  // delivery lands intact and columns are DERIVED from it afterwards, so nobody has to describe a
  // payload shape before ever having seen one.
  { table: "webhook_sources", column: "payload_column_id", ddl: "INTEGER" },
  // Per-table dedupe: the ordered key columns, which copy survives, and whether it runs itself.
  { table: "sheets", column: "dedupe_json", ddl: "TEXT" },
  // Where a thing sits in the folder tree, and whether it is starred. On sheets this only applies
  // to loose tables — one inside a workbook is reached through its workbook.
  { table: "sheets", column: "folder_id", ddl: "TEXT" },
  { table: "sheets", column: "starred", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "sheets", column: "opened_at", ddl: "TEXT" },
  { table: "workbooks", column: "folder_id", ddl: "TEXT" },
  { table: "workbooks", column: "starred", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "workbooks", column: "opened_at", ddl: "TEXT" },
  { table: "sheets",  column: "workbook_id",        ddl: "TEXT" },
  { table: "sheets",  column: "position",           ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "sheets",  column: "kind",               ddl: "TEXT NOT NULL DEFAULT 'generic'" },
  { table: "sheets",  column: "primary_column_id",  ddl: "INTEGER" },
  { table: "sheets",  column: "default_view_id",    ddl: "INTEGER" },
  { table: "sheets",  column: "deleted_at",         ddl: "TEXT" },
  // Soft delete for columns, so removing one is reversible without copying its cells. A column on a
  // million-row sheet has a million cells; snapshotting those to support an undo that will usually
  // never be used is not a trade worth making, and the flag makes undo one UPDATE either way.
  { table: "columns", column: "deleted_at",         ddl: "TEXT" },
  // Where a `send` column writes to, and how it maps values across. Its own field rather than a
  // reuse of http_config: they are different shapes, and one column holding two unrelated blobs
  // depending on kind is how a mode switch silently corrupts the other one's settings.
  { table: "columns", column: "send_config",        ddl: "TEXT" },
  // Which connected app and tool an `mcp` column calls, and how the row's values map onto that
  // tool's arguments. Its own field for the same reason `send_config` is: a mode switch must not be
  // able to feed one lane's saved settings to another that reads a different shape.
  { table: "columns", column: "mcp_config",         ddl: "TEXT" },
  // A colour for a column, stored as a token NAME. See the note on Column.color for why not a hex.
  { table: "columns", column: "color",              ddl: "TEXT" },
  // Declared third-party spend for the lanes that have no token count of their own. An HTTP column
  // calling a paid API is real money leaving the workspace, and before this the cost screen showed
  // it as $0 — which is worse than showing nothing, because a zero reads as free.
  { table: "usage_daily", column: "units", ddl: "REAL NOT NULL DEFAULT 0" },
  { table: "usage_daily", column: "unit",  ddl: "TEXT NOT NULL DEFAULT ''" },
  // How sure the model was, remembered with the answer.
  //
  // Without this a cache hit would come back with no grade and CLEAR the one already on the cell —
  // a row that said "answered, not sure" would quietly turn into a row that says nothing, purely
  // because the same question was asked again somewhere else. The grade is part of the answer, so it
  // is stored with the answer. Rows written before this column existed read null, which is correct:
  // their grade was genuinely never recorded.
  { table: "answer_cache", column: "confidence", ddl: "TEXT" },
  // Try this model first, and only fall through to the column's real model when the answer comes
  // back unsure. Empty means the feature is off, which is the default for every existing column.
  { table: "columns", column: "first_model", ddl: "TEXT" },
  /**
   * Which schedule started this run, when one did.
   *
   * The whole of a schedule's spend record. What it cost last time and what it has cost across every
   * firing are QUERIES over the runs it started, not counters kept beside them — a second tally would
   * be a second source of truth about money, and the two would eventually disagree about the only
   * number anyone actually checks. Null for a run somebody started by hand, which is most of them.
   */
  { table: "runs", column: "schedule_id", ddl: "INTEGER" },
  /**
   * Calls this column may START per minute. 0 means no limit, which is every existing column.
   *
   * Concurrency does not bound a rate: six workers against a provider answering in 50ms is 120 calls
   * a second, which is inside every concurrency limit and outside most rate limits. When a provider
   * states "60 requests per minute" this is where that number goes, and obeying it directly beats
   * discovering it by being refused.
   */
  { table: "columns", column: "rate_limit_per_min", ddl: "INTEGER NOT NULL DEFAULT 0" },
  /** Seconds a `wait` column holds each row for before letting the next column have it. */
  { table: "columns", column: "wait_seconds", ddl: "INTEGER NOT NULL DEFAULT 0" },
  /**
   * Per-column validation rules, as a `RuleSet` JSON blob (src/validate.ts).
   *
   * NULL means no rules, which is what every existing column has and must keep having — adding this
   * cannot start refusing writes to a table that was fine yesterday.
   */
  { table: "columns", column: "validation", ddl: "TEXT" },
  /**
   * Cells that RAN, cost money, and produced no value.
   *
   * They used to be counted as `done`, because `not_found` is a success and the counter had only
   * three buckets. It is a success in the sense that the engine looked and the answer genuinely is
   * "none" — and it is not what anyone means by "42 of 50 done". On a free rate-limited model, where
   * a third of the rows coming back blank is the normal case, a summary reading all-done was the
   * only report of a column that had mostly not filled.
   */
  { table: "runs", column: "blank_c", ddl: "INTEGER NOT NULL DEFAULT 0" },
  /**
   * The part of `cost_usd` spent on cells that produced nothing.
   *
   * A failing cell can still bill: an agent that searches (paid) and then returns an empty completion
   * costs real money for an empty cell. Folded into one total, that spend reads as progress. It is a
   * subset of `cost_usd`, never a second charge — the two are written from the same outcome.
   */
  { table: "runs", column: "waste_usd", ddl: "REAL NOT NULL DEFAULT 0" },
];

/**
 * Columns removed because they describe something this app does not have.
 *
 * Both were declared in the first schema, both were SELECTed by the cell-details route, both were
 * typed in the client — and neither was ever written, because there is no session concept here and
 * nothing produces a transcript file for a path to point at. A column that CAN be filled and is not
 * is a bug to fix; one that can never be filled is a promise to withdraw, and leaving it invites the
 * next person to build a viewer on four columns that are null on every row in every database.
 *
 * Their siblings went the other way in the same pass: `num_turns` and `raw_result` had real data
 * available all along and are now written.
 *
 * Dropped rather than commented, because a schema is read as the truth about what exists.
 */
const DROPS: Array<{ table: string; column: string }> = [
  { table: "cell_attempts", column: "session_id" },
  { table: "cell_attempts", column: "transcript_path" },
];

function migrate(): void {
  for (const d of DROPS) {
    const cols = db.prepare(`PRAGMA table_info(${d.table})`).all() as any[];
    if (cols.length === 0 || !cols.some((c) => c.name === d.column)) continue;
    try {
      db.exec(`ALTER TABLE ${d.table} DROP COLUMN ${d.column}`);
    } catch (e) {
      // Never fatal. A drop that fails — an old SQLite, an index nobody expected — leaves a column
      // that is unused rather than a database that will not open. Losing a boot over tidying is a
      // far worse trade than carrying a dead column for another release.
      console.warn(`[db] could not drop ${d.table}.${d.column}:`, e instanceof Error ? e.message : e);
    }
  }

  for (const m of MIGRATIONS) {
    // PRAGMA table_info is the cheap, reliable existence check — far better than catching the
    // "duplicate column name" error, which would also swallow real failures.
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as any[];
    if (cols.length === 0) continue;                       // table not created yet
    if (cols.some((c) => c.name === m.column)) continue;    // already migrated
    try {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
    } catch (e) {
      // One failed migration must not abort the rest, or a single bad DDL leaves the DB
      // half-migrated for every subsequent boot.
      console.warn(`[db] migration ${m.table}.${m.column} failed:`, e instanceof Error ? e.message : e);
    }
  }

  // One failed ALTER as a bare console.warn lets boot carry on into a half-migrated database that
  // then throws "no such column" at request time, surfacing to the user as a 400 on an unrelated
  // action. Re-read the schema and refuse to start instead: a database this
  // binary cannot serve correctly is worth failing loudly for, and the check costs one PRAGMA per
  // table.
  const missing: string[] = [];
  for (const table of new Set(MIGRATIONS.map((m) => m.table))) {
    const have = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => String(c.name)),
    );
    for (const m of MIGRATIONS) if (m.table === table && !have.has(m.column)) missing.push(`${table}.${m.column}`);
  }
  if (missing.length > 0) {
    throw new Error(
      `The database is missing ${missing.length} column(s) this version needs: ${missing.join(", ")}. ` +
        `A migration failed above — the warning says which and why. Nothing was started.`,
    );
  }
}

migrate();

/**
 * Columns get the same uniqueness guarantee rows already have.
 *
 * `moveColumn` renumbers a sheet's columns densely, but undo replayed a single absolute position —
 * so undoing a move left two columns sharing one position and another vacant. `ORDER BY position`
 * then broke ties by rowid, which means the grid, the CSV export and every rendered reference could
 * disagree about column order with nothing reporting an error. The undo path is fixed to go through
 * moveColumn, but a constraint is what makes the corruption unstorable rather than merely unlikely.
 *
 * Existing databases may already hold duplicates from that bug, so positions are densified first.
 * The index is best-effort: if it still cannot be created the app is no worse off than before, and
 * migrate()'s hard check covers columns, not indexes.
 */
/**
 * Give a set of columns new positions without colliding with themselves on the way.
 *
 * `ux_columns_sheet_pos` is a real UNIQUE index and SQLite enforces it per ROW, not per statement,
 * so the obvious renumber breaks on its own output: writing the order [C,A,B] over positions 0,1,2
 * sets C to 0 while A is still sitting at 0. The same applies to a bulk `position = position + 1`,
 * which walks 0→1 straight into the row already at 1.
 *
 * Both are fixed the same way: park every row on a negative position first. Negation is injective,
 * so the parked rows stay unique among themselves, and a negative can never collide with a row that
 * has not moved yet — every intermediate state is legal. Two passes, no temporary table, and the
 * index stays enforced throughout rather than being dropped and rebuilt around the edit.
 *
 * The caller passes EVERY column whose position changes. Positions left out are assumed to be
 * staying put and not to be in the target range.
 */
export function renumberColumns(pairs: Array<readonly [id: number, position: number]>): void {
  if (pairs.length === 0) return;
  tx(() => {
    const set = db.prepare("UPDATE columns SET position = ? WHERE id = ?");
    // -1 downward: distinct from each other and from every real position, which is never negative.
    pairs.forEach(([id], i) => set.run(-(i + 1), id));
    for (const [id, position] of pairs) set.run(position, id);
  });
}

function enforceColumnPositions(): void {
  try {
    const dupes = db
      .prepare(
        `SELECT sheet_id FROM columns WHERE deleted_at IS NULL
         GROUP BY sheet_id, position HAVING COUNT(*) > 1`,
      )
      .all() as any[];
    if (dupes.length > 0) {
      const sheets = [...new Set(dupes.map((d) => String(d.sheet_id)))];
      tx(() => {
        for (const sheetId of sheets) {
          const cols = db
            .prepare("SELECT id FROM columns WHERE sheet_id = ? AND deleted_at IS NULL ORDER BY position, id")
            .all(sheetId) as any[];
          renumberColumns(cols.map((c, i) => [Number(c.id), i] as const));
        }
      });
      console.warn(`[db] repaired duplicate column positions on ${sheets.length} sheet(s)`);
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_columns_sheet_pos ON columns(sheet_id, position) WHERE deleted_at IS NULL;");
  } catch (e) {
    console.warn("[db] could not enforce unique column positions:", e instanceof Error ? e.message : e);
  }
}

enforceColumnPositions();

/**
 * Every table belongs to a workbook.
 *
 * The model started with tables that could float free of one, and the workspace browser then had to
 * list both — so a "file" and a "tab inside a file" appeared side by side as if they were the same
 * kind of thing, and a table's own name was the only name it had. That is not a display bug; it is
 * the data model showing through. Clay's shape is the right one and it is simpler: a folder holds
 * FILES, a file holds TABS.
 *
 * Each loose table becomes a workbook of the same name holding that one table, which is exactly what
 * a table made on its own is: a file with one tab. Its folder travels with it, so nothing moves.
 * Runs once — after it, there is nothing left to adopt.
 */
function adoptLooseSheets(): void {
  // Trashed loose tables are adopted too. Excluding them meant a restored legacy table came back
  // with no workbook and therefore appeared in no list at all — invisible until the next restart,
  // which is the exact state this function exists to prevent. Adopting a trashed table is harmless
  // because the workbook travels with it and is trashed alongside.
  const loose = db
    .prepare("SELECT id, name, folder_id FROM sheets WHERE workbook_id IS NULL")
    .all() as any[];
  if (loose.length === 0) return;

  const insWb = db.prepare("INSERT INTO workbooks (id, name, folder_id) VALUES (?, ?, ?)");
  const setWb = db.prepare("UPDATE sheets SET workbook_id = ?, position = 0, folder_id = NULL WHERE id = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const s of loose) {
      // A fresh id rather than reusing the sheet's: they are different objects, and sharing an id
      // would make every "is this a workbook or a table" question ambiguous forever after.
      const wbId = randomUUID();
      insWb.run(wbId, s.name, s.folder_id ?? null);
      setWb.run(wbId, s.id);
    }
    db.exec("COMMIT");
    console.log(`[db] put ${loose.length} loose table(s) into a workbook of their own`);
  } catch (e) {
    db.exec("ROLLBACK");
    console.warn("[db] could not adopt loose tables:", e instanceof Error ? e.message : e);
  }
}

adoptLooseSheets();

// ─────────────────────────────────────────────────────────────── cell ids
//
// A cell has no id column — it is identified by its (row, column) pair. The public id is that pair
// joined, which is stable, derivable on both sides, and costs nothing to store. It also means the
// web client can locate a cell straight from an SSE delta with no lookup table.

export const cellId = (rowId: number, columnId: number): string => `${rowId}:${columnId}`;

export function parseCellId(id: string): { rowId: number; columnId: number } | null {
  const ix = id.indexOf(":");
  if (ix < 1) return null;
  const rowId = Number(id.slice(0, ix));
  const columnId = Number(id.slice(ix + 1));
  if (!Number.isInteger(rowId) || !Number.isInteger(columnId)) return null;
  return { rowId, columnId };
}

// ─────────────────────────────────────────────────────────────── kv helpers

const kvGetStmt = db.prepare("SELECT v FROM kv WHERE k = ?");
const kvSetStmt = db.prepare(
  "INSERT INTO kv (k, v, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at",
);
export const getKv = (k: string): string | null => (kvGetStmt.get(k) as { v: string } | undefined)?.v ?? null;
export const setKv = (k: string, v: string): void => { kvSetStmt.run(k, v); };

const kvPrefixStmt = db.prepare("SELECT k, v FROM kv WHERE k LIKE ? ESCAPE '\\' AND v <> '' ORDER BY k");

/**
 * Every key under a prefix.
 *
 * For settings stored one row per THING rather than one row per screen — per-model prices, for
 * instance, where the set of models is not known ahead of time and cannot be a fixed key.
 *
 * The prefix is escaped: `%` and `_` are wildcards in LIKE, and a model id containing an underscore
 * is completely ordinary. Unescaped, `price.model.x/gpt_4` would also match `gpt-4`, and the wrong
 * price would be returned for a real model name.
 */
export function kvRows(prefix: string): Array<{ key: string; value: string }> {
  const safe = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  return (kvPrefixStmt.all(`${safe}%`) as Array<{ k: string; v: string }>)
    .map((r) => ({ key: r.k, value: r.v }));
}

/**
 * Run `fn` inside a transaction. Every batched write goes through this — without it SQLite commits
 * per statement and a large import crawls.
 *
 * REENTRANT. The first call opens a real transaction; a nested call opens a SAVEPOINT instead. This
 * matters because the natural way to write a compound operation is to call two functions that each
 * already wrap themselves — `duplicateColumn` calls `addColumn`, and every route that records an undo
 * entry calls `record()`. A plain BEGIN/COMMIT throws "cannot start a transaction within a
 * transaction" on all of those, and worse, the inner ROLLBACK unwinds the OUTER caller's work before
 * rethrowing. Savepoints give the inner block its own unit of atomicity without touching the outer.
 */
let txDepth = 0;

export function tx<T>(fn: () => T): T {
  const depth = txDepth++;
  const sp = `tx_${depth}`;
  db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${sp}`);
  try {
    const out = fn();
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return out;
  } catch (e) {
    try {
      // ROLLBACK TO leaves the savepoint on the stack, so it must be released too — otherwise the
      // outer COMMIT trips over it.
      db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    } catch { /* already unwound */ }
    throw e;
  } finally {
    txDepth = depth;
  }
}

/**
 * How long an attempt's provenance is kept.
 *
 * Long enough to answer the questions attempts exist to answer — what did this cell cost, what did
 * the model actually see, why did it fail — and short enough that the record of a million-row run
 * does not sit in the file for the life of the workspace. `cells` still carries the LAST outcome of
 * every cell forever, so a swept attempt loses the history of a value, never the value.
 */
export const ATTEMPT_RETENTION_DAYS = 90;

/**
 * Rows one sweep may remove.
 *
 * A first sweep against a database that has never had one could otherwise be a single DELETE of
 * millions of rows holding boot open and rewriting the WAL. Bounded, it takes as many boots as it
 * needs to catch up, which nobody is waiting on.
 */
const ATTEMPT_SWEEP_LIMIT = 50_000;

/**
 * Drop attempts past the retention window. Returns how many went.
 *
 * `cell_tool_calls` hangs off this table with ON DELETE CASCADE and the pragma is on, so the tool
 * calls of a swept attempt go with it.
 */
export function pruneCellAttempts(
  days: number = ATTEMPT_RETENTION_DAYS,
  limit: number = ATTEMPT_SWEEP_LIMIT,
): number {
  const info = db
    .prepare(
      // Bounded through a subquery on the age index rather than a bare DELETE ... LIMIT, which
      // SQLite only accepts when it was compiled with an option we cannot rely on being set.
      `DELETE FROM cell_attempts WHERE id IN
         (SELECT id FROM cell_attempts WHERE started_at < datetime('now', ?) ORDER BY id LIMIT ?)`,
    )
    .run(`-${days} days`, limit);
  return Number(info.changes ?? 0);
}

/**
 * Boot-time recovery. A crash or Ctrl-C leaves leased jobs and half-written attempts behind.
 *
 * Interrupted runs are set to PAUSED rather than resumed: silently continuing a large spend because
 * the machine rebooted is exactly the behaviour that loses a user's trust, and their quota.
 *
 * The retention sweep rides along here rather than getting a caller of its own: this already runs
 * exactly once per process, before the server is listening, which is the one moment nobody is
 * waiting on a delete.
 */
export function recoverAfterRestart(bootId: string): { reclaimedJobs: number; pausedRuns: number } {
  const out = tx(() => {
    const reclaimed = db
      .prepare(
        `UPDATE jobs SET status = 'ready', leased_at = NULL, lease_expires_at = NULL,
                         scheduled_at = datetime('now')
          WHERE status = 'leased' AND (boot_id IS NULL OR boot_id <> ?)`,
      )
      .run(bootId);

    db.exec(
      `UPDATE cells SET status = 'queued', rev = rev + 1
        WHERE status = 'running'
          AND (row_id, column_id) IN (SELECT row_id, column_id FROM jobs WHERE status = 'ready')`,
    );

    db.exec(
      `UPDATE cell_attempts SET status = 'interrupted', finished_at = datetime('now')
        WHERE finished_at IS NULL`,
    );

    const paused = db
      .prepare(
        // `paused`, not `paused_quota`. A restart is not a rate limit, and telling someone their
        // provider throttled them when the engine simply stopped sends them to check the wrong
        // thing — the two states carry different advice (wait, versus press Resume).
        `UPDATE runs SET status = 'paused', pause_reason = 'The engine restarted while this was running.'
          WHERE status IN ('running', 'cancelling')`,
      )
      .run();

    return {
      reclaimedJobs: Number(reclaimed.changes ?? 0),
      pausedRuns: Number(paused.changes ?? 0),
    };
  });

  // Outside the transaction above: a sweep that fails must not take the recovery down with it, and
  // the recovery is the part a run depends on.
  try {
    const swept = pruneCellAttempts();
    if (swept > 0) {
      console.log(`[db] removed ${swept} attempt record(s) older than ${ATTEMPT_RETENTION_DAYS} days.`);
    }
  } catch (e) {
    console.warn("[db] could not sweep old attempts:", e instanceof Error ? e.message : e);
  }

  return out;
}
