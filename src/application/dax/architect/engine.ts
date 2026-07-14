// @ts-nocheck
/* eslint-disable */
/**
 * DAX Architect Engine — deterministic, measure-branching DAX compiler.
 * Ported verbatim (MIT) and module-ified for Power BI Studio. See
 * `architect.ts` for the adapter that bridges it to the SemanticModel.
 */
function __engine() {
  'use strict';

  // ==========================================
  // 1. FORMATTER & UTILITIES
  // ==========================================
  const Formatter = (function() {
  //  UTILITIES
  // ════════════════════════════════════════════════════════════

  function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function wordsOf(s) { return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean); }

  function scoreMatch(word, hints) {
    const w = norm(word);
    for (const h of hints) {
      if (w === h) return 3;
      if (w.includes(h) || h.includes(w)) return 2;
    }
    return 0;
  }

  function daxCol(table, column) { return `'${table}'[${column}]`; }

  function daxMeasureRef(name) { return `[${name}]`; }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function titleCase(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }

  function uniqueName(base, existing) {
    if (!existing.has(base)) return base;
    let i = 2;
    while (existing.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  // ════════════════════════════════════════════════════════════

    return { norm, daxCol, daxMeasureRef, uniqueName, wordsOf, capitalize, titleCase, scoreMatch };
  })();

  //  CONSTANTS
  // ════════════════════════════════════════════════════════════

  const NUMERIC_TYPES = new Set(['Whole Number', 'Decimal Number', 'Fixed Decimal (Currency)']);
  const CURRENCY_TYPES = new Set(['Fixed Decimal (Currency)', 'Decimal Number']);
  const DATE_TYPES = new Set(['Date', 'DateTime']);

  const REVENUE_HINTS = ['amount', 'revenue', 'sales', 'income', 'turnover', 'price', 'value', 'total', 'proceeds', 'gross'];
  const COST_HINTS = ['cost', 'expense', 'cogs', 'spending', 'expenditure', 'charge', 'fee', 'outlay', 'deduction', 'discount'];
  const QUANTITY_HINTS = ['quantity', 'qty', 'units', 'count', 'volume', 'items', 'pieces', 'number'];
  const PROFIT_HINTS = ['profit', 'margin', 'earnings', 'net', 'gain', 'surplus'];
  const BUDGET_HINTS = ['budget', 'target', 'forecast', 'plan', 'planned', 'goal', 'quota'];

  // Per-generation state: user column overrides (role → {table, column}) and a
  // log of which columns the engine resolved for each semantic role, so the UI
  // can show them and let the user correct a wrong guess.
  let _overrides = {};
  let _resolvedLog = [];

  function logResolved(role, col) {
    if (!col) return;
    if (_resolvedLog.some(r => r.role === role)) return; // first resolution per role wins
    _resolvedLog.push({ role, table: col.table, column: col.column });
  }

  // ════════════════════════════════════════════════════════════

  const norm = Formatter.norm;
  const daxCol = Formatter.daxCol;
  const daxMeasureRef = Formatter.daxMeasureRef;
  const wordsOf = Formatter.wordsOf;
  const capitalize = Formatter.capitalize;
  const titleCase = Formatter.titleCase;
  const uniqueName = Formatter.uniqueName;
  const scoreMatch = Formatter.scoreMatch;

  // ==========================================
  // 2. SCHEMA RESOLVER
  // ==========================================
  const SchemaResolver = (function() {
  //  MODEL ANALYSIS
  // ════════════════════════════════════════════════════════════

  function buildModel(rawTables, rawRelationships) {
    const tables = rawTables.map(t => ({
      name: (t.name || 'Table').trim(),
      columns: (t.columns || []).filter(c => c.name && c.name.trim()).map(c => ({
        name: c.name.trim(),
        type: c.type,
        isNumeric: NUMERIC_TYPES.has(c.type),
        isCurrency: CURRENCY_TYPES.has(c.type),
        isDate: DATE_TYPES.has(c.type),
      })),
    }));

    const relationships = parseRelationships(rawRelationships, tables);

    return { tables, relationships };
  }

  function parseRelationships(text, tables) {
    if (!text || !text.trim()) return [];
    void tables;
    const rels = [];
    for (const line of text.split('\n')) {
      const m = line.match(/['"]?([\w .\/-]+?)['"]?\[([\w .\/-]+?)\]\s*[→>-]+\s*['"]?([\w .\/-]+?)['"]?\[([\w .\/-]+?)\]/i);
      if (!m) continue;
      const lower = line.toLowerCase();
      // Detect the actual cardinality from the line text (default many-to-one).
      let type = 'many-to-one';
      if (/many[\s-]*to[\s-]*many|\*\s*:\s*\*/.test(lower)) type = 'many-to-many';
      else if (/one[\s-]*to[\s-]*many|\b1\s*:\s*(\*|many|n)\b/.test(lower)) type = 'one-to-many';
      else if (/one[\s-]*to[\s-]*one|\b1\s*:\s*1\b/.test(lower)) type = 'one-to-one';
      else if (/many[\s-]*to[\s-]*one|(\*|many|n)\s*:\s*1\b/.test(lower)) type = 'many-to-one';
      // Inactive relationships are drawn as dashed lines in Power BI.
      const inactive = /\binactive\b|dashed|\(i\)/.test(lower);
      rels.push({ fromTable: m[1], fromCol: m[2], toTable: m[3], toCol: m[4], type, inactive });
    }
    return rels;
  }

  function findDateInfo(model) {
    const dateTableNames = ['date', 'calendar', 'dimdate', 'dim_date', 'dates', 'time', 'period'];
    // Prefer a dedicated date dimension table
    for (const t of model.tables) {
      if (dateTableNames.some(d => norm(t.name) === d || norm(t.name).includes(d))) {
        const dateCol = t.columns.find(c => c.isDate);
        if (dateCol) return { table: t.name, column: dateCol.name, isDedicatedTable: true };
      }
    }
    // Fallback: any table with a date column (prefer fact tables)
    for (const t of model.tables) {
      const dateCol = t.columns.find(c => c.isDate);
      if (dateCol) return { table: t.name, column: dateCol.name, isDedicatedTable: false };
    }
    return null;
  }

  function findFactTable(model) {
    // The fact table is typically the one with the most numeric columns
    let best = null, bestScore = -1;
    for (const t of model.tables) {
      const numericCount = t.columns.filter(c => c.isNumeric).length;
      if (numericCount > bestScore) { best = t; bestScore = numericCount; }
    }
    return best;
  }

  // ── Relationship graph & path validation ──

  function relationshipsBetween(model, a, b) {
    return model.relationships.filter(r =>
      (norm(r.fromTable) === norm(a) && norm(r.toTable) === norm(b)) ||
      (norm(r.fromTable) === norm(b) && norm(r.toTable) === norm(a)));
  }

  /** BFS over ACTIVE relationships (undirected) — is there a filter path between two tables? */
  function pathExists(model, a, b) {
    if (!a || !b || norm(a) === norm(b)) return true;
    const adj = new Map();
    const add = (x, y) => { if (!adj.has(x)) adj.set(x, []); adj.get(x).push(y); };
    for (const r of model.relationships) {
      if (r.inactive) continue;
      add(norm(r.fromTable), norm(r.toTable));
      add(norm(r.toTable), norm(r.fromTable));
    }
    const goal = norm(b);
    const seen = new Set([norm(a)]);
    const queue = [norm(a)];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === goal) return true;
      for (const nb of (adj.get(cur) || [])) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
    }
    return false;
  }

  function userelExpr(r) {
    return `USERELATIONSHIP(${daxCol(r.fromTable, r.fromCol)}, ${daxCol(r.toTable, r.toCol)})`;
  }

  /**
   * Validate the fact↔date relationship for time intelligence.
   * Returns a USERELATIONSHIP filter string to inject (only when the connecting
   * relationship is INACTIVE), and pushes any warnings/hints into `notes`.
   */
  function checkTimeIntelRelationship(model, aggCol, dateInfo, notes) {
    if (!aggCol || !dateInfo || norm(aggCol.table) === norm(dateInfo.table)) return null;
    const between = relationshipsBetween(model, aggCol.table, dateInfo.table);

    if (between.length === 0) {
      if (!pathExists(model, aggCol.table, dateInfo.table)) {
        notes.push(`⚠ No active relationship connects '${aggCol.table}' to the date table '${dateInfo.table}'. Time intelligence needs the fact table related to the date table — create a relationship from '${aggCol.table}'[<date column>] to ${daxCol(dateInfo.table, dateInfo.column)}.`);
      }
      return null;
    }

    const active = between.filter(r => !r.inactive);
    if (active.length === 0) {
      // Only inactive relationship(s) connect them → activate one for this calc.
      notes.push(`The relationship between '${aggCol.table}' and '${dateInfo.table}' is INACTIVE — the time-intelligence measures below wrap CALCULATE with USERELATIONSHIP to activate it for this calculation.`);
      return userelExpr(between[0]);
    }
    if (between.length > 1) {
      notes.push(`Multiple relationships exist between '${aggCol.table}' and '${dateInfo.table}' (e.g. order date vs. ship date). Only the active one is used by default — add USERELATIONSHIP('${aggCol.table}'[<column>], ${daxCol(dateInfo.table, dateInfo.column)}) inside CALCULATE to use a different one.`);
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════

  //  COLUMN RESOLUTION
  // ════════════════════════════════════════════════════════════

  /** Find the best column matching a semantic role */
  function resolveColumn(model, role, preferTable, exclude) {
    // User override wins outright
    if (_overrides[role]) {
      const o = _overrides[role];
      const t = model.tables.find(x => norm(x.name) === norm(o.table));
      const c = t && t.columns.find(x => norm(x.name) === norm(o.column));
      if (c) {
        const col = { table: t.name, column: c.name, type: c.type };
        logResolved(role, col);
        return col;
      }
    }
    const excSet = new Set((exclude || []).map(e => `${e.table}.${e.column}`));
    const hints = {
      revenue: REVENUE_HINTS,
      cost: COST_HINTS,
      quantity: QUANTITY_HINTS,
      profit: PROFIT_HINTS,
      budget: BUDGET_HINTS,
    }[role] || [];

    let candidates = [];

    for (const t of model.tables) {
      for (const c of t.columns) {
        if (excSet.has(`${t.name}.${c.name}`)) continue;
        if (!c.isNumeric && role !== 'category' && role !== 'date') continue;
        if (role === 'date' && !c.isDate) continue;
        if (role === 'category' && c.isNumeric) continue;

        let score = 0;
        // Column name match
        for (const h of hints) {
          const cn = norm(c.name);
          if (cn === h) { score += 10; break; }
          if (cn.includes(h)) { score += 6; break; }
        }
        // Table preference
        if (preferTable && norm(t.name) === norm(preferTable)) score += 3;
        // Currency columns preferred for revenue/cost
        if ((role === 'revenue' || role === 'cost') && c.isCurrency) score += 2;
        // Table name hints (e.g., 'Sales' table for revenue)
        if (role === 'revenue' && REVENUE_HINTS.some(h => norm(t.name).includes(h))) score += 2;
        if (role === 'cost' && COST_HINTS.some(h => norm(t.name).includes(h))) score += 2;

        if (score > 0 || hints.length === 0) {
          candidates.push({ table: t.name, column: c.name, type: c.type, score });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const winner = candidates.length > 0 ? candidates[0] : null;
    if (winner && (hints.length > 0)) logResolved(role, winner);
    return winner;
  }

  /** Find column by explicit name mentioned in text */
  function findColumnByName(model, word) {
    const w = norm(word);
    for (const t of model.tables) {
      for (const c of t.columns) {
        if (norm(c.name) === w) return { table: t.name, column: c.name, type: c.type };
      }
    }
    return null;
  }

  /** Find the best numeric column for aggregation, given text context */
  function resolveAggColumn(model, text) {
    if (_overrides.value) {
      const o = _overrides.value;
      const t = model.tables.find(x => norm(x.name) === norm(o.table));
      const c = t && t.columns.find(x => norm(x.name) === norm(o.column));
      if (c) {
        const col = { table: t.name, column: c.name, type: c.type };
        logResolved('value', col);
        return col;
      }
    }
    const winner = resolveAggColumnInner(model, text);
    if (winner) logResolved('value', winner);
    return winner;
  }

  function resolveAggColumnInner(model, text) {
    const words = wordsOf(text);
    // Try explicit column name matches first
    const exactMatches = [];
    for (const w of words) {
      const col = findColumnByName(model, w);
      if (col && NUMERIC_TYPES.has(col.type)) {
        exactMatches.push(col);
      }
    }
    if (exactMatches.length > 0) {
      // Score them: prefer currency, penalize date-related names
      for (const m of exactMatches) {
        m._score = CURRENCY_TYPES.has(m.type) ? 10 : 0;
        const dateNames = ['year', 'month', 'day', 'quarter', 'date', 'id', 'key'];
        if (dateNames.includes(norm(m.column))) m._score -= 20;
        if (norm(m.column).includes('key') || norm(m.column).includes('id')) m._score -= 20;
      }
      exactMatches.sort((a, b) => b._score - a._score);
      if (exactMatches[0]._score >= 0) return exactMatches[0];
    }
    // Try semantic role matching
    for (const w of words) {
      if (scoreMatch(w, REVENUE_HINTS) > 0) {
        const col = resolveColumn(model, 'revenue');
        if (col) return col;
      }
      if (scoreMatch(w, COST_HINTS) > 0) {
        const col = resolveColumn(model, 'cost');
        if (col) return col;
      }
      if (scoreMatch(w, QUANTITY_HINTS) > 0) {
        const col = resolveColumn(model, 'quantity');
        if (col) return col;
      }
    }
    // Fallback: first currency column, then first numeric column
    for (const t of model.tables) {
      const curr = t.columns.find(c => c.isCurrency);
      if (curr) return { table: t.name, column: curr.name, type: curr.type };
    }
    for (const t of model.tables) {
      const num = t.columns.find(c => c.isNumeric);
      if (num) return { table: t.name, column: num.name, type: num.type };
    }
    return null;
  }

  /** Find a grouping/category column from text */
  function resolveGroupBy(model, text) {
    if (!text) return null;
    const words = wordsOf(text);
    // Try exact column name match
    for (const w of words) {
      const col = findColumnByName(model, w);
      if (col) return col;
    }
    // Try partial match
    for (const t of model.tables) {
      for (const c of t.columns) {
        for (const w of words) {
          if (norm(c.name).includes(norm(w)) || norm(w).includes(norm(c.name))) {
            return { table: t.name, column: c.name };
          }
        }
      }
    }
    // Try table name match → first text column
    for (const t of model.tables) {
      for (const w of words) {
        if (norm(t.name).includes(norm(w))) {
          const textCol = t.columns.find(c => !c.isNumeric && !c.isDate);
          if (textCol) return { table: t.name, column: textCol.name };
        }
      }
    }
    return null;
  }

  // ════════════════════════════════════════════════════════════

    return { buildModel, checkTimeIntelRelationship, pathExists, findDateInfo, findFactTable, findColumnByName, resolveColumn, resolveAggColumn, resolveGroupBy };
  })();
  const buildModel = SchemaResolver.buildModel;
  const findDateInfo = SchemaResolver.findDateInfo;
  const findFactTable = SchemaResolver.findFactTable;
  const findColumnByName = SchemaResolver.findColumnByName;
  const resolveColumn = SchemaResolver.resolveColumn;
  const resolveAggColumn = SchemaResolver.resolveAggColumn;
  const resolveGroupBy = SchemaResolver.resolveGroupBy;

  // ==========================================
  // 3. RELATIONSHIP ENGINE
  // ==========================================
  const RelationshipEngine = {
    checkTimeIntelRelationship: SchemaResolver.checkTimeIntelRelationship,
    pathExists: SchemaResolver.pathExists
  };
  const pathExists = RelationshipEngine.pathExists;
  const checkTimeIntelRelationship = RelationshipEngine.checkTimeIntelRelationship;

  // ==========================================
  // 4. INTENT PARSER
  // ==========================================
  const IntentParser = (function() {
  //  REQUIREMENT PARSING
  // ════════════════════════════════════════════════════════════

  function splitRequirement(text) {
    // Split compound requirements but preserve "revenue and cost" type phrases
    let parts = [];
    // Split on explicit separators
    const sentences = text.split(/(?:;\s*|\.\s+|\n+)/);
    for (const sentence of sentences) {
      // Split on ", and " or " and also " or ", also " but not "X and Y" column pairs
      const subParts = sentence.split(/,\s*and\s+(?:also\s+)?|,\s*also\s+|\s+and\s+also\s+/i);
      if (subParts.length > 1) {
        parts.push(...subParts);
      } else {
        // Try splitting on " and " only if both sides look like complete phrases
        const andSplit = sentence.split(/\s+and\s+/i);
        if (andSplit.length === 2 && andSplit[0].split(/\s+/).length > 3 && andSplit[1].split(/\s+/).length > 3) {
          parts.push(...andSplit);
        } else {
          parts.push(sentence);
        }
      }
    }
    return parts.map(p => p.trim()).filter(Boolean);
  }

  function extractModifiers(text) {
    const byMatch = text.match(/\bby\s+(.+?)(?:\s*$|\s*,|\s+and\s+|\s+with\s+)/i);
    const groupBy = byMatch ? byMatch[1].replace(/\b(each|every|individual|per)\b/gi, '').trim() : null;
    return { groupBy };
  }

  // ════════════════════════════════════════════════════════════

    return { splitRequirement, extractModifiers, wordsOf };
  })();
  const splitRequirement = IntentParser.splitRequirement;
  const extractModifiers = IntentParser.extractModifiers;

  // ── Filter-clause extraction ──
  // Pulls explicit filter clauses out of a requirement ("for West region",
  // "where Status = Completed", "in 2024") so the remaining text routes to the
  // right pattern and the result is wrapped in a filtered CALCULATE.
  const FILTER_VALUE_STOPWORDS = new Set([
    'the', 'a', 'an', 'each', 'every', 'all', 'my', 'our', 'this', 'that',
    'year', 'quarter', 'month', 'week', 'day', 'date', 'time', 'period',
    'sales', 'revenue', 'total', 'growth', 'margin', 'profit', 'cost',
    'average', 'rate', 'count', 'sum', 'amount', 'value', 'order', 'orders',
  ]);

  function extractFilters(text, model) {
    const filters = [];
    const notes = [];
    let cleaned = text;

    const columnFor = (word) => {
      if (!word) return null;
      const exact = findColumnByName(model, word);
      if (exact) return exact;
      for (const t of model.tables) {
        for (const c of t.columns) {
          if (!c.isDate && norm(c.name).includes(norm(word))) {
            return { table: t.name, column: c.name, type: c.type };
          }
        }
      }
      return null;
    };
    const fmtValue = (col, value) =>
      (NUMERIC_TYPES.has(col.type) && /^\d+(\.\d+)?$/.test(value)) ? value : `"${value}"`;

    // 1) "where <col> = <value>" / "where <col> is <value>"
    cleaned = cleaned.replace(
      /\bwhere\s+([A-Za-z_][\w ]*?)\s*(?:=|\bis\b|\bequals?\b)\s*['"“]?([\w][\w .-]*?)['"”]?(?=\s*(?:$|,|;|\band\b))/gi,
      (m, colWord, value) => {
        const col = columnFor(colWord.trim());
        if (col) { filters.push({ table: col.table, column: col.column, value: fmtValue(col, value.trim()) }); return ' '; }
        notes.push(`Could not match “${colWord.trim()}” to a model column for the filter “${m.trim()}”.`);
        return ' ';
      });

    // 2) "in <4-digit year>" → Year column filter
    cleaned = cleaned.replace(/\bin\s+((?:19|20)\d{2})\b/gi, (m, year) => {
      for (const t of model.tables) {
        const c = t.columns.find(x => x.isNumeric && norm(x.name).includes('year'));
        if (c) { filters.push({ table: t.name, column: c.name, value: year }); return ' '; }
      }
      notes.push(`Found a year filter (${year}) but no numeric Year column in the model — add one to your date table.`);
      return ' ';
    });

    // 3) "for <value> <col>" or "for <col> <value>" — exactly one token must be a column
    cleaned = cleaned.replace(/\b(?:for|in)\s+([A-Za-z][\w.-]*)\s+([A-Za-z][\w.-]*)\b/gi, (m, w1, w2) => {
      const c1 = columnFor(w1), c2 = columnFor(w2);
      if (c2 && !c1 && !FILTER_VALUE_STOPWORDS.has(w1.toLowerCase())) {
        filters.push({ table: c2.table, column: c2.column, value: fmtValue(c2, w1) });
        return ' ';
      }
      if (c1 && !c2 && !FILTER_VALUE_STOPWORDS.has(w2.toLowerCase())) {
        filters.push({ table: c1.table, column: c1.column, value: fmtValue(c1, w2) });
        return ' ';
      }
      return m; // ambiguous / no column match → leave for the pattern router
    });

    return { filters, notes, cleaned: cleaned.replace(/\s{2,}/g, ' ').trim() };
  }
  

  // ==========================================
  // 5. PATTERN REGISTRY
  // ==========================================
  const PatternRegistry = (function() {
  //  PATTERN DETECTION
  // ════════════════════════════════════════════════════════════

  const R = {
    profitMargin: /\b(profit\s*margin|margin\s*%|margin\s+percent|profitability)\b/i,
    profit: /\b(profit|earnings|net\s+income|gross\s+profit)\b/i,
    margin: /\b(margin)\b/i,
    yoy: /\b(year[\s-]*over[\s-]*year|yoy|year[\s-]*on[\s-]*year|annual[\s-]*growth|yearly[\s-]*growth|compared?\s+to\s+(last|previous|prior)\s+year)\b/i,
    qoq: /\b(quarter[\s-]*over[\s-]*quarter|qoq|quarterly[\s-]*growth)\b/i,
    mom: /\b(month[\s-]*over[\s-]*month|mom|monthly[\s-]*growth)\b/i,
    wow: /\b(week[\s-]*over[\s-]*week|wow|weekly[\s-]*growth)\b/i,
    growth: /\b(growth|change|increase|decrease|variance|delta|difference|vs\.?|versus|compared?)\b/i,
    ytd: /\b(year[\s-]*to[\s-]*date|ytd)\b/i,
    qtd: /\b(quarter[\s-]*to[\s-]*date|qtd)\b/i,
    mtd: /\b(month[\s-]*to[\s-]*date|mtd)\b/i,
    prevYear: /\b(previous\s+year|last\s+year|prior\s+year|py|ly)\b/i,
    prevQuarter: /\b(previous\s+quarter|last\s+quarter|prior\s+quarter|pq|lq)\b/i,
    prevMonth: /\b(previous\s+month|last\s+month|prior\s+month|pm|lm)\b/i,
    pctOfTotal: /(%\s*of\s*(?:grand\s*)?total|\b(?:percent|percentage|pct)\s*of\s*(?:grand\s*)?total\b|\bshare\b|\bcontribution\b|\bproportion\b|\bdistribution\b)/i,
    rank: /\b(rank|ranking|top\s*\d*|bottom\s*\d*|position|leaderboard)\b/i,
    topN: /\btop\s+(\d+)\b/i,
    variance: /\b(budget|target|forecast|plan(?:ned)?|goal|quota)\b/i,
    varianceContext: /\b(vs\.?|versus|against|variance|attainment|achievement|actual|compared?)\b/i,
    runningTotal: /\b(running\s*total|cumulative|running\s*sum|accumulated)\b/i,
    movingAvg: /\b(moving\s*avg|moving\s*average|rolling\s*avg|rolling\s*average|trailing\s*average)\b/i,
    rollingPeriod: /\b(?:previous|prior|last|past|trailing|rolling)\s+(\d+)\s*(day|week|month|quarter|year)s?\b/i,
    distinctCount: /\b(unique|distinct|different)\s*(count|number|#|customers?|products?|items?|orders?|transactions?)\b/i,
    iterator: /\b(sumx|multiply\s+and\s+sum|total\s+by\s+row|row\s+by\s+row|product\s+sum|sum\s+product|iterator)\b/i,
    countOf: /\b(count\s+of|number\s+of|how\s+many|total\s+number)\b/i,
    count: /\b(count|tally)\b/i,
    average: /\b(average|avg|mean|per\s+order|per\s+transaction|per\s+customer|per\s+unit)\b/i,
    min: /\b(minimum|min|lowest|smallest|least)\b/i,
    max: /\b(maximum|max|highest|largest|biggest|greatest|top)\b/i,
    sum: /\b(total|sum|overall|aggregate|combined|gross)\b/i,
    percentage: /(%|percent|pct|ratio|rate)\b/i,
    conversionRate: /\b(conversion\s*rate|hit\s*rate|success\s*rate|win\s*rate)\b/i,
    weightedAvg: /\b(weighted\s*average|weighted\s*avg|weighted\s*mean)\b/i,
    dateTable: /\b(date\s*table|calendar\s*table|create\s*date|generate\s*date|dim\s*date)\b/i,
    bucket: /\b(bucket|tier|band|range|group|classify|classification|segmentation|bin)\b/i,
    offset: /\b(offset|previous\s*row|next\s*row|lead|lag)\b/i,
    window: /\b(window|rolling\s*window|visual\s*running|visual\s*moving)\b/i,
    index: /\b(index|first\s*row|last\s*row|nth\s*row)\b/i,
    // Advanced entity / balance / threshold patterns
    churn: /\b(churn(ed)?|attrition|lost\s+customers?|customers?\s+(who\s+)?(left|lost|stopped|churned))\b/i,
    retention: /\b(retention|retained|repeat\s+customers?|returning\s+customers?)\b/i,
    newCustomers: /\b(new\s+(customers?|clients?|users?|accounts?|members?|subscribers?)|first[\s-]*time\s+(customers?|buyers?|users?)|newly\s+acquired|customer\s+acquisition|acquired\s+customers?)\b/i,
    closingBalance: /\b(closing\s+balance|ending\s+balance|end[\s-]*of[\s-]*(period|month|day)|on[\s-]*hand|inventory\s+(on\s+hand|balance|level|position)|stock\s+(on\s+hand|level))\b/i,
    openingBalance: /\b(opening\s+balance|beginning\s+balance|start[\s-]*of[\s-]*(period|month|day)|opening\s+stock)\b/i,
    lifetimeValue: /\b(lifetime\s+value|customer\s+lifetime|clv|ltv|value\s+per\s+customer|revenue\s+per\s+customer|spend\s+per\s+customer)\b/i,
    cumulativeDistinct: /\b(cumulative|running)\s+(distinct|unique|customers?|users?|count)\b|\b(distinct|unique)\s+\w+\s+to\s+date\b/i,
    basket: /\b(basket\s+size|average\s+order\s+value|avg\s+order\s+value|\baov\b|items?\s+per\s+(order|transaction|basket|visit)|units?\s+per\s+(order|transaction))\b/i,
    threshold: /\b(more than|greater than|at least|no less than|fewer than|less than|at most|over|above|under|below)\s+\d+|[<>]=?\s*\d+/i,
  };

  // ════════════════════════════════════════════════════════════

    return { R };
  })();
  const R = PatternRegistry.R;

  // ==========================================
  // 6. DAX GENERATOR (steps double as the dependency graph via `dependsOn`)
  // ==========================================
  const DAXGenerator = (function() {
  //  PATTERN HANDLERS
  //  Each returns { steps[], finalName, notes[], tipFragment }
  // ════════════════════════════════════════════════════════════

  function makeStep(num, title, objectType, createNew, name, reason, dax, deps) {
    return { stepNumber: num, title, objectType, createNew, name, reason, dax, dependsOn: deps || [] };
  }

  /** Build a CALCULATE with a base ref + one or more filter/modifier args (blanks skipped). */
  function wrapCalculate(baseRef, filters) {
    return `CALCULATE(\n    ${baseRef},\n    ${filters.filter(Boolean).join(',\n    ')}\n)`;
  }

  // --- Helper: ensure a base SUM measure exists ---
  function ensureSumMeasure(steps, col, label, model) {
    const name = label || `Total ${capitalize(col.column)}`;
    const existing = steps.find(s => s.name === name);
    if (existing) return name;
    steps.push(makeStep(0, `Calculate ${name}`, 'Measure', true, name,
      `Aggregates '${col.table}'[${col.column}] — base measure needed for further calculations.`,
      `SUM(${daxCol(col.table, col.column)})`, []));
    return name;
  }

  // --- PROFIT MARGIN % ---
  function handleProfitMargin(model, text, steps) {
    const revCol = resolveColumn(model, 'revenue');
    const costCol = resolveColumn(model, 'cost', revCol ? revCol.table : null, revCol ? [revCol] : []);
    const notes = [];

    if (!revCol) { notes.push('Could not identify a revenue/sales column — using the first numeric column.'); }
    if (!costCol) { notes.push('Could not identify a cost/expense column. Showing margin as 100% placeholder.'); }

    const effRev = revCol || resolveAggColumn(model, text);
    if (!effRev) return null;

    const revName = ensureSumMeasure(steps, effRev, `Total ${guessLabel(effRev, 'Sales')}`, model);

    if (costCol) {
      const costName = ensureSumMeasure(steps, costCol, `Total ${guessLabel(costCol, 'Cost')}`, model);
      const profitName = uniqueName('Total Profit', new Set(steps.map(s => s.name)));
      steps.push(makeStep(0, 'Calculate Total Profit', 'Measure', true, profitName,
        'Derived measure: revenue minus cost. Created as a standalone measure so it can be reused.',
        `${daxMeasureRef(revName)} - ${daxMeasureRef(costName)}`,
        [revName, costName]));
      const marginName = uniqueName('Profit Margin %', new Set(steps.map(s => s.name)));
      steps.push(makeStep(0, 'Calculate Profit Margin %', 'Measure', true, marginName,
        'Ratio of profit to revenue, using DIVIDE to safely handle division by zero.',
        `DIVIDE(${daxMeasureRef(profitName)}, ${daxMeasureRef(revName)})`,
        [profitName, revName]));
      return { finalName: marginName, notes, tipFragment: `Use ${marginName} as a value in a card, bar chart, or matrix.` };
    } else {
      return { finalName: revName, notes, tipFragment: '' };
    }
  }

  // --- SIMPLE PROFIT (no margin) ---
  function handleProfit(model, text, steps) {
    const revCol = resolveColumn(model, 'revenue');
    const costCol = resolveColumn(model, 'cost', revCol ? revCol.table : null, revCol ? [revCol] : []);
    if (!revCol || !costCol) return null;

    const revName = ensureSumMeasure(steps, revCol, `Total ${guessLabel(revCol, 'Sales')}`, model);
    const costName = ensureSumMeasure(steps, costCol, `Total ${guessLabel(costCol, 'Cost')}`, model);

    const profitName = uniqueName('Total Profit', new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, 'Calculate Total Profit', 'Measure', true, profitName,
      'Derived measure: revenue minus cost.',
      `${daxMeasureRef(revName)} - ${daxMeasureRef(costName)}`,
      [revName, costName]));
    return { finalName: profitName, notes: [], tipFragment: `Use ${profitName} as a card or value in any visual.` };
  }

  // --- YEAR-OVER-YEAR GROWTH % ---
  function handleYoYGrowth(model, text, steps) {
    const notes = [];
    const dateInfo = findDateInfo(model);
    if (!dateInfo) {
      notes.push('⚠ No date column found in the model. Time intelligence requires a date column (ideally a dedicated Date/Calendar dimension table marked as a date table in Power BI).');
    }
    if (dateInfo && !dateInfo.isDedicatedTable) {
      notes.push(`Using ${daxCol(dateInfo.table, dateInfo.column)} for time intelligence. For best results, create a dedicated Date dimension table and mark it as a date table in Power BI.`);
    }

    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const existingNames = new Set(steps.map(s => s.name));

    if (dateInfo) {
      const userel = checkTimeIntelRelationship(model, aggCol, dateInfo, notes);
      const pyName = uniqueName(`${guessLabel(aggCol, 'Sales')} PY`, existingNames);
      steps.push(makeStep(0, `Calculate ${guessLabel(aggCol, 'Sales')} Previous Year`, 'Measure', true, pyName,
        'Uses SAMEPERIODLASTYEAR to shift the date filter context back by one full year.',
        wrapCalculate(daxMeasureRef(baseName), [`SAMEPERIODLASTYEAR(${daxCol(dateInfo.table, dateInfo.column)})`, userel]),
        [baseName]));
      existingNames.add(pyName);

      const growthName = uniqueName(`${guessLabel(aggCol, 'Sales')} YoY Growth %`, existingNames);
      steps.push(makeStep(0, 'Calculate Year-over-Year Growth %', 'Measure', true, growthName,
        'Compares current period to the same period last year using DIVIDE for safe division.',
        `VAR _Current = ${daxMeasureRef(baseName)}\nVAR _PriorYear = ${daxMeasureRef(pyName)}\nRETURN\n    DIVIDE(\n        _Current - _PriorYear,\n        _PriorYear\n    )`,
        [baseName, pyName]));
      return { finalName: growthName, notes, tipFragment: 'Use a line chart with dates on the axis to visualize the trend.' };
    } else {
      return { finalName: baseName, notes, tipFragment: '' };
    }
  }

  // --- QUARTER-OVER-QUARTER GROWTH % ---
  function handleQoQGrowth(model, text, steps) {
    const notes = [];
    const dateInfo = findDateInfo(model);
    if (!dateInfo) { notes.push('⚠ No date column found. QoQ analysis requires a date table.'); return null; }
    if (!dateInfo.isDedicatedTable) { notes.push(`Using ${daxCol(dateInfo.table, dateInfo.column)} for time intelligence. A dedicated Date table is recommended.`); }

    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const existingNames = new Set(steps.map(s => s.name));

    const userel = checkTimeIntelRelationship(model, aggCol, dateInfo, notes);
    const pqName = uniqueName(`${guessLabel(aggCol, 'Sales')} PQ`, existingNames);
    steps.push(makeStep(0, 'Calculate Previous Quarter Value', 'Measure', true, pqName,
      'Shifts date filter context back by one quarter using DATEADD.',
      wrapCalculate(daxMeasureRef(baseName), [`DATEADD(${daxCol(dateInfo.table, dateInfo.column)}, -1, QUARTER)`, userel]),
      [baseName]));
    existingNames.add(pqName);

    const growthName = uniqueName(`${guessLabel(aggCol, 'Sales')} QoQ Growth %`, existingNames);
    steps.push(makeStep(0, 'Calculate Quarter-over-Quarter Growth %', 'Measure', true, growthName,
      'Compares current quarter to the previous quarter.',
      `VAR _Current = ${daxMeasureRef(baseName)}\nVAR _PriorQtr = ${daxMeasureRef(pqName)}\nRETURN\n    DIVIDE(_Current - _PriorQtr, _PriorQtr)`,
      [baseName, pqName]));
    return { finalName: growthName, notes, tipFragment: 'Use a column chart grouped by quarter to show QoQ trends.' };
  }

  // --- MONTH-OVER-MONTH GROWTH % ---
  function handleMoMGrowth(model, text, steps) {
    const notes = [];
    const dateInfo = findDateInfo(model);
    if (!dateInfo) { notes.push('⚠ No date column found. MoM analysis requires a date table.'); return null; }
    if (!dateInfo.isDedicatedTable) { notes.push(`Using ${daxCol(dateInfo.table, dateInfo.column)} for time intelligence. A dedicated Date table is recommended.`); }

    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const existingNames = new Set(steps.map(s => s.name));

    const userel = checkTimeIntelRelationship(model, aggCol, dateInfo, notes);
    const pmName = uniqueName(`${guessLabel(aggCol, 'Sales')} PM`, existingNames);
    steps.push(makeStep(0, 'Calculate Previous Month Value', 'Measure', true, pmName,
      'Shifts date filter context back by one month using DATEADD.',
      wrapCalculate(daxMeasureRef(baseName), [`DATEADD(${daxCol(dateInfo.table, dateInfo.column)}, -1, MONTH)`, userel]),
      [baseName]));
    existingNames.add(pmName);

    const growthName = uniqueName(`${guessLabel(aggCol, 'Sales')} MoM Growth %`, existingNames);
    steps.push(makeStep(0, 'Calculate Month-over-Month Growth %', 'Measure', true, growthName,
      'Compares current month to the previous month.',
      `VAR _Current = ${daxMeasureRef(baseName)}\nVAR _PriorMonth = ${daxMeasureRef(pmName)}\nRETURN\n    DIVIDE(_Current - _PriorMonth, _PriorMonth)`,
      [baseName, pmName]));
    return { finalName: growthName, notes, tipFragment: 'Use a line chart with monthly granularity on the axis.' };
  }

  // --- YTD ---
  function handleYTD(model, text, steps) {
    const notes = [];
    const dateInfo = findDateInfo(model);
    if (!dateInfo) { notes.push('⚠ No date column found. YTD requires a date table.'); return null; }
    if (!dateInfo.isDedicatedTable) notes.push(`Using ${daxCol(dateInfo.table, dateInfo.column)} for YTD. A dedicated Date table is recommended.`);

    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const userel = checkTimeIntelRelationship(model, aggCol, dateInfo, notes);
    const ytdName = uniqueName(`${guessLabel(aggCol, 'Sales')} YTD`, new Set(steps.map(s => s.name)));
    const filterArgs = [`DATESYTD(${daxCol(dateInfo.table, dateInfo.column)})`];
    if (userel) filterArgs.push(userel);
    const ytdCore = wrapCalculate(daxMeasureRef(baseName), filterArgs);
    
    steps.push(makeStep(0, 'Calculate Year-to-Date', 'Measure', true, ytdName,
      'Accumulates the base measure from the start of the year using DATESYTD inside CALCULATE.',
      ytdCore,
      [baseName]));
    return { finalName: ytdName, notes, tipFragment: `Use ${ytdName} alongside monthly values to show cumulative progress.` };
  }

  // --- QTD ---
  function handleQTD(model, text, steps) {
    const notes = [];
    const dateInfo = findDateInfo(model);
    if (!dateInfo) return null;

    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const userel = checkTimeIntelRelationship(model, aggCol, dateInfo, notes);
    const qtdName = uniqueName(`${guessLabel(aggCol, 'Sales')} QTD`, new Set(steps.map(s => s.name)));
    const filterArgs = [`DATESQTD(${daxCol(dateInfo.table, dateInfo.column)})`];
    if (userel) filterArgs.push(userel);
    const qtdCore = wrapCalculate(daxMeasureRef(baseName), filterArgs);
    
    steps.push(makeStep(0, 'Calculate Quarter-to-Date', 'Measure', true, qtdName,
      'Accumulates from the start of the quarter using DATESQTD inside CALCULATE.',
      qtdCore,
      [baseName]));
    return { finalName: qtdName, notes, tipFragment: `Use ${qtdName} with a date axis for intra-quarter tracking.` };
  }

  // --- MTD ---
  function handleMTD(model, text, steps) {
    const notes = [];
    const dateInfo = findDateInfo(model);
    if (!dateInfo) return null;

    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const userel = checkTimeIntelRelationship(model, aggCol, dateInfo, notes);
    const mtdName = uniqueName(`${guessLabel(aggCol, 'Sales')} MTD`, new Set(steps.map(s => s.name)));
    const filterArgs = [`DATESMTD(${daxCol(dateInfo.table, dateInfo.column)})`];
    if (userel) filterArgs.push(userel);
    const mtdCore = wrapCalculate(daxMeasureRef(baseName), filterArgs);
    
    steps.push(makeStep(0, 'Calculate Month-to-Date', 'Measure', true, mtdName,
      'Accumulates from the start of the month using DATESMTD inside CALCULATE.',
      mtdCore,
      [baseName]));
    return { finalName: mtdName, notes, tipFragment: `Use ${mtdName} with daily granularity on the axis.` };
  }

  // --- PREVIOUS PERIOD ---
  function handlePreviousPeriod(model, text, steps, periodType) {
    const dateInfo = findDateInfo(model);
    const notes = [];
    if (!dateInfo) { notes.push('⚠ No date column found. Previous period comparisons require a date table.'); return null; }

    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const label = guessLabel(aggCol, 'Sales');

    const fnMap = {
      year: { fn: 'SAMEPERIODLASTYEAR', suffix: 'PY', label: 'Previous Year' },
      quarter: { fn: 'DATEADD', args: '-1, QUARTER', suffix: 'PQ', label: 'Previous Quarter' },
      month: { fn: 'DATEADD', args: '-1, MONTH', suffix: 'PM', label: 'Previous Month' },
    };
    const cfg = fnMap[periodType] || fnMap.year;

    const userel = checkTimeIntelRelationship(model, aggCol, dateInfo, notes);
    const prevName = uniqueName(`${label} ${cfg.suffix}`, new Set(steps.map(s => s.name)));
    const dateFilter = cfg.fn === 'SAMEPERIODLASTYEAR'
      ? `SAMEPERIODLASTYEAR(${daxCol(dateInfo.table, dateInfo.column)})`
      : `DATEADD(${daxCol(dateInfo.table, dateInfo.column)}, ${cfg.args})`;
    const daxExpr = wrapCalculate(daxMeasureRef(baseName), [dateFilter, userel]);

    steps.push(makeStep(0, `Calculate ${cfg.label} Value`, 'Measure', true, prevName,
      `Returns the value of ${daxMeasureRef(baseName)} for the ${cfg.label.toLowerCase()}.`,
      daxExpr, [baseName]));
    return { finalName: prevName, notes, tipFragment: `Compare ${prevName} alongside ${baseName} in a table or chart.` };
  }

  // --- ROLLING "PREVIOUS / LAST N DAYS|WEEKS|MONTHS" (± growth) ---
  // Handles trailing-window requirements like "last 28 days sales" or
  // "previous 28 days growth" — a rolling window, NOT year-over-year.
  function handleRollingPeriod(model, text, steps) {
    const m = text.match(/\b(?:previous|prior|last|past|trailing|rolling)\s+(\d+)\s*(day|week|month|quarter|year)s?\b/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unitWord = m[2].toLowerCase();
    // DATESINPERIOD / DATEADD have no WEEK interval — express weeks as days.
    let periodN = n, periodUnit = unitWord.toUpperCase();
    if (periodUnit === 'WEEK') { periodN = n * 7; periodUnit = 'DAY'; }

    const notes = [];
    const dateInfo = findDateInfo(model);
    if (!dateInfo) { notes.push('⚠ No date column found. A rolling N-period window needs a date column (ideally a marked Date table).'); return null; }

    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;
    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const userel = checkTimeIntelRelationship(model, aggCol, dateInfo, notes);
    const dateRef = daxCol(dateInfo.table, dateInfo.column);
    const label = guessLabel(aggCol, 'Sales');
    const unitLabel = capitalize(unitWord) + 's';
    if (periodUnit !== unitWord.toUpperCase()) notes.push(`Weeks are expressed as ${periodN} days for DATESINPERIOD/DATEADD.`);

    // 1) Trailing window value
    const curName = uniqueName(`${label} Last ${n} ${unitLabel}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Calculate ${label} — last ${n} ${unitWord}s`, 'Measure', true, curName,
      `Sums ${daxMeasureRef(baseName)} over the trailing ${periodN} ${periodUnit.toLowerCase()}s ending on the latest date in context.`,
      wrapCalculate(daxMeasureRef(baseName), [`DATESINPERIOD(${dateRef}, MAX(${dateRef}), -${periodN}, ${periodUnit})`, userel]),
      [baseName]));

    const wantsGrowth = /\b(growth|change|increase|decrease|vs\.?|versus|compared?|delta|variance|difference|trend)\b/i.test(text);
    if (!wantsGrowth) {
      return { finalName: curName, notes, tipFragment: `Use ${curName} in a card; a date slicer moves the trailing window.` };
    }

    // 2) Prior window: shift the whole window back N periods (DATEADD wraps the current measure)
    const prevName = uniqueName(`${label} Prior ${n} ${unitLabel}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Calculate ${label} — prior ${n} ${unitWord}s`, 'Measure', true, prevName,
      `The ${periodN}-${periodUnit.toLowerCase()} window immediately before the current one — DATEADD shifts the trailing window back ${periodN} ${periodUnit.toLowerCase()}s.`,
      wrapCalculate(daxMeasureRef(curName), [`DATEADD(${dateRef}, -${periodN}, ${periodUnit})`, userel]),
      [curName]));

    // 3) Growth %
    const growthName = uniqueName(`${label} ${n}-${capitalize(unitWord)} Growth %`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Calculate ${n}-${unitWord} Growth %`, 'Measure', true, growthName,
      `Compares the last ${periodN} ${periodUnit.toLowerCase()}s to the ${periodN} ${periodUnit.toLowerCase()}s before, using DIVIDE for safe division.`,
      `VAR _Current = ${daxMeasureRef(curName)}\nVAR _Prior = ${daxMeasureRef(prevName)}\nRETURN\n    DIVIDE(_Current - _Prior, _Prior)`,
      [curName, prevName]));
    return { finalName: growthName, notes, tipFragment: `Plot ${growthName} on a card or trend line. Put your product column on the axis to see it per product.` };
  }

  // --- % OF TOTAL ---
  function handlePercentOfTotal(model, text, steps) {
    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const mods = extractModifiers(text);
    const groupCol = mods.groupBy ? resolveGroupBy(model, mods.groupBy) : null;

    const notes = [];
    if (groupCol && norm(groupCol.table) !== norm(aggCol.table) && !pathExists(model, groupCol.table, aggCol.table)) {
      notes.push(`⚠ '${groupCol.table}' is not related to '${aggCol.table}' by an active relationship — "% of total by ${groupCol.column}" won't filter '${aggCol.table}' correctly until you add a relationship.`);
    }

    const pctName = uniqueName(`% of Total ${guessLabel(aggCol, 'Sales')}`, new Set(steps.map(s => s.name)));
    const isVisualShare = /\b(visual|selected|current)\b/i.test(text);
    const allExpr = isVisualShare
      ? (groupCol ? `ALLSELECTED('${groupCol.table}'[${groupCol.column}])` : `ALLSELECTED('${aggCol.table}')`)
      : (groupCol ? `REMOVEFILTERS('${groupCol.table}'[${groupCol.column}])` : `REMOVEFILTERS('${aggCol.table}')`);
      
    steps.push(makeStep(0, 'Calculate % of Total', 'Measure', true, pctName,
      `Divides the filtered value by the denominator. Uses ${isVisualShare ? 'ALLSELECTED to respect outside slicers' : 'REMOVEFILTERS to clear filters'}.`,
      `DIVIDE(\n    ${daxMeasureRef(baseName)},\n    CALCULATE(${daxMeasureRef(baseName)}, ${allExpr})\n)`,
      [baseName]));
    return { finalName: pctName, notes, tipFragment: `Format ${pctName} as a percentage. Use in a bar or pie chart.` };
  }

  // --- RANK ---
  function handleRank(model, text, steps) {
    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const mods = extractModifiers(text);
    const groupCol = mods.groupBy ? resolveGroupBy(model, mods.groupBy) : null;

    // Determine rank table — prefer a dimension table
    let rankTable = groupCol ? groupCol.table : null;
    if (!rankTable) {
      for (const t of model.tables) {
        if (t.columns.some(c => !c.isNumeric && !c.isDate)) {
          rankTable = t.name;
          break;
        }
      }
    }
    if (!rankTable) rankTable = model.tables[0].name;

    const notes = [];
    if (rankTable && aggCol && norm(rankTable) !== norm(aggCol.table) && !pathExists(model, rankTable, aggCol.table)) {
      notes.push(`⚠ '${rankTable}' is not related to '${aggCol.table}' by an active relationship — RANKX may not evaluate ${daxMeasureRef(baseName)} per '${rankTable}' row correctly until you add a relationship.`);
    }

    const rankName = uniqueName(`${guessLabel(aggCol, 'Sales')} Rank`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, 'Calculate Rank', 'Measure', true, rankName,
      `Ranks rows by ${daxMeasureRef(baseName)} in descending order using RANKX. Uses ALLSELECTED to respect visual-level filters.`,
      `RANKX(\n    ALLSELECTED('${rankTable}'),\n    ${daxMeasureRef(baseName)},\n    ,\n    DESC,\n    DENSE\n)`,
      [baseName]));
    return { finalName: rankName, notes, tipFragment: `Add ${rankName} to a table visual alongside the dimension to see rankings.` };
  }

  // --- RUNNING TOTAL ---
  function handleRunningTotal(model, text, steps) {
    const dateInfo = findDateInfo(model);
    const notes = [];
    if (!dateInfo) { notes.push('⚠ No date column found. Running total typically needs a date axis.'); }

    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);

    if (dateInfo) {
      const userel = checkTimeIntelRelationship(model, aggCol, dateInfo, notes);
      const rtFilters = [`DATESBETWEEN(\n            ${daxCol(dateInfo.table, dateInfo.column)},\n            BLANK(),\n            MAX(${daxCol(dateInfo.table, dateInfo.column)})\n        )`];
      if (userel) rtFilters.push(userel);
      const rtName = uniqueName(`Running Total ${guessLabel(aggCol, 'Sales')}`, new Set(steps.map(s => s.name)));
      steps.push(makeStep(0, 'Calculate Running Total', 'Measure', true, rtName,
        'Accumulates the measure from the earliest date in the model up to the current date in context using DATESBETWEEN.',
        wrapCalculate(daxMeasureRef(baseName), rtFilters),
        [baseName]));
      return { finalName: rtName, notes, tipFragment: `Plot ${rtName} on a line chart with dates on the axis.` };
    } else {
      return { finalName: baseName, notes, tipFragment: '' };
    }
  }

  // --- MOVING AVERAGE ---
  function handleMovingAverage(model, text, steps) {
    const notes = [];
    const dateInfo = findDateInfo(model);
    if (!dateInfo) return null;

    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;
    checkTimeIntelRelationship(model, aggCol, dateInfo, notes);

    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    // Extract period from text (e.g., "3-month", "7-day", "4-week")
    const periodMatch = text.match(/(\d+)[\s-]*(day|week|month|quarter|year)/i);
    const periodNum = periodMatch ? parseInt(periodMatch[1]) : 3;
    const periodUnit = periodMatch ? periodMatch[2].toUpperCase() : 'MONTH';

    const maName = uniqueName(`${periodNum}-${periodUnit.toLowerCase().charAt(0).toUpperCase() + periodUnit.toLowerCase().slice(1)} Moving Avg`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Calculate ${periodNum}-Period Moving Average`, 'Measure', true, maName,
      `Calculates a rolling ${periodNum}-${periodUnit.toLowerCase()} average using senior DAX best practices (anchoring LastDate in a variable).`,
      `VAR _LastDate = MAX(${daxCol(dateInfo.table, dateInfo.column)})\nVAR _Periods = DATESINPERIOD(\n    ${daxCol(dateInfo.table, dateInfo.column)},\n    _LastDate,\n    -${periodNum},\n    ${periodUnit}\n)\nRETURN\n    AVERAGEX(\n        _Periods,\n        ${daxMeasureRef(baseName)}\n    )`,
      [baseName]));
    return { finalName: maName, notes, tipFragment: `Overlay ${maName} on a line chart to smooth out fluctuations.` };
  }

  // --- MODERN DAX (PHASE 5) ---
  function handleOffset(model, text, steps) {
    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;
    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const name = uniqueName(`Previous Row ${guessLabel(aggCol, 'Sales')}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, 'Calculate Offset (Previous Row)', 'Measure', true, name,
      'Uses the modern OFFSET function to retrieve the value from the previous row in the visual context.',
      `CALCULATE(\n    ${daxMeasureRef(baseName)},\n    OFFSET(\n        -1,\n        ORDERBY( /* [YourSortColumn] ASC */ )\n    )\n)`,
      [baseName]));
    return { finalName: name, notes: ['OFFSET requires an ORDERBY clause. Replace the placeholder with the column you are sorting your visual by.'], tipFragment: `Use ${name} in a table to compare against the previous row.` };
  }

  function handleWindow(model, text, steps) {
    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;
    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const name = uniqueName(`Rolling Window ${guessLabel(aggCol, 'Sales')}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, 'Calculate Window (Rolling)', 'Measure', true, name,
      'Uses the modern WINDOW function to calculate a rolling metric over visual rows.',
      `CALCULATE(\n    ${daxMeasureRef(baseName)},\n    WINDOW(\n        -2, REL,\n        0, REL,\n        ORDERBY( /* [YourSortColumn] ASC */ )\n    )\n)`,
      [baseName]));
    return { finalName: name, notes: ['WINDOW requires an ORDERBY clause. Replace the placeholder with your visual sort column.'], tipFragment: `Use ${name} to calculate moving metrics directly across visual rows.` };
  }

  function handleIndex(model, text, steps) {
    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;
    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
    const name = uniqueName(`First Row ${guessLabel(aggCol, 'Sales')}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, 'Calculate Index (First Row)', 'Measure', true, name,
      'Uses the modern INDEX function to retrieve the first row in the visual context.',
      `CALCULATE(\n    ${daxMeasureRef(baseName)},\n    INDEX(\n        1,\n        ORDERBY( /* [YourSortColumn] ASC */ )\n    )\n)`,
      [baseName]));
    return { finalName: name, notes: ['INDEX requires an ORDERBY clause. Replace the placeholder with your visual sort column.'], tipFragment: `Use ${name} to baseline against the first item in your list.` };
  }

  // --- DISTINCT COUNT ---
  function handleDistinctCount(model, text, steps) {
    const words = wordsOf(text);
    let targetCol = null;
    // Find the noun being counted
    for (const w of words) {
      if (['unique', 'distinct', 'different', 'count', 'number', 'of', 'total', 'how', 'many'].includes(w)) continue;
      const col = findColumnByName(model, w);
      if (col) { targetCol = col; break; }
      // Try with 'key' suffix
      const colKey = findColumnByName(model, w + 'key');
      if (colKey) { targetCol = colKey; break; }
      // Try with 'id' suffix
      const colId = findColumnByName(model, w + 'id');
      if (colId) { targetCol = colId; break; }
    }
    // Try table name match → use primary key-like column
    if (!targetCol) {
      for (const w of words) {
        for (const t of model.tables) {
          if (norm(t.name).includes(norm(w)) || norm(w).includes(norm(t.name))) {
            const keyCol = t.columns.find(c => norm(c.name).includes('key') || norm(c.name).includes('id')) || t.columns[0];
            if (keyCol) { targetCol = { table: t.name, column: keyCol.name }; break; }
          }
        }
        if (targetCol) break;
      }
    }
    if (!targetCol) return null;

    const dcName = uniqueName(`Distinct ${capitalize(targetCol.column.replace(/key|id/gi, '').trim() || targetCol.column)} Count`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Count Distinct ${targetCol.column}`, 'Measure', true, dcName,
      `Counts the number of unique values in ${daxCol(targetCol.table, targetCol.column)}.`,
      `DISTINCTCOUNT(${daxCol(targetCol.table, targetCol.column)})`,
      []));
    return { finalName: dcName, notes: [], tipFragment: `Use ${dcName} in a card or table visual.` };
  }

  // --- COUNT ---
  function handleCount(model, text, steps) {
    const words = wordsOf(text);
    let targetCol = null;
    let countTable = null;
    for (const w of words) {
      if (['count', 'number', 'of', 'total', 'how', 'many', 'tally', 'all'].includes(w)) continue;
      const col = findColumnByName(model, w);
      if (col) { targetCol = col; break; }
      for (const t of model.tables) {
        if (norm(t.name).includes(norm(w))) { countTable = t; break; }
      }
      if (countTable) break;
    }

    if (countTable) {
      const cntName = uniqueName(`${countTable.name} Count`, new Set(steps.map(s => s.name)));
      steps.push(makeStep(0, `Count ${countTable.name} Rows`, 'Measure', true, cntName,
        `Counts the number of rows in the ${countTable.name} table.`,
        `COUNTROWS('${countTable.name}')`, []));
      return { finalName: cntName, notes: [], tipFragment: `Use ${cntName} in a card or table.` };
    } else if (targetCol) {
      const cntName = uniqueName(`${targetCol.column} Count`, new Set(steps.map(s => s.name)));
      steps.push(makeStep(0, `Count ${targetCol.column}`, 'Measure', true, cntName,
        `Counts non-blank values in ${daxCol(targetCol.table, targetCol.column)}.`,
        `COUNTA(${daxCol(targetCol.table, targetCol.column)})`, []));
      return { finalName: cntName, notes: [], tipFragment: '' };
    }
    // Fallback: count rows of first fact table
    const fact = findFactTable(model);
    if (fact) {
      const cntName = uniqueName(`${fact.name} Count`, new Set(steps.map(s => s.name)));
      steps.push(makeStep(0, `Count ${fact.name} Rows`, 'Measure', true, cntName,
        `Counts the number of rows in the ${fact.name} table.`,
        `COUNTROWS('${fact.name}')`, []));
      return { finalName: cntName, notes: [], tipFragment: '' };
    }
    return null;
  }

  // --- AVERAGE ---
  function handleAverage(model, text, steps) {
    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    // Check if this is "average per X" (e.g., average order value)
    const perMatch = text.match(/\b(per|each)\s+(\w+)/i);
    if (perMatch) {
      const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);
      const countTarget = perMatch[2];
      let countTable = null;
      for (const t of model.tables) {
        if (norm(t.name).includes(norm(countTarget))) { countTable = t; break; }
      }
      if (countTable) {
        const countName = uniqueName(`${countTable.name} Count`, new Set(steps.map(s => s.name)));
        const existing = steps.find(s => s.name === countName);
        if (!existing) {
          steps.push(makeStep(0, `Count ${countTable.name}`, 'Measure', true, countName,
            `Counts rows in ${countTable.name} for the average calculation.`,
            `COUNTROWS('${countTable.name}')`, []));
        }
        const avgName = uniqueName(`Avg ${guessLabel(aggCol, 'Value')} per ${countTarget}`, new Set(steps.map(s => s.name)));
        steps.push(makeStep(0, `Calculate Average per ${capitalize(countTarget)}`, 'Measure', true, avgName,
          `Divides total by count to get average per ${countTarget}.`,
          `DIVIDE(${daxMeasureRef(baseName)}, ${daxMeasureRef(countName)})`,
          [baseName, countName]));
        return { finalName: avgName, notes: [], tipFragment: '' };
      }
    }

    const avgName = uniqueName(`Avg ${guessLabel(aggCol, aggCol.column)}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Calculate Average ${aggCol.column}`, 'Measure', true, avgName,
      `Calculates the average of ${daxCol(aggCol.table, aggCol.column)}.`,
      `AVERAGE(${daxCol(aggCol.table, aggCol.column)})`, []));
    return { finalName: avgName, notes: [], tipFragment: '' };
  }

  // --- MIN ---
  function handleMin(model, text, steps) {
    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;
    const minName = uniqueName(`Min ${guessLabel(aggCol, aggCol.column)}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Calculate Minimum ${aggCol.column}`, 'Measure', true, minName,
      `Returns the minimum value of ${daxCol(aggCol.table, aggCol.column)}.`,
      `MIN(${daxCol(aggCol.table, aggCol.column)})`, []));
    return { finalName: minName, notes: [], tipFragment: '' };
  }

  // --- MAX ---
  function handleMax(model, text, steps) {
    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;
    const maxName = uniqueName(`Max ${guessLabel(aggCol, aggCol.column)}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Calculate Maximum ${aggCol.column}`, 'Measure', true, maxName,
      `Returns the maximum value of ${daxCol(aggCol.table, aggCol.column)}.`,
      `MAX(${daxCol(aggCol.table, aggCol.column)})`, []));
    return { finalName: maxName, notes: [], tipFragment: '' };
  }

  // --- ITERATOR (SUMX) ---
  function handleIterator(model, text, steps) {
    const aggCol1 = resolveColumn(model, 'revenue') || resolveColumn(model, 'quantity');
    const aggCol2 = resolveColumn(model, 'cost', aggCol1 ? aggCol1.table : null) || resolveColumn(model, 'quantity', aggCol1 ? aggCol1.table : null);
    
    if (!aggCol1 || !aggCol2) return null;
    
    // If they aren't from the same table, we should use RELATED, but we assume same table for basic engine logic
    const table = aggCol1.table;
    const name = uniqueName(`Total ${guessLabel(aggCol1, 'Sales')} (Row-by-Row)`, new Set(steps.map(s => s.name)));
    
    steps.push(makeStep(0, 'Calculate Row-by-Row Iterator', 'Measure', true, name,
      'Iterates over the table evaluating the expression on each row before summing. Use SUMX for row-level math.',
      `SUMX(\n    '${table}',\n    ${daxCol(aggCol1.table, aggCol1.column)} * ${daxCol(aggCol2.table, aggCol2.column)}\n)`,
      []));
    return { finalName: name, notes: ['Make sure row-level context transition is not unintentionally triggered if you replace columns with measures inside SUMX.'], tipFragment: `Use ${name} as a standard measure.` };
  }

  // --- GENERIC SUM ---
  function handleSum(model, text, steps) {
    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;
    const sumName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, aggCol.column)}`, model);
    return { finalName: sumName, notes: [], tipFragment: `Use ${sumName} as a value in any visual.` };
  }

  // --- DATE TABLE GENERATION ---
  function handleDateTable(model, text, steps) {
    const dtName = 'DateTable';
    steps.push(makeStep(0, 'Generate Date Table', 'Calculated Table', true, dtName,
      'Creates a continuous date table. Mark this table as a Date Table in Power BI for reliable time intelligence.',
      `${dtName} = \nVAR _StartDate = DATE(2020, 1, 1)\nVAR _EndDate = DATE(2030, 12, 31)\nRETURN\n    ADDCOLUMNS(\n        CALENDAR(_StartDate, _EndDate),\n        "Year", YEAR([Date]),\n        "Month", FORMAT([Date], "MMMM"),\n        "MonthNumber", MONTH([Date]),\n        "Quarter", "Q" & FORMAT([Date], "Q"),\n        "YearMonth", FORMAT([Date], "YYYY-MM"),\n        "DayOfWeek", FORMAT([Date], "dddd"),\n        "WeekNumber", WEEKNUM([Date])\n    )`,
      []));
    return { finalName: dtName, notes: ['After creating this table, go to Modeling → Mark as Date Table → select the Date column.'], tipFragment: 'Create this calculated table first, then build relationships from your fact table date columns to this table.' };
  }

  // --- BUCKET / CALCULATED COLUMN ---
  function handleBucket(model, text, steps) {
    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;

    const bucketName = uniqueName(`${aggCol.column} Tier`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Create ${aggCol.column} Tier Column`, 'Calculated Column', true, bucketName,
      `Row-level classification that creates grouping tiers based on ${daxCol(aggCol.table, aggCol.column)}. Adjust thresholds to match your business logic.`,
      `${bucketName} = \nSWITCH(\n    TRUE(),\n    ${daxCol(aggCol.table, aggCol.column)} >= 1000, "High",\n    ${daxCol(aggCol.table, aggCol.column)} >= 500, "Medium",\n    ${daxCol(aggCol.table, aggCol.column)} >= 100, "Low",\n    "Very Low"\n)`,
      []));
    return { finalName: bucketName, notes: ['Adjust the threshold values (1000, 500, 100) to match your business requirements.'], tipFragment: `Use ${bucketName} on a slicer or as a legend to group data.` };
  }

  // --- WEIGHTED AVERAGE ---
  function handleWeightedAverage(model, text, steps) {
    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;
    const weightCol = resolveColumn(model, 'quantity', aggCol.table, [aggCol]);
    if (!weightCol) return null;

    const waName = uniqueName(`Weighted Avg ${guessLabel(aggCol, aggCol.column)}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, 'Calculate Weighted Average', 'Measure', true, waName,
      `Weights each row's ${aggCol.column} by ${weightCol.column} before averaging.`,
      `DIVIDE(\n    SUMX('${aggCol.table}', ${daxCol(aggCol.table, aggCol.column)} * ${daxCol(weightCol.table, weightCol.column)}),\n    SUM(${daxCol(weightCol.table, weightCol.column)})\n)`,
      []));
    return { finalName: waName, notes: [], tipFragment: '' };
  }

  // --- CONVERSION RATE ---
  function handleConversionRate(model, text, steps) {
    const fact = findFactTable(model);
    if (!fact) return null;

    const totalName = uniqueName(`Total ${fact.name}`, new Set(steps.map(s => s.name)));
    if (!steps.find(s => s.name === totalName)) {
      steps.push(makeStep(0, `Count All ${fact.name}`, 'Measure', true, totalName,
        `Total count of all rows in ${fact.name}.`,
        `COUNTROWS('${fact.name}')`, []));
    }
    const crName = uniqueName('Conversion Rate', new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, 'Calculate Conversion Rate', 'Measure', true, crName,
      'Ratio of converted/successful rows to total rows. Adjust the filter condition to match your success criteria. Uses KEEPFILTERS as a best practice.',
      `// Adjust the filter condition below to match your data\nVAR _Converted = CALCULATE(\n    COUNTROWS('${fact.name}'),\n    -- Replace with your actual success/conversion filter:\n    -- KEEPFILTERS( '${fact.name}'[Status] = "Completed" )\n    KEEPFILTERS( TRUE() )\n)\nVAR _Total = ${daxMeasureRef(totalName)}\nRETURN\n    DIVIDE(_Converted, _Total)`,
      [totalName]));
    return { finalName: crName, notes: ['The conversion filter condition is a placeholder — replace it with your actual success criteria column and value.'], tipFragment: 'Format as percentage. Use in a KPI card or trend line.' };
  }

  // ══════════════════════════════════════════════════════════
  //  ADVANCED ENTITY / BALANCE / THRESHOLD PATTERNS
  // ══════════════════════════════════════════════════════════

  const ENTITY_WORDS = /\b(customers?|clients?|users?|accounts?|products?|items?|stores?|members?|subscribers?|patients?|employees?)\b/i;

  // Resolve the key/id column that identifies an entity (customer/product/…).
  function resolveEntityKey(model, text) {
    const ew = ((text.match(ENTITY_WORDS) || [, 'customer'])[1] || 'customer').toLowerCase().replace(/s$/, '');
    for (const t of model.tables) for (const c of t.columns) {
      const cn = norm(c.name);
      if (cn.includes(ew) && (cn.includes('key') || cn.includes('id'))) return { table: t.name, column: c.name, entity: ew, assumed: false };
    }
    for (const t of model.tables) {
      if (norm(t.name).includes(ew)) {
        const key = t.columns.find(c => norm(c.name).includes('key') || norm(c.name).includes('id')) || t.columns[0];
        if (key) return { table: t.name, column: key.name, entity: ew, assumed: false };
      }
    }
    const fact = findFactTable(model) || model.tables[0];
    if (fact) {
      const key = fact.columns.find(c => norm(c.name).includes(ew) && (norm(c.name).includes('key') || norm(c.name).includes('id')))
        || fact.columns.find(c => norm(c.name).includes('key') || norm(c.name).includes('id'));
      if (key) return { table: fact.name, column: key.name, entity: ew, assumed: false };
      return { table: fact.name, column: capitalize(ew) + 'Key', entity: ew, assumed: true };
    }
    return { table: 'Table', column: capitalize(ew) + 'Key', entity: ew, assumed: true };
  }

  function periodFromText(text) {
    if (/\bquarter/i.test(text)) return { unit: 'QUARTER', n: 1, label: 'quarter' };
    if (/\b(year|annual)/i.test(text)) return { unit: 'YEAR', n: 1, label: 'year' };
    if (/\bweek/i.test(text)) return { unit: 'DAY', n: 7, label: 'week' };
    return { unit: 'MONTH', n: 1, label: 'month' };
  }

  function dateForCalc(model, notes) {
    const di = findDateInfo(model);
    if (di) return di;
    notes.push("No date column found — using a placeholder 'Date'[Date]. Point these at your real date table.");
    return { table: 'Date', column: 'Date', assumed: true };
  }

  function findExclusionColumn(model) {
    const prefs = ['transactiontype', 'type', 'status', 'category', 'flag', 'kind', 'class'];
    for (const p of prefs) for (const t of model.tables) for (const c of t.columns) {
      if (!c.isNumeric && !c.isDate && norm(c.name).includes(p)) return { table: t.name, column: c.name };
    }
    for (const t of model.tables) for (const c of t.columns) {
      if (!c.isNumeric && !c.isDate) return { table: t.name, column: c.name };
    }
    return null;
  }

  function entityNote(ent) {
    return ent.assumed ? [`Assumed ${daxCol(ent.table, ent.column)} identifies a ${ent.entity} — adjust if your key column differs.`] : [];
  }

  // --- CHURN RATE ---
  function handleChurn(model, text, steps) {
    const notes = [];
    const ent = resolveEntityKey(model, text);
    const di = dateForCalc(model, notes);
    const per = periodFromText(text);
    notes.push(...entityNote(ent));
    const keyRef = daxCol(ent.table, ent.column);
    const dateRef = daxCol(di.table, di.column);
    const shift = `DATEADD(${dateRef}, -${per.n}, ${per.unit})`;
    const churnedName = uniqueName(`Churned ${capitalize(ent.entity)}s`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Count Churned ${capitalize(ent.entity)}s`, 'Measure', true, churnedName,
      `${capitalize(ent.entity)}s active in the previous ${per.label} but not the current one (EXCEPT of the two active key sets).`,
      `VAR _Current = VALUES(${keyRef})\nVAR _Prior = CALCULATETABLE(VALUES(${keyRef}), ${shift})\nRETURN\n    COUNTROWS(EXCEPT(_Prior, _Current))`, []));
    const priorName = uniqueName(`Prior ${capitalize(per.label)} ${capitalize(ent.entity)}s`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Count Previous-${capitalize(per.label)} ${capitalize(ent.entity)}s`, 'Measure', true, priorName,
      `Distinct ${ent.entity}s active in the previous ${per.label} — the churn denominator.`,
      wrapCalculate(`DISTINCTCOUNT(${keyRef})`, [shift]), []));
    const rateName = uniqueName('Churn Rate %', new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, 'Calculate Churn Rate %', 'Measure', true, rateName,
      `Churned ${ent.entity}s as a share of the previous ${per.label}'s active ${ent.entity}s.`,
      `DIVIDE(${daxMeasureRef(churnedName)}, ${daxMeasureRef(priorName)})`, [churnedName, priorName]));
    return { finalName: rateName, notes, tipFragment: `Format ${rateName} as %. Needs a marked Date table for the ${per.label} shift to work.` };
  }

  // --- RETENTION RATE ---
  function handleRetention(model, text, steps) {
    const notes = [];
    const ent = resolveEntityKey(model, text);
    const di = dateForCalc(model, notes);
    const per = periodFromText(text);
    notes.push(...entityNote(ent));
    const keyRef = daxCol(ent.table, ent.column);
    const dateRef = daxCol(di.table, di.column);
    const shift = `DATEADD(${dateRef}, -${per.n}, ${per.unit})`;
    const retName = uniqueName(`Retained ${capitalize(ent.entity)}s`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Count Retained ${capitalize(ent.entity)}s`, 'Measure', true, retName,
      `${capitalize(ent.entity)}s active in BOTH the previous and current ${per.label} (INTERSECT).`,
      `VAR _Current = VALUES(${keyRef})\nVAR _Prior = CALCULATETABLE(VALUES(${keyRef}), ${shift})\nRETURN\n    COUNTROWS(INTERSECT(_Current, _Prior))`, []));
    const priorName = uniqueName(`Prior ${capitalize(per.label)} ${capitalize(ent.entity)}s`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Count Previous-${capitalize(per.label)} ${capitalize(ent.entity)}s`, 'Measure', true, priorName,
      `Distinct ${ent.entity}s active in the previous ${per.label}.`,
      wrapCalculate(`DISTINCTCOUNT(${keyRef})`, [shift]), []));
    const rateName = uniqueName('Retention Rate %', new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, 'Calculate Retention Rate %', 'Measure', true, rateName,
      `Retained ${ent.entity}s as a share of the previous ${per.label}'s active ${ent.entity}s (≈ 1 − churn).`,
      `DIVIDE(${daxMeasureRef(retName)}, ${daxMeasureRef(priorName)})`, [retName, priorName]));
    return { finalName: rateName, notes, tipFragment: `Format ${rateName} as %.` };
  }

  // --- NEW CUSTOMERS (first-ever activity in the period) ---
  function handleNewCustomers(model, text, steps) {
    const notes = [];
    const ent = resolveEntityKey(model, text);
    const di = dateForCalc(model, notes);
    notes.push(...entityNote(ent));
    const keyRef = daxCol(ent.table, ent.column);
    const dateRef = daxCol(di.table, di.column);
    const name = uniqueName(`New ${capitalize(ent.entity)}s`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Count New ${capitalize(ent.entity)}s`, 'Measure', true, name,
      `${capitalize(ent.entity)}s whose first-ever activity falls in the current date context (active now, never before).`,
      `VAR _Current = VALUES(${keyRef})\nVAR _Prior =\n    CALCULATETABLE(\n        VALUES(${keyRef}),\n        FILTER(ALL(${dateRef}), ${dateRef} < MIN(${dateRef}))\n    )\nRETURN\n    COUNTROWS(EXCEPT(_Current, _Prior))`, []));
    return { finalName: name, notes, tipFragment: `Put a month/quarter on the axis to see ${ent.entity} acquisition over time.` };
  }

  // --- SEMI-ADDITIVE: CLOSING BALANCE (LASTNONBLANK) ---
  function handleClosingBalance(model, text, steps) {
    const notes = [];
    const di = dateForCalc(model, notes);
    const col = resolveColumn(model, 'quantity') || resolveAggColumn(model, text);
    if (!col) return null;
    const base = ensureSumMeasure(steps, col, `Total ${guessLabel(col, 'Quantity')}`, model);
    const dateRef = daxCol(di.table, di.column);
    const name = uniqueName(`Closing ${guessLabel(col, 'Balance')}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, 'Calculate Closing Balance', 'Measure', true, name,
      `Semi-additive: the value on the LAST date with data in context. Sums across other dimensions but NOT across dates — right for inventory, headcount, account balances.`,
      `CALCULATE(\n    ${daxMeasureRef(base)},\n    LASTNONBLANK(${dateRef}, ${daxMeasureRef(base)})\n)`, [base]));
    return { finalName: name, notes, tipFragment: `Use ${name} for balances that shouldn't be summed over time.` };
  }

  // --- SEMI-ADDITIVE: OPENING BALANCE (FIRSTNONBLANK) ---
  function handleOpeningBalance(model, text, steps) {
    const notes = [];
    const di = dateForCalc(model, notes);
    const col = resolveColumn(model, 'quantity') || resolveAggColumn(model, text);
    if (!col) return null;
    const base = ensureSumMeasure(steps, col, `Total ${guessLabel(col, 'Quantity')}`, model);
    const dateRef = daxCol(di.table, di.column);
    const name = uniqueName(`Opening ${guessLabel(col, 'Balance')}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, 'Calculate Opening Balance', 'Measure', true, name,
      `Semi-additive: the value on the FIRST date with data in context.`,
      `CALCULATE(\n    ${daxMeasureRef(base)},\n    FIRSTNONBLANK(${dateRef}, ${daxMeasureRef(base)})\n)`, [base]));
    return { finalName: name, notes, tipFragment: `Pair with Closing Balance for opening/closing inventory or account snapshots.` };
  }

  // --- CUSTOMER LIFETIME VALUE (avg total value per entity) ---
  function handleLifetimeValue(model, text, steps) {
    const notes = [];
    const ent = resolveEntityKey(model, text);
    const col = resolveColumn(model, 'revenue') || resolveAggColumn(model, text);
    if (!col) return null;
    const base = ensureSumMeasure(steps, col, `Total ${guessLabel(col, 'Sales')}`, model);
    notes.push(...entityNote(ent));
    const keyRef = daxCol(ent.table, ent.column);
    const name = uniqueName(`Avg ${guessLabel(col, 'Revenue')} per ${capitalize(ent.entity)}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Calculate ${guessLabel(col, 'Value')} per ${capitalize(ent.entity)} (CLV)`, 'Measure', true, name,
      `Average total ${guessLabel(col, 'value').toLowerCase()} across ${ent.entity}s — AVERAGEX iterates the distinct ${ent.entity} keys and evaluates the base measure per ${ent.entity}.`,
      `AVERAGEX(\n    VALUES(${keyRef}),\n    ${daxMeasureRef(base)}\n)`, [base]));
    return { finalName: name, notes, tipFragment: `Lifetime value per ${ent.entity}; filter to a date range/cohort for period CLV.` };
  }

  // --- CUMULATIVE DISTINCT (running reach / to-date) ---
  function handleCumulativeDistinct(model, text, steps) {
    const notes = [];
    const di = dateForCalc(model, notes);
    const ent = resolveEntityKey(model, text);
    notes.push(...entityNote(ent));
    const keyRef = daxCol(ent.table, ent.column);
    const dateRef = daxCol(di.table, di.column);
    const name = uniqueName(`Cumulative ${capitalize(ent.entity)}s`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Calculate Cumulative Distinct ${capitalize(ent.entity)}s`, 'Measure', true, name,
      `Distinct ${ent.entity}s from the beginning of time up to the latest date in context (accumulates, never resets).`,
      `CALCULATE(\n    DISTINCTCOUNT(${keyRef}),\n    ${dateRef} <= MAX(${dateRef}),\n    ALL(${dateRef})\n)`, []));
    return { finalName: name, notes, tipFragment: `Plot on a line chart with dates on the axis to see cumulative reach.` };
  }

  // --- BASKET SIZE / AVERAGE ORDER VALUE ---
  function handleBasketSize(model, text, steps) {
    const notes = [];
    const fact = findFactTable(model) || model.tables[0];
    const isValue = /\b(order\s+value|aov|revenue|amount|sales|spend)\b/i.test(text) && !/\b(items?|units?|products?|qty|quantity)\b/i.test(text);
    const col = isValue ? (resolveColumn(model, 'revenue') || resolveAggColumn(model, text))
      : (resolveColumn(model, 'quantity') || resolveAggColumn(model, text));
    if (!col) return null;
    const base = ensureSumMeasure(steps, col, `Total ${guessLabel(col, isValue ? 'Sales' : 'Quantity')}`, model);
    let orderRef = null;
    for (const t of model.tables) for (const c of t.columns) {
      const cn = norm(c.name);
      if (/order|transaction|invoice/.test(cn) && (cn.includes('key') || cn.includes('id') || cn.includes('number') || cn.includes('no'))) {
        orderRef = `DISTINCTCOUNT(${daxCol(t.name, c.name)})`;
      }
    }
    if (!orderRef) { orderRef = `COUNTROWS('${fact.name}')`; notes.push(`No order/transaction id found — used the row count of ${fact.name} as the order count. Point it at your order key for accuracy.`); }
    const name = uniqueName(isValue ? 'Average Order Value' : 'Items per Order', new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, isValue ? 'Calculate Average Order Value' : 'Calculate Basket Size (Items per Order)', 'Measure', true, name,
      `Divides ${daxMeasureRef(base)} by the number of orders.`,
      `DIVIDE(\n    ${daxMeasureRef(base)},\n    ${orderRef}\n)`, [base]));
    return { finalName: name, notes, tipFragment: `${name} = total ${isValue ? 'value' : 'items'} ÷ orders.` };
  }

  // --- THRESHOLD ENTITY COUNT ("customers with > N orders") ---
  function handleThresholdCount(model, text, steps) {
    const opM = text.match(/\b(more than|greater than|at least|no less than|fewer than|less than|at most|over|above|under|below)\s+(\d+)|([<>]=?)\s*(\d+)/i);
    if (!opM) return null;
    const opMap = { 'more than': '>', 'greater than': '>', 'over': '>', 'above': '>', 'at least': '>=', 'no less than': '>=', 'fewer than': '<', 'less than': '<', 'under': '<', 'below': '<', 'at most': '<=' };
    const op = opM[3] ? opM[3] : (opMap[(opM[1] || '').toLowerCase()] || '>');
    const threshold = opM[2] || opM[4];
    if (!ENTITY_WORDS.test(text)) return null;      // need a clear entity to count
    const ent = resolveEntityKey(model, text);
    const keyRef = daxCol(ent.table, ent.column);
    const notes = [];

    let metricRef, metricLabel;
    if (/\b(order|transaction|purchase|invoice|visit|trip)s?\b/i.test(text)) {
      const fact = findFactTable(model) || model.tables[0];
      const cntName = uniqueName('Order Count', new Set(steps.map(s => s.name)));
      if (!steps.find(s => s.name === cntName)) {
        steps.push(makeStep(0, `Count ${fact.name} Rows`, 'Measure', true, cntName,
          `Number of orders/transactions (rows in ${fact.name}).`, `COUNTROWS('${fact.name}')`, []));
      }
      metricRef = daxMeasureRef(cntName); metricLabel = 'Orders';
    } else {
      const agg = resolveAggColumn(model, text);
      const base = ensureSumMeasure(steps, agg, `Total ${guessLabel(agg, 'Sales')}`, model);
      metricRef = daxMeasureRef(base); metricLabel = guessLabel(agg, 'Value');
    }
    notes.push(...entityNote(ent));
    const name = uniqueName(`${capitalize(ent.entity)}s with ${op}${threshold} ${metricLabel}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Count ${capitalize(ent.entity)}s Meeting the Threshold`, 'Measure', true, name,
      `Counts ${ent.entity}s whose ${metricLabel.toLowerCase()} is ${op} ${threshold}. FILTER iterates the distinct ${ent.entity} keys and tests the measure per ${ent.entity}.`,
      `COUNTROWS(\n    FILTER(\n        VALUES(${keyRef}),\n        ${metricRef} ${op} ${threshold}\n    )\n)`, []));
    return { finalName: name, notes, tipFragment: `Add a date slicer to see how many ${ent.entity}s cross the threshold over time.` };
  }

  // --- TOP N (proper TOPN pattern, not just RANKX) ---
  function handleTopN(model, text, steps) {
    const m = text.match(/\btop\s+(\d+)\s*([a-z]*)/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const entityWord = m[2] || '';

    const aggCol = resolveAggColumn(model, text);
    if (!aggCol) return null;
    const baseName = ensureSumMeasure(steps, aggCol, `Total ${guessLabel(aggCol, 'Sales')}`, model);

    // Dimension: the word right after "top N", else the "by ..." clause, else any dimension
    let dimCol = entityWord ? resolveGroupBy(model, entityWord) : null;
    if (!dimCol) {
      const mods = extractModifiers(text);
      if (mods.groupBy) dimCol = resolveGroupBy(model, mods.groupBy);
    }
    if (!dimCol) {
      for (const t of model.tables) {
        const textCol = t.columns.find(c => !c.isNumeric && !c.isDate);
        if (textCol) { dimCol = { table: t.name, column: textCol.name }; break; }
      }
    }
    if (!dimCol) return null;

    const notes = [];
    if (norm(dimCol.table) !== norm(aggCol.table) && !pathExists(model, dimCol.table, aggCol.table)) {
      notes.push(`⚠ '${dimCol.table}' is not related to '${aggCol.table}' by an active relationship — the TOPN filter won't affect ${daxMeasureRef(baseName)} until you add one.`);
    }

    // Optional "excluding X" — filter the population before ranking.
    const filters = [`KEEPFILTERS(\n        TOPN(\n            ${n},\n            ALL(${daxCol(dimCol.table, dimCol.column)}),\n            ${daxMeasureRef(baseName)},\n            DESC\n        )\n    )`];
    let suffix = '';
    const exM = text.match(/\b(?:excluding|except|not\s+including|without)\s+([A-Za-z0-9][\w &-]*?)(?=\s*(?:$|,|\.|and\b|by\b))/i);
    if (exM) {
      const word = exM[1].trim();
      const exCol = findExclusionColumn(model);
      if (exCol) {
        filters.push(`${daxCol(exCol.table, exCol.column)} <> "${word}"`);
        suffix = ` (excl. ${word})`;
        notes.push(`Exclusion applied as ${daxCol(exCol.table, exCol.column)} <> "${word}" — verify that column/value matches how "${exM[1].trim()}" is stored in your model.`);
      } else {
        notes.push(`Wanted to exclude "${exM[1].trim()}" but found no category column to filter on — add e.g. CALCULATE(…, '<Table>'[Type] <> "${word}").`);
      }
    }

    const topName = uniqueName(`Top ${n} ${capitalize(dimCol.column)} ${guessLabel(aggCol, 'Sales')}${suffix}`, new Set(steps.map(s => s.name)));
    steps.push(makeStep(0, `Calculate Top ${n} by ${daxMeasureRef(baseName)}${suffix}`, 'Measure', true, topName,
      `Keeps only the top ${n} ${dimCol.column} values ranked by ${daxMeasureRef(baseName)}.${exM ? ' Excludes the requested rows first.' : ''} KEEPFILTERS intersects with (rather than replaces) existing filters.`,
      wrapCalculate(daxMeasureRef(baseName), filters),
      [baseName]));
    return { finalName: topName, notes, tipFragment: `Put ${daxCol(dimCol.table, dimCol.column)} on the axis/rows — only the top ${n} members show a value.` };
  }

  // --- BUDGET vs ACTUAL VARIANCE ---
  function handleVariance(model, text, steps) {
    const budgetCol = resolveColumn(model, 'budget');
    if (!budgetCol) return null;
    const actualCol = resolveColumn(model, 'revenue', budgetCol.table, [budgetCol]) || resolveColumn(model, 'quantity', budgetCol.table, [budgetCol]);
    if (!actualCol) return null;

    const actualName = ensureSumMeasure(steps, actualCol, `Total ${guessLabel(actualCol, 'Actual')}`, model);
    const budgetName = ensureSumMeasure(steps, budgetCol, `Total ${guessLabel(budgetCol, 'Budget')}`, model);
    const existing = new Set(steps.map(s => s.name));

    const varName = uniqueName(`${guessLabel(actualCol, 'Actual')} Variance`, existing);
    steps.push(makeStep(0, 'Calculate Variance (Actual − Budget)', 'Measure', true, varName,
      'Absolute difference between actual and budget/target.',
      `${daxMeasureRef(actualName)} - ${daxMeasureRef(budgetName)}`,
      [actualName, budgetName]));
    existing.add(varName);

    const varPctName = uniqueName(`${guessLabel(actualCol, 'Actual')} Variance %`, existing);
    steps.push(makeStep(0, 'Calculate Variance %', 'Measure', true, varPctName,
      'Variance relative to budget, using DIVIDE for safe division. Format as percentage.',
      `DIVIDE(\n    ${daxMeasureRef(varName)},\n    ${daxMeasureRef(budgetName)}\n)`,
      [varName, budgetName]));
    return { finalName: varPctName, notes: [], tipFragment: `Show ${varName} and ${varPctName} side-by-side in a table or matrix; conditional-format ${varPctName} red/green.` };
  }

  // --- COMPOSABLE TIME-INTEL WRAPPER (e.g. "YoY profit margin") ---
  // Wraps an EXISTING measure in a time-intelligence step chain.
  function wrapTimeIntelOnMeasure(model, measureName, kind, steps) {
    const notes = [];
    const dateInfo = findDateInfo(model);
    if (!dateInfo) {
      notes.push(`⚠ ${kind.toUpperCase()} of ${daxMeasureRef(measureName)} requires a date table — none found in the model.`);
      return { finalName: measureName, notes, tipFragment: '' };
    }
    const relCol = resolveColumn(model, 'revenue') || resolveAggColumn(model, measureName);
    const userel = relCol ? checkTimeIntelRelationship(model, relCol, dateInfo, notes) : null;
    const existing = new Set(steps.map(s => s.name));
    const dateRef = daxCol(dateInfo.table, dateInfo.column);
    const isRatio = /%/.test(measureName);

    if (kind === 'ytd' || kind === 'qtd' || kind === 'mtd') {
      const fn = { ytd: 'DATESYTD', qtd: 'DATESQTD', mtd: 'DATESMTD' }[kind];
      const name = uniqueName(`${measureName} ${kind.toUpperCase()}`, existing);
      steps.push(makeStep(0, `Calculate ${measureName} ${kind.toUpperCase()}`, 'Measure', true, name,
        `Evaluates ${daxMeasureRef(measureName)} over the ${kind.toUpperCase()} date range — the full measure chain is recomputed in the accumulated context.`,
        wrapCalculate(daxMeasureRef(measureName), [`${fn}(${dateRef})`, userel]),
        [measureName]));
      return { finalName: name, notes, tipFragment: `Use ${name} with a date axis for cumulative tracking.` };
    }

    // yoy / qoq / mom
    const cfg = {
      yoy: { filter: `SAMEPERIODLASTYEAR(${dateRef})`, suffix: 'PY', label: 'Previous Year' },
      qoq: { filter: `DATEADD(${dateRef}, -1, QUARTER)`, suffix: 'PQ', label: 'Previous Quarter' },
      mom: { filter: `DATEADD(${dateRef}, -1, MONTH)`, suffix: 'PM', label: 'Previous Month' },
    }[kind] || { filter: `SAMEPERIODLASTYEAR(${dateRef})`, suffix: 'PY', label: 'Previous Year' };

    const prevName = uniqueName(`${measureName} ${cfg.suffix}`, existing);
    steps.push(makeStep(0, `Calculate ${measureName} ${cfg.label}`, 'Measure', true, prevName,
      `Re-evaluates the full ${daxMeasureRef(measureName)} chain with the date context shifted to the ${cfg.label.toLowerCase()}.`,
      wrapCalculate(daxMeasureRef(measureName), [cfg.filter, userel]),
      [measureName]));
    existing.add(prevName);

    if (isRatio) {
      // For ratio measures, period-over-period is a difference in points, not a % of a %.
      const deltaName = uniqueName(`${measureName} ${kind.toUpperCase()} Change (pts)`, existing);
      steps.push(makeStep(0, `Calculate ${kind.toUpperCase()} Change in Points`, 'Measure', true, deltaName,
        `${daxMeasureRef(measureName)} is a ratio, so the period-over-period comparison is expressed as a percentage-point difference.`,
        `${daxMeasureRef(measureName)} - ${daxMeasureRef(prevName)}`,
        [measureName, prevName]));
      return { finalName: deltaName, notes, tipFragment: `${deltaName} is in percentage points — format with a +/- sign.` };
    }

    const growthName = uniqueName(`${measureName} ${kind.toUpperCase()} Growth %`, existing);
    steps.push(makeStep(0, `Calculate ${kind.toUpperCase()} Growth %`, 'Measure', true, growthName,
      'Relative change versus the prior period, using DIVIDE for safe division.',
      `VAR _Current = ${daxMeasureRef(measureName)}\nVAR _Prior = ${daxMeasureRef(prevName)}\nRETURN\n    DIVIDE(_Current - _Prior, _Prior)`,
      [measureName, prevName]));
    return { finalName: growthName, notes, tipFragment: `Plot ${growthName} on a line chart with dates on the axis.` };
  }


  // ════════════════════════════════════════════════════════════
  //  PATTERN ROUTER
  // ════════════════════════════════════════════════════════════

  function routeRequirement(model, text, steps) {
    const t = text.toLowerCase();

    // Date table generation
    if (R.dateTable.test(t)) return handleDateTable(model, text, steps);

    // Bucket / calculated column
    if (R.bucket.test(t) && !R.sum.test(t) && !R.growth.test(t)) return handleBucket(model, text, steps);

    // Budget vs actual variance (before growth — "vs" would otherwise route to YoY)
    if (R.variance.test(t) && R.varianceContext.test(t)) {
      const vr = handleVariance(model, text, steps);
      if (vr) return vr;
    }

    // Profit margin % (most specific first) — composable with time intelligence
    if (R.profitMargin.test(t) || (R.profit.test(t) && R.margin.test(t)) || (R.profit.test(t) && R.percentage.test(t))) {
      const timeKind = R.yoy.test(t) ? 'yoy' : R.qoq.test(t) ? 'qoq' : R.mom.test(t) ? 'mom'
        : R.ytd.test(t) ? 'ytd' : R.qtd.test(t) ? 'qtd' : R.mtd.test(t) ? 'mtd' : null;
      const base = handleProfitMargin(model, text, steps);
      if (base && base.finalName && timeKind) {
        const wrapped = wrapTimeIntelOnMeasure(model, base.finalName, timeKind, steps);
        return {
          finalName: wrapped.finalName,
          notes: [...(base.notes || []), ...(wrapped.notes || [])],
          tipFragment: wrapped.tipFragment || base.tipFragment,
        };
      }
      return base;
    }

    // Rolling "previous / last N days|weeks|months" (± growth) — must beat generic
    // "growth" (which defaults to YoY) and the modern window functions.
    if (R.rollingPeriod.test(t) && !/\b(average|avg|mean)\b/i.test(t)) {
      const rp = handleRollingPeriod(model, text, steps);
      if (rp) return rp;
    }

    // ── Advanced entity / balance / threshold patterns (before generic count/sum/avg) ──
    if (R.churn.test(t)) { const x = handleChurn(model, text, steps); if (x) return x; }
    if (R.retention.test(t)) { const x = handleRetention(model, text, steps); if (x) return x; }
    if (R.newCustomers.test(t)) { const x = handleNewCustomers(model, text, steps); if (x) return x; }
    if (R.closingBalance.test(t)) { const x = handleClosingBalance(model, text, steps); if (x) return x; }
    if (R.openingBalance.test(t)) { const x = handleOpeningBalance(model, text, steps); if (x) return x; }
    if (R.lifetimeValue.test(t)) { const x = handleLifetimeValue(model, text, steps); if (x) return x; }
    if (R.cumulativeDistinct.test(t)) { const x = handleCumulativeDistinct(model, text, steps); if (x) return x; }
    if (R.basket.test(t)) { const x = handleBasketSize(model, text, steps); if (x) return x; }
    if (R.threshold.test(t)) { const x = handleThresholdCount(model, text, steps); if (x) return x; }

    // Modern DAX window functions (specific keywords — must beat generic "growth"/"vs")
    if (R.offset.test(t)) return handleOffset(model, text, steps);
    if (R.window.test(t)) return handleWindow(model, text, steps);
    if (R.index.test(t) && !R.rank.test(t)) return handleIndex(model, text, steps);

    // YoY growth %
    if (R.yoy.test(t) || (R.growth.test(t) && /year|annual|yearly/i.test(t))) {
      return handleYoYGrowth(model, text, steps);
    }
    // QoQ growth %
    if (R.qoq.test(t) || (R.growth.test(t) && /quarter/i.test(t))) {
      return handleQoQGrowth(model, text, steps);
    }
    // MoM growth %
    if (R.mom.test(t) || (R.growth.test(t) && /month/i.test(t))) {
      return handleMoMGrowth(model, text, steps);
    }
    // WoW growth
    if (R.wow.test(t)) {
      // Treat like MoM but with weeks (simplified)
      return handleMoMGrowth(model, text, steps);
    }

    // Generic growth (default to YoY)
    if (R.growth.test(t) && !R.profit.test(t)) {
      return handleYoYGrowth(model, text, steps);
    }

    // Simple profit (no margin)
    if (R.profit.test(t) && !R.margin.test(t)) {
      return handleProfit(model, text, steps);
    }

    // YTD / QTD / MTD
    if (R.ytd.test(t)) return handleYTD(model, text, steps);
    if (R.qtd.test(t)) return handleQTD(model, text, steps);
    if (R.mtd.test(t)) return handleMTD(model, text, steps);

    // Previous period
    if (R.prevYear.test(t)) return handlePreviousPeriod(model, text, steps, 'year');
    if (R.prevQuarter.test(t)) return handlePreviousPeriod(model, text, steps, 'quarter');
    if (R.prevMonth.test(t)) return handlePreviousPeriod(model, text, steps, 'month');

    // % of total
    if (R.pctOfTotal.test(t)) return handlePercentOfTotal(model, text, steps);

    // Conversion rate
    if (R.conversionRate.test(t)) return handleConversionRate(model, text, steps);

    // Weighted average
    if (R.weightedAvg.test(t)) return handleWeightedAverage(model, text, steps);

    // Moving average
    if (R.movingAvg.test(t)) return handleMovingAverage(model, text, steps);

    // Running total
    if (R.runningTotal.test(t)) return handleRunningTotal(model, text, steps);

    // Iterator
    if (R.iterator.test(t)) return handleIterator(model, text, steps);

    // Top N (proper TOPN pattern) — before generic rank
    if (R.topN.test(t)) {
      const tn = handleTopN(model, text, steps);
      if (tn) return tn;
    }

    // Rank
    if (R.rank.test(t)) return handleRank(model, text, steps);

    // Distinct count
    if (R.distinctCount.test(t)) return handleDistinctCount(model, text, steps);

    // Count
    if (R.countOf.test(t) || (R.count.test(t) && !R.sum.test(t) && !R.average.test(t))) {
      return handleCount(model, text, steps);
    }

    // Average
    if (R.average.test(t)) return handleAverage(model, text, steps);

    // Min
    if (R.min.test(t) && !R.max.test(t)) return handleMin(model, text, steps);

    // Max (careful: "top" can conflict with rank)
    if (R.max.test(t) && !/\btop\s*\d/i.test(t)) return handleMax(model, text, steps);

    // Sum / Total (default aggregation)
    if (R.sum.test(t)) return handleSum(model, text, steps);

    // Fallback: try to aggregate the most relevant column
    return handleSum(model, text, steps);
  }

    return {
      generate: function(model, text, steps) {
        // Strip explicit filter clauses first so the remaining text routes cleanly,
        // then wrap the resulting measure in a filtered CALCULATE.
        const fx = extractFilters(text, model);
        const result = routeRequirement(model, fx.cleaned || text, steps);
        if (result && fx.notes.length) result.notes = [...(result.notes || []), ...fx.notes];
        if (result && result.finalName && fx.filters.length) {
          const filterArgs = fx.filters.map(f => `${daxCol(f.table, f.column)} = ${f.value}`);
          const label = fx.filters.map(f => String(f.value).replace(/"/g, '')).join(', ');
          const fname = uniqueName(`${result.finalName} (${label})`, new Set(steps.map(s => s.name)));
          steps.push(makeStep(0, 'Apply Fixed Filters', 'Measure', true, fname,
            `Evaluates ${daxMeasureRef(result.finalName)} with fixed filter(s): ${filterArgs.join(', ')}. The filter values come from your requirement text — adjust if needed.`,
            wrapCalculate(daxMeasureRef(result.finalName), filterArgs),
            [result.finalName]));
          return { ...result, finalName: fname };
        }
        return result;
      },
    };
  })();

  // ==========================================
  // 8. EXPORT ENGINE & 9. FORMATTER (Labels)
  // ==========================================
  const ExportEngine = (function() {
  //  LABEL GUESSER
  // ════════════════════════════════════════════════════════════

  function guessLabel(col, fallback) {
    if (!col) return fallback;
    const cn = col.column.toLowerCase();
    // If column name is generic like "Amount", use table name
    if (['amount', 'value', 'total', 'sum', 'number', 'count', 'qty'].includes(cn)) {
      return col.table;
    }
    return col.column;
  }

  // ════════════════════════════════════════════════════════════

    return { guessLabel };
  })();
  const guessLabel = ExportEngine.guessLabel;
  

  // ==========================================
  // 8. VALIDATION, BEST PRACTICE & PERFORMANCE CHECKS
  // ==========================================
  function runValidations(steps, model, notes, errors) {
    let hasTimeIntel = false;
    const fact = findFactTable(model);
    for (const step of steps) {
      if (!step.dax) continue;
      const upper = step.dax.toUpperCase();
      if (upper.includes('DATESYTD') || upper.includes('DATESQTD') || upper.includes('DATESMTD') ||
          upper.includes('DATEADD') || upper.includes('SAMEPERIODLASTYEAR') || upper.includes('DATESINPERIOD') || upper.includes('DATESBETWEEN')) {
        hasTimeIntel = true;
      }
      if (fact && step.dax && upper.includes('FILTER') && upper.includes(fact.name.toUpperCase())) {
        errors.push('Performance Warning: Filtering a naked fact table (' + fact.name + ') inside CALCULATE is inefficient. Use FILTER(VALUES(DimensionColumn)) to minimize memory footprint.');
      }
      const allSelMatches = upper.match(/ALLSELECTED/g);
      if (allSelMatches && allSelMatches.length > 1) {
        errors.push('Performance Warning: Multiple ALLSELECTED calls detected. Nested or multiple ALLSELECTED can cause shadow filter context issues.');
      }
    }
    if (hasTimeIntel) {
      const dateInfo = findDateInfo(model);
      if (!dateInfo) {
        errors.push('Validation Error: Time Intelligence requested but no date column exists in the model.');
      }
    }
  }

  // ==========================================
  //  METADATA INFERENCE (format strings + display folders + home table)
  // ==========================================
  const CURRENCY_WORDS = ['sales', 'revenue', 'cost', 'profit', 'amount', 'price', 'budget', 'variance', 'income', 'value', 'gross', 'net'];

  function inferFormatString(step) {
    const n = step.name || '';
    const dax = step.dax || '';
    if (/%/.test(n)) return '0.0%';
    if (/pts\)?$/i.test(n)) return '+0.0;-0.0';                       // percentage-point deltas
    if (/\bRank\b/i.test(n) || /\bRANKX\b/.test(dax)) return '0';
    if (/\b(DISTINCTCOUNT|COUNTROWS|COUNTA?)\s*\(/.test(dax) || /\bcount\b/i.test(n)) return '#,0';
    if (CURRENCY_WORDS.some(w => n.toLowerCase().includes(w))) return '\\$#,##0.00;(\\$#,##0.00)';
    return '#,##0.00';
  }

  function inferDisplayFolder(step) {
    const n = step.name || '';
    const dax = step.dax || '';
    const both = n + ' ' + dax;
    if (step.objectType === 'Calculated Table') return '';
    if (step.objectType === 'Calculated Column') return 'Calculated Columns';
    if (/\bRANKX\b|\bTOPN\b|\bRank\b|\bTop \d/i.test(both)) return 'Ranking';
    if (/Variance/i.test(n)) return 'Variance';
    if (/SAMEPERIODLASTYEAR|DATEADD|TOTAL(YTD|QTD|MTD)|DATES(YTD|QTD|MTD|INPERIOD|BETWEEN)|_MaxDate/i.test(dax)
        || /\b(YoY|QoQ|MoM|YTD|QTD|MTD|PY|PQ|PM|Running Total|Moving Avg|Previous|Rolling)\b/i.test(n)) return 'Time Intelligence';
    if (/%/.test(n) || /^DIVIDE\(/.test(dax.trim())) return 'Ratios & %';
    if (/^(SUM|COUNTROWS|AVERAGE|DISTINCTCOUNT|MIN|MAX|COUNTA)\s*\(/.test(dax.trim())) return 'Base Measures';
    return 'Measures';
  }

  function enrichSteps(steps, model) {
    const factName = ((findFactTable(model) || model.tables[0] || {}).name) || 'Table';
    for (const s of steps) {
      s.formatString = inferFormatString(s);
      s.displayFolder = inferDisplayFolder(s);
      // Home table: first qualified column reference in the DAX, else the fact table.
      const m = (s.dax || '').match(/'([^']+)'\[/);
      s.homeTable = m ? m[1] : factName;
    }
  }

  // ==========================================
  //  EXPORTERS (pure functions on a generateSolution result)
  // ==========================================
  function exportableSteps(result) {
    return (result.steps || []).filter(s => s.dax && s.objectType !== 'None');
  }

  // Strip a leading "Name =" (calculated columns/tables carry it; measures don't).
  function daxExprOnly(step) {
    if (step.objectType === 'Calculated Column' || step.objectType === 'Calculated Table') {
      return step.dax.replace(/^\s*[^=\n]+?=\s*/, '').trim();
    }
    return step.dax;
  }

  // Plain DAX blocks, annotated with format string + display folder as comments.
  function exportAllMeasures(result) {
    return exportableSteps(result).map(s => {
      const kind = s.objectType;
      const header = `// ${kind}: ${s.name}` +
        (s.displayFolder ? `  |  Folder: ${s.displayFolder}` : '') +
        (s.formatString ? `  |  Format: ${s.formatString}` : '');
      return `${header}\n${s.name} =\n${s.dax}`;
    }).join('\n\n');
  }

  // C# script for Tabular Editor 2/3 (Advanced Scripting). Robust — C# verbatim
  // strings preserve multi-line DAX; only double-quotes need doubling.
  function exportTabularEditorScript(result) {
    const cs = (str) => '@"' + String(str).replace(/"/g, '""') + '"';
    const lines = [
      '// ── DAX Architect → Tabular Editor C# script ──',
      '// Paste into Tabular Editor 2/3 → "C# Script" (Advanced Scripting) and Run.',
      '// Creates every measure with its format string, display folder, and description.',
      '',
    ];
    const measures = exportableSteps(result).filter(s => s.objectType === 'Measure');
    const columns = exportableSteps(result).filter(s => s.objectType === 'Calculated Column');
    const calcTables = exportableSteps(result).filter(s => s.objectType === 'Calculated Table');

    for (const s of measures) {
      lines.push('try {');
      lines.push(`    var m = Model.Tables[${cs(s.homeTable)}].AddMeasure(${cs(s.name)}, ${cs(s.dax)});`);
      if (s.formatString) lines.push(`    m.FormatString = ${cs(s.formatString)};`);
      if (s.displayFolder) lines.push(`    m.DisplayFolder = ${cs(s.displayFolder)};`);
      if (s.reason) lines.push(`    m.Description = ${cs(s.reason)};`);
      lines.push(`} catch (System.Exception ex) { Info("Skipped ${s.name.replace(/"/g, '')}: " + ex.Message); }`);
      lines.push('');
    }
    for (const s of columns) {
      lines.push(`// Calculated column — created on '${s.homeTable}'`);
      lines.push('try {');
      lines.push(`    var c = Model.Tables[${cs(s.homeTable)}].AddCalculatedColumn(${cs(s.name)}, ${cs(daxExprOnly(s))});`);
      lines.push(`} catch (System.Exception ex) { Info(ex.Message); }`);
      lines.push('');
    }
    for (const s of calcTables) {
      lines.push('try {');
      lines.push(`    var ct = Model.AddCalculatedTable(${cs(s.name)}, ${cs(daxExprOnly(s))});`);
      lines.push(`} catch (System.Exception ex) { Info(ex.Message); }`);
      lines.push('');
    }
    return lines.join('\n').trim() + '\n';
  }

  // TMDL — grouped by home table. Best-effort (TMDL is tab-indented); paste into
  // a .tmdl table definition or the TMDL view in Tabular Editor / VS Code.
  function exportTMDL(result) {
    const measures = exportableSteps(result).filter(s => s.objectType === 'Measure');
    if (!measures.length) return '// No measures to export as TMDL.';
    const byTable = {};
    for (const s of measures) (byTable[s.homeTable] = byTable[s.homeTable] || []).push(s);

    const out = ['/// Generated by DAX Architect — TMDL measure definitions', ''];
    for (const [tbl, ms] of Object.entries(byTable)) {
      out.push(`table ${/\s/.test(tbl) ? `'${tbl}'` : tbl}`);
      out.push('');
      for (const s of ms) {
        const exprLines = s.dax.split('\n');
        if (exprLines.length === 1) {
          out.push(`\tmeasure '${s.name}' = ${exprLines[0]}`);
        } else {
          out.push(`\tmeasure '${s.name}' =`);
          exprLines.forEach(l => out.push(`\t\t\t${l}`));
        }
        if (s.formatString) out.push(`\t\tformatString: ${s.formatString}`);
        if (s.displayFolder) out.push(`\t\tdisplayFolder: ${s.displayFolder}`);
        if (s.reason) out.push(`\t\t/// ${s.reason}`);
        out.push('');
      }
    }
    return out.join('\n');
  }

  // ==========================================
  //  DAX LINTER (paste-any-DAX best-practice checks)
  // ==========================================
  function lintDax(code) {
    const findings = [];
    if (!code || !code.trim()) return [{ severity: 'info', message: 'Paste some DAX to lint.' }];

    const lines = code.split('\n');
    lines.forEach((raw, i) => {
      const ln = i + 1;
      const line = raw.replace(/\/\/.*$/, '');           // ignore line comments
      if (/&quot;|"/.test(line)) { /* strings present — still scan, division regex is conservative */ }
      // Naked "/" division (not part of DIVIDE, not a comment, operands look numeric/measure)
      if (/[\w\])]\s*\/\s*[\w\[('"-]/.test(line) && !/\bDIVIDE\s*\(/i.test(line) && !/\/\//.test(raw.trimStart().slice(0, 2))) {
        findings.push({ severity: 'warning', line: ln, rule: 'Use DIVIDE',
          message: 'Division with "/" can throw or return Infinity on a zero denominator. Use DIVIDE(numerator, denominator) — it returns BLANK() instead.' });
      }
    });

    // FILTER over an entire (bare) table
    if (/\bFILTER\s*\(\s*'?[A-Za-z0-9_ ]+'?\s*,/.test(code) && !/\bFILTER\s*\(\s*(VALUES|ALL|ALLSELECTED|DISTINCT|SUMMARIZE|CALCULATETABLE)/i.test(code)) {
      findings.push({ severity: 'warning', rule: 'FILTER scope',
        message: 'FILTER() over a whole table scans every row. Prefer FILTER(VALUES(\'Table\'[Column]), …) or put a column predicate directly in CALCULATE — much less memory/CPU.' });
    }
    // IFERROR / ISERROR
    if (/\b(IFERROR|ISERROR)\s*\(/i.test(code)) {
      findings.push({ severity: 'info', rule: 'Avoid IFERROR',
        message: 'IFERROR/ISERROR forces slow error handling. For division use DIVIDE(); otherwise guard the condition explicitly (e.g. IF(ISBLANK(...))).' });
    }
    // Repeated measure/expression references without VAR
    const refs = code.match(/\[[A-Za-z0-9_ %#]+\]/g) || [];
    const counts = {};
    refs.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
    if (!/\bVAR\b/i.test(code)) {
      Object.entries(counts).forEach(([r, c]) => {
        if (c >= 3) findings.push({ severity: 'info', rule: 'Use VAR',
          message: `${r} is referenced ${c} times. Compute it once in a VAR and reuse it — clearer and avoids repeated evaluation.` });
      });
    }
    // Multiple ALLSELECTED
    if ((code.match(/ALLSELECTED/gi) || []).length > 1) {
      findings.push({ severity: 'info', rule: 'ALLSELECTED',
        message: 'Multiple ALLSELECTED() calls can produce confusing shadow filter contexts. Consider capturing a base value in a VAR.' });
    }
    // = 0 or = BLANK comparisons that DIVIDE would handle
    if (/=\s*0\b/.test(code) && /\bIF\s*\(/i.test(code) && /\//.test(code)) {
      findings.push({ severity: 'info', rule: 'Divide guard',
        message: 'Looks like a manual divide-by-zero guard (IF(... = 0 ...)). DIVIDE() does this for you and is faster.' });
    }
    // Whole-table SUM without column (rare) / naked CALCULATE with TRUE()
    if (/KEEPFILTERS\s*\(\s*TRUE\s*\(\s*\)\s*\)/i.test(code)) {
      findings.push({ severity: 'info', rule: 'Placeholder filter',
        message: 'KEEPFILTERS(TRUE()) is a no-op placeholder — replace it with your real filter condition.' });
    }

    if (findings.length === 0) findings.push({ severity: 'ok', message: 'No obvious best-practice issues found. 👍' });
    // stable order: warnings first, then info, then ok
    const rank = { warning: 0, info: 1, ok: 2 };
    findings.sort((a, b) => (rank[a.severity] ?? 1) - (rank[b.severity] ?? 1) || ((a.line || 0) - (b.line || 0)));
    return findings;
  }

  function buildFallbackSolution(model, requirement, validationErrors) {
    return {
      goalRestatement: 'Could not determine a specific calculation pattern for: "' + requirement + '".',
      modelNotes: 'Try rephrasing your requirement. Examples: "total sales", "profit margin %", "YTD revenue", "3-month moving average of sales".',
      requiresNewObject: false,
      steps: [],
      finalObject: { name: '', dax: '' },
      usageTip: 'Check the supported patterns list below the input box.',
      validationErrors: validationErrors || [],
      resolvedColumns: [],
    };
  }

  // Patterns that require a date table — used to surface a validation error even
  // when the handlers bail out early (so the warning actually reaches the user).
  const TIME_INTEL_INTENTS = ['yoy', 'qoq', 'mom', 'wow', 'ytd', 'qtd', 'mtd', 'prevYear', 'prevQuarter', 'prevMonth', 'movingAvg', 'runningTotal'];

  function generateSolution(rawTables, rawRelationships, requirement, options) {
    // Reset per-generation state (column overrides + resolution log)
    _overrides = (options && options.overrides) || {};
    _resolvedLog = [];

    const model = buildModel(rawTables, rawRelationships);

    // Up-front validation: time intelligence requested but no date column anywhere
    const validationErrors = [];
    const wantsTimeIntel = TIME_INTEL_INTENTS.some(k => R[k] && R[k].test(requirement));
    if (wantsTimeIntel && !findDateInfo(model)) {
      validationErrors.push('Validation Error: The requirement uses time intelligence (YoY / YTD / previous period / running totals), but the model has no Date or DateTime column. Add a date column — ideally a dedicated Date dimension table — and mark it as a date table in Power BI.');
    }

    const subReqs = splitRequirement(requirement);
    const allSteps = [];
    const allNotes = [];
    const allTips = [];
    const finalNames = [];

    // Process each sub-requirement
    for (const subReq of subReqs) {
      const result = DAXGenerator.generate(model, subReq, allSteps);
      if (result) {
        if (result.notes) allNotes.push(...result.notes);
        if (result.tipFragment) allTips.push(result.tipFragment);
        if (result.finalName) finalNames.push(result.finalName);
      }
    }

    // If no steps were generated, give a helpful fallback
    if (allSteps.length === 0) {
      return buildFallbackSolution(model, requirement, validationErrors);
    }

    // Deduplicate steps (same name = same measure)
    const deduped = [];
    const seen = new Set();
    for (const step of allSteps) {
      if (!seen.has(step.name)) {
        seen.add(step.name);
        deduped.push(step);
      }
    }

    // Number steps sequentially
    deduped.forEach((step, i) => { step.stepNumber = i + 1; });

    // Attach format strings, display folders, and home tables
    enrichSteps(deduped, model);

    // The "final" object is the last step
    const lastStep = deduped[deduped.length - 1];

    // Build goal restatement
    const goalRestatement = finalNames.length > 0
      ? 'Calculate ' + finalNames.join(' and ') + ' — built as a dependency chain of ' + deduped.length + ' measure(s).'
      : 'Generate DAX for: ' + requirement;

    // Model notes
    const modelNotes = allNotes.length > 0 ? allNotes.join(' ') : '';

    // Usage tip
    const usageTip = allTips.length > 0
      ? allTips.join(' ')
      : 'Drag [' + lastStep.name + '] into a card, table, or matrix visual in Power BI.';

    // Run validation checks (appends to the up-front errors)
    runValidations(deduped, model, [], validationErrors);

    return {
      goalRestatement: goalRestatement,
      modelNotes: modelNotes,
      requiresNewObject: deduped.some(s => s.objectType === 'Measure' || s.objectType === 'Calculated Column'),
      steps: deduped,
      finalObject: { name: lastStep.name, dax: lastStep.dax },
      usageTip: usageTip,
      validationErrors: validationErrors,
      // which columns the engine picked for each semantic role (for the UI to expose/override)
      resolvedColumns: _resolvedLog.slice(),
    };
  }

  return {
    generateSolution,
    exportAllMeasures,
    exportTabularEditorScript,
    exportTMDL,
    lintDax,
  };
}

export const DAXEngine = __engine()
