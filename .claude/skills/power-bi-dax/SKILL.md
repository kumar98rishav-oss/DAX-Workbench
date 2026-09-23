---
name: power-bi-dax
description: Author, audit and optimise DAX against a LIVE Power BI model using the DAX Workbench MCP tools. Use whenever the task involves writing, checking, fixing or speeding up Power BI measures, DAX, or a semantic model — always validate references and preview the value on the real engine before proposing or writing a measure.
---

# Power BI DAX — verify before you propose

You have a live connection to the user's open Power BI model through the
**DAX Workbench** MCP tools. The rule that matters: **never hand the user a
measure you haven't checked against the real engine.** AI-written DAX that
references a table or column that doesn't exist, or that quietly returns the
wrong number, is worse than no answer. These tools exist so you don't have to
guess.

## The loop, every time

1. **Orient.** Call `pbi_list_open_models`, then `pbi_get_model` once. Read the
   real table, column and measure names. Every name you write must come from
   there — do not invent, abbreviate, or assume.
2. **Draft** the DAX using only names from the model.
3. **Verify — this step is not optional.** Call `pbi_validate_measure` with the
   expression. It does two things: it statically checks that every table,
   column and measure you referenced actually exists (catching invented names),
   and if that passes it **evaluates the measure on the real engine** and returns
   the value.
   - If it comes back `NOT VALID`, it lists exactly which names are wrong. Fix
     them against `pbi_get_model` and validate again. Do not propose the measure
     until it validates.
   - If it comes back `VALID`, note the preview value — you'll cite it.
4. **Propose** the measure to the user **with its verified value**: “this
   returns 14,640,301 on your model.” That number is your evidence.

## Performance work

- Use `pbi_analyze_storage` to find what's costing memory — it lists the biggest
  tables and columns (high cardinality + large size = the target).
- When you rewrite a measure for speed, **prove it** with `pbi_benchmark_dax` on
  both the old and new query. It measures cold-cache, minimum of several runs.
  Only claim "faster" if the numbers say so. The usual win is pushing a
  predicate from the Formula Engine into the Storage Engine — e.g.
  `COUNTROWS(FILTER(T, T[x]>0))` → `CALCULATE(COUNTROWS(T), T[x]>0)`.

## Writing to the model

- `pbi_write_measure` and `pbi_delete_measure` are **deny-by-default**. They only
  work if the server was started with `DAXWB_MCP_ALLOW_WRITE=1`. If a write is
  refused for that reason, tell the user how to enable it — don't try to work
  around it.
- Even when writing is enabled, `pbi_write_measure` **validates the DAX first**
  and refuses to write invented names. Trust the gate; if it refuses, fix the
  DAX.
- Before deleting, confirm with the user. Deleting a measure others depend on
  breaks their reports.

## Style

- Prefer `DIVIDE(a, b)` over `a / b` (safe divide).
- Give every measure a format string.
- For time intelligence, pivot on the model's real date dimension (find it in
  `pbi_get_model`), not a fact-table date.
- Keep measure names consistent with the ones already in the model.

## Working on the project as code (PBIP / TMDL)

When the task is refactoring, documentation, or "what uses this" across the whole
model — not just one live measure — use the file-based tools. They read the PBIP
project on disk and work even with Power BI closed.

- `pbi_open_project` — see the model as source control sees it: tables, measures
  (with display folders), relationships.
- `pbi_read_tmdl` — read a table's raw TMDL before you edit it. Always read first.
- `pbi_write_tmdl` — overwrite a table's TMDL for a refactor. Guarded by
  `DAXWB_MCP_ALLOW_WRITE`. It only overwrites an existing table file. **Edit the
  text you read; don't regenerate from memory.** After writing, tell the user to
  reopen the project in Power BI Desktop.
- `pbi_measure_usage` — before removing or renaming a measure, check which report
  visuals use it. "Used in 0 visuals" means nothing visible breaks — but still
  check whether other measures reference it (with the live model + a validate).

Prefer to combine: when the live model is open, verify DAX on the engine; when
doing repo-wide edits, work through the project files. They complement each other.

## If the tools aren't there

If `pbi_list_open_models` reports nothing or the tools are missing, the DAX
Workbench bridge isn't running. Ask the user to open Power BI Desktop and launch
**DAX Workbench** from the External Tools ribbon, then retry. Don't fall back to
proposing unverified DAX.
