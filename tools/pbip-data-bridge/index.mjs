#!/usr/bin/env node
/**
 * PBIP Data Bridge
 * -----------------
 * A browser can't reach SQL Server / databases, so a `.pbip` opened in Power BI
 * Studio can only show the model + sample data. This local CLI HAS the drivers
 * and network the browser lacks: it reads each table's Power Query (M) source,
 * pulls the real rows (SQL Server, or the referenced Excel/CSV files), and writes
 * one `<Table>.csv` per table into a `StudioData/` folder next to the project.
 *
 * Then drop the project folder into the Studio again — it binds each
 * `<Table>.csv` to its table automatically, giving you REAL numbers.
 *
 * Usage:
 *   node index.mjs "<path-to-pbip-folder>" [connection options]
 *
 * SQL auth:      --server HOST\INSTANCE --database DB --user U --password P
 * Windows auth:  --server HOST\INSTANCE --database DB --trusted
 *                (Windows auth needs the msnodesqlv8 driver — see README.)
 *
 * Install once (in this folder):  npm install
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

// ---- tiny arg parser ----
const args = process.argv.slice(2)
const folder = args.find((a) => !a.startsWith('--'))
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1]?.startsWith('--') || i + 1 >= args.length ? true : args[i + 1]) : def
}
if (!folder) {
  console.error('Usage: node index.mjs "<pbip-folder>" --server HOST\\INSTANCE --database DB [--user U --password P | --trusted]')
  process.exit(1)
}

const cfg = {
  server: opt('server'),
  database: opt('database'),
  user: opt('user'),
  password: opt('password'),
  trusted: !!opt('trusted', false),
}

// ---- locate the semantic model ----
function findTableTmdls(root) {
  // walk for  *.SemanticModel/definition/tables/*.tmdl
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tmdl$/i.test(e.name) && /[\\/]definition[\\/]tables[\\/]/i.test(p)) out.push(p)
    }
  }
  walk(root)
  return out
}

// ---- classify + extract the M source (mirrors the Studio's classifier) ----
function partitionSource(tmdl) {
  const m = tmdl.match(/partition[^\n]*=\s*m[\s\S]*?source\s*=([\s\S]*?)(?:\n\tannotation|\n\tpartition|\n\ttable|\s*$)/i)
  return m ? m[1] : ''
}
function tableName(tmdl) {
  return (tmdl.match(/^table\s+(.+)$/m)?.[1] ?? 'Table').replace(/^'|'$/g, '').trim()
}
function classify(src) {
  if (/\bTable\.FromRows\b|#table\b/.test(src)) return { kind: 'inline' }
  const file = (src.match(/(?:Excel\.Workbook|Csv\.Document)\s*\(\s*File\.Contents\s*\(\s*"([^"]+)"/i) ?? [])[1]
  if (file) return { kind: 'file', file }
  if (/\bSql\.Databases?\b/.test(src)) {
    const schema = (src.match(/Schema\s*=\s*"([^"]+)"/i) ?? [])[1] ?? 'dbo'
    const item = (src.match(/Item\s*=\s*"([^"]+)"/i) ?? [])[1]
    return { kind: 'sql', schema, item }
  }
  return { kind: 'other' }
}

// ---- CSV writer ----
const csvCell = (v) => {
  if (v == null) return ''
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (headers, rows) => [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n')

async function main() {
  const tmdls = findTableTmdls(folder)
  if (tmdls.length === 0) {
    console.error(`No *.SemanticModel/definition/tables/*.tmdl found under ${folder}`)
    process.exit(1)
  }
  const outDir = join(folder, 'StudioData')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  const tables = tmdls.map((p) => {
    const text = readFileSync(p, 'utf8')
    return { name: tableName(text), src: classify(partitionSource(text)), path: p }
  })

  const sql = tables.filter((t) => t.src.kind === 'sql')
  console.log(`Found ${tables.length} tables — ${sql.length} SQL, ${tables.filter((t) => t.src.kind === 'file').length} file, ${tables.filter((t) => t.src.kind === 'inline').length} inline.`)

  // ---- file-based tables ----
  let XLSX = null
  for (const t of tables.filter((t) => t.src.kind === 'file')) {
    try {
      const dir = dirname(t.path).replace(/[\\/][^\\/]+\.SemanticModel[\s\S]*/i, '') // project root-ish
      const found = findFile(folder, basename(t.src.file))
      if (!found) { console.warn(`  ⚠ ${t.name}: file ${t.src.file} not found in folder`); continue }
      if (/\.(xlsx|xls|xlsm)$/i.test(found)) {
        XLSX ??= (await import('xlsx')).default ?? (await import('xlsx'))
        const wb = XLSX.readFile(found)
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false })
        writeFileSync(join(outDir, `${t.name}.csv`), toCsv(aoa[0].map(String), aoa.slice(1)))
      } else {
        writeFileSync(join(outDir, `${t.name}.csv`), readFileSync(found))
      }
      console.log(`  ✓ ${t.name}  (file: ${basename(found)})`)
      void dir
    } catch (e) {
      console.warn(`  ⚠ ${t.name}: ${e.message}`)
    }
  }

  // ---- SQL tables ----
  if (sql.length) {
    if (!cfg.server || !cfg.database) {
      console.error('\nSQL tables need --server and --database (and --user/--password, or --trusted).')
      process.exit(1)
    }
    let mssql
    try { mssql = (await import('mssql')).default } catch { console.error('\nInstall the SQL driver:  npm install mssql   (or msnodesqlv8 for Windows auth)'); process.exit(1) }
    const pool = await mssql.connect(
      cfg.trusted
        ? { server: cfg.server, database: cfg.database, options: { trustServerCertificate: true, trustedConnection: true } }
        : { server: cfg.server, database: cfg.database, user: cfg.user, password: cfg.password, options: { trustServerCertificate: true } },
    )
    for (const t of sql) {
      try {
        const from = `[${t.src.schema}].[${t.src.item ?? t.name}]`
        const rs = await pool.request().query(`SELECT * FROM ${from}`)
        const cols = rs.recordset.columns ? Object.keys(rs.recordset.columns) : Object.keys(rs.recordset[0] ?? {})
        const rows = rs.recordset.map((r) => cols.map((c) => r[c]))
        writeFileSync(join(outDir, `${t.name}.csv`), toCsv(cols, rows))
        console.log(`  ✓ ${t.name}  (${rows.length} rows from ${from})`)
      } catch (e) {
        console.warn(`  ⚠ ${t.name}: ${e.message}`)
      }
    }
    await pool.close()
  }

  console.log(`\nDone. Wrote CSVs to:\n  ${outDir}\nNow drop the project folder into Power BI Studio — it binds each <Table>.csv as real data.`)
}

function findFile(root, name) {
  let hit = null
  const walk = (dir) => {
    if (hit) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (hit) return
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.toLowerCase() === name.toLowerCase()) hit = p
    }
  }
  walk(root)
  return hit
}

main().catch((e) => { console.error(e); process.exit(1) })
