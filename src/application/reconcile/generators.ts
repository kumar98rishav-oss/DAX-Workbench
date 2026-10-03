/**
 * APPLICATION — Check generators
 *
 * A check is not a feature with a hidden implementation: it is a button that
 * WRITES BOTH QUERIES into the two panes, which the user can then read and
 * edit. That is deliberately better than a black box — it is auditable, it
 * teaches what the check means, and when a generator cannot express a case the
 * user edits the SQL instead of hitting a wall.
 *
 * Every identifier emitted here is quoted. User-controlled names reach a query
 * string, so quoting is a safety boundary, not tidiness.
 */

export interface GeneratedPair {
  /** Runs against the Power BI model (TARGET). */
  dax: string
  /** Runs against SQL Server (SOURCE). */
  sql: string
  /** What this check asserts, shown above the panes. */
  note: string
}

// ── Identifier quoting ──────────────────────────────────────────────────────

/** 'Table Name' — a single quote inside a DAX table name is doubled. */
export const daxTable = (name: string): string => `'${name.replace(/'/g, "''")}'`

/** 'Table'[Column] — a closing bracket inside a DAX column name is doubled. */
export const daxColumn = (table: string, column: string): string =>
  `${daxTable(table)}[${column.replace(/]/g, ']]')}]`

/** [Identifier] — a closing bracket inside a T-SQL identifier is doubled. */
export const sqlIdent = (name: string): string => `[${name.replace(/]/g, ']]')}]`

/** [schema].[object], or just [object] when no schema is given. */
export const sqlObject = (object: string, schema?: string): string =>
  schema ? `${sqlIdent(schema)}.${sqlIdent(object)}` : sqlIdent(object)

// ── Check configuration ─────────────────────────────────────────────────────

export interface TableTarget {
  /** Model table name. */
  table: string
  /** SQL object the model table loads from. */
  sqlObject: string
  sqlSchema?: string
}

export interface ColumnTarget extends TableTarget {
  /** Model column name. */
  column: string
  /** SQL column name — often differs from the model's after Power Query renames. */
  sqlColumn: string
}

/** A business key: one or more column pairs that should uniquely identify a row
 * (e.g. OrderID + OrderLine). Used by the duplicate and grain generators, and
 * as the join key in the comparison. */
export interface BusinessKey extends TableTarget {
  columns: { model: string; sql: string }[]
}

// ── Generators ──────────────────────────────────────────────────────────────

/** Row count: the simplest reconciliation and usually the first one to fail. */
export function rowCount(t: TableTarget): GeneratedPair {
  return {
    dax: `EVALUATE\nROW ( "RowCount", COUNTROWS ( ${daxTable(t.table)} ) )`,
    sql: `SELECT COUNT(*) AS [RowCount]\nFROM ${sqlObject(t.sqlObject, t.sqlSchema)};`,
    note: `Row count of ${t.table} against ${t.sqlSchema ? `${t.sqlSchema}.` : ''}${t.sqlObject}.`,
  }
}

/**
 * Distinct values.
 *
 * DISTINCTCOUNTNOBLANK, not DISTINCTCOUNT — this is the trap that makes naive
 * reconciliation tools wrong on every nullable column. DAX DISTINCTCOUNT counts
 * BLANK as a distinct value; SQL COUNT(DISTINCT c) ignores NULL. The two differ
 * by exactly 1 whenever nulls are present, silently and systematically. The
 * NOBLANK variant matches SQL's semantics, and the blank count is surfaced
 * separately by the nulls check so nothing is hidden.
 */
export function distinctValues(c: ColumnTarget): GeneratedPair {
  return {
    dax: `EVALUATE\nROW ( "DistinctValues", DISTINCTCOUNTNOBLANK ( ${daxColumn(c.table, c.column)} ) )`,
    sql: `SELECT COUNT(DISTINCT ${sqlIdent(c.sqlColumn)}) AS [DistinctValues]\nFROM ${sqlObject(c.sqlObject, c.sqlSchema)};`,
    note:
      `Distinct values of ${c.column}. Uses DISTINCTCOUNTNOBLANK so it matches SQL's ` +
      `COUNT(DISTINCT …), which ignores NULL.`,
  }
}

/** Blank / null count for one column. */
export function nullCount(c: ColumnTarget): GeneratedPair {
  return {
    dax: `EVALUATE\nROW ( "Blanks", COUNTBLANK ( ${daxColumn(c.table, c.column)} ) )`,
    sql:
      `SELECT SUM(CASE WHEN ${sqlIdent(c.sqlColumn)} IS NULL THEN 1 ELSE 0 END) AS [Blanks]\n` +
      `FROM ${sqlObject(c.sqlObject, c.sqlSchema)};`,
    note: `Rows where ${c.column} is blank (model) / NULL (source).`,
  }
}

/**
 * Duplicate business keys.
 *
 * Note that neither side concatenates the key columns. Concatenation is the
 * trap: OrderID=1 + Line=23 and OrderID=12 + Line=3 both become "123", so
 * duplicates get invented or missed — and the engines disagree on nulls
 * ('a' + NULL is NULL in SQL; "a" & BLANK() is "a" in DAX). Both sides group
 * natively by the real columns instead.
 */
export function duplicateKeys(k: BusinessKey): GeneratedPair {
  const daxKeys = k.columns.map((c) => daxColumn(k.table, c.model)).join(', ')
  const sqlKeys = k.columns.map((c) => sqlIdent(c.sql)).join(', ')
  return {
    dax:
      `EVALUATE\n` +
      `FILTER (\n` +
      `    SUMMARIZE ( ${daxTable(k.table)}, ${daxKeys}, "DupRows", COUNTROWS ( ${daxTable(k.table)} ) ),\n` +
      `    [DupRows] > 1\n` +
      `)\n` +
      `ORDER BY [DupRows] DESC`,
    sql:
      `SELECT ${sqlKeys}, COUNT(*) AS [DupRows]\n` +
      `FROM ${sqlObject(k.sqlObject, k.sqlSchema)}\n` +
      `GROUP BY ${sqlKeys}\n` +
      `HAVING COUNT(*) > 1\n` +
      `ORDER BY COUNT(*) DESC;`,
    note: `Business keys appearing more than once: ${k.columns.map((c) => c.model).join(' + ')}.`,
  }
}

/**
 * Date coverage: the first date, the last date, and how many distinct days
 * carry data.
 *
 * Catches the failure a row count cannot: a load that brought *most* of the
 * data. Totals look plausible, nothing is obviously broken, and the report just
 * looks quiet at one end of the calendar. The three numbers together localize
 * it — a moved boundary shows in First/Last, a hole in the middle shows only in
 * the day count.
 *
 * First and Last compare as TEXT, not as numbers; see ComparisonCell.
 */
export function dateCoverage(c: ColumnTarget): GeneratedPair {
  const col = daxColumn(c.table, c.column)
  return {
    dax:
      `EVALUATE\n` +
      `ROW (\n` +
      `    "First", MIN ( ${col} ),\n` +
      `    "Last", MAX ( ${col} ),\n` +
      `    "Days", DISTINCTCOUNTNOBLANK ( ${col} )\n` +
      `)`,
    sql:
      `SELECT MIN(${sqlIdent(c.sqlColumn)}) AS [First],\n` +
      `       MAX(${sqlIdent(c.sqlColumn)}) AS [Last],\n` +
      `       COUNT(DISTINCT ${sqlIdent(c.sqlColumn)}) AS [Days]\n` +
      `FROM ${sqlObject(c.sqlObject, c.sqlSchema)};`,
    note:
      `Range and density of ${c.column}. Compare all three: First and Last move when a ` +
      `boundary shifts, Days alone moves when a date in the middle is missing.`,
  }
}

/**
 * Every distinct value of a column with how often it occurs.
 *
 * Two sides can both report 60 products and not hold the same 60 — a count
 * alone cannot tell them apart. Comparing the values themselves makes the
 * difference land as "only in source" / "only in target", naming the exact
 * codes that diverge.
 *
 * Mechanically this is `byGrain` over a single column with no measure; it
 * exists separately because the question is a different one, and a user looking
 * for "which values differ" will not find it filed under grain.
 */
export function valueSet(c: ColumnTarget): GeneratedPair {
  const g = byGrain({ ...c, dimensions: [{ model: c.column, sql: c.sqlColumn }] })
  return {
    ...g,
    note:
      `Every distinct ${c.column} and its row count. Values present on only one side are the ` +
      `set difference — a matching count does not mean a matching set.`,
  }
}

export interface GrainCompare extends TableTarget {
  /** Grouping columns, coarsest first — this is also the drill order. */
  dimensions: { model: string; sql: string }[]
  /** What to total. Omit to compare row counts at each grain. */
  measure?: { model: string; sqlExpression: string }
}

/**
 * Value by grain — the query pair behind the drill matrix.
 *
 * Both sides return data at the finest grain listed; the matrix rolls up in the
 * browser, so expanding a level costs nothing and never re-queries.
 */
export function byGrain(g: GrainCompare): GeneratedPair {
  const daxDims = g.dimensions.map((d) => daxColumn(g.table, d.model)).join(', ')
  const sqlDims = g.dimensions.map((d) => sqlIdent(d.sql)).join(', ')

  const daxValue = g.measure
    ? `SUM ( ${daxColumn(g.table, g.measure.model)} )`
    : `COUNTROWS ( ${daxTable(g.table)} )`
  const sqlValue = g.measure ? `SUM(${g.measure.sqlExpression})` : 'COUNT(*)'

  return {
    dax:
      `EVALUATE\n` +
      `SUMMARIZECOLUMNS (\n` +
      `    ${daxDims},\n` +
      `    "Value", ${daxValue}\n` +
      `)`,
    sql:
      `SELECT ${sqlDims}, ${sqlValue} AS [Value]\n` +
      `FROM ${sqlObject(g.sqlObject, g.sqlSchema)}\n` +
      `GROUP BY ${sqlDims}\n` +
      `ORDER BY ${sqlDims};`,
    note:
      `${g.measure ? g.measure.model : 'Row count'} by ` +
      `${g.dimensions.map((d) => d.model).join(' ▸ ')}.`,
  }
}
