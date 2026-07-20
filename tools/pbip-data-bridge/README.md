# PBIP Data Bridge

A browser **cannot** connect to SQL Server or other databases — no drivers, no
network, sandboxed. So a `.pbip` opened in **DAX Workbench** shows the model +
**sample** data for any SQL/database-backed table.

This tiny local CLI closes that gap. It runs on your machine (where the drivers
and DB access live), reads each table's Power Query (M) source from the project,
pulls the **real rows**, and writes one `<Table>.csv` per table into a
`StudioData/` folder next to the project.

Then **drop the project folder into the Workbench again** — it binds each
`<Table>.csv` to its table automatically. Real numbers everywhere.

```
PBIP folder ──(this bridge, locally)──▶ StudioData/*.csv ──(drop folder)──▶ Workbench = real data
```

## Setup

```bash
cd tools/pbip-data-bridge
npm install          # installs mssql + xlsx
```

For **Windows integrated auth** (e.g. `SERVER\SQLEXPRESS` with no user/password),
also install the native driver:

```bash
npm install msnodesqlv8
```

## Run

**SQL auth:**
```bash
node index.mjs "E:\path\to\Medical_Legal_BI_Project" \
  --server "R1SH4V\SQLEXPRESS" --database "MedLegalBI" \
  --user "sa" --password "***"
```

**Windows (trusted) auth:**
```bash
node index.mjs "E:\path\to\Medical_Legal_BI_Project" \
  --server "R1SH4V\SQLEXPRESS" --database "MedLegalBI" --trusted
```

It prints what it found and wrote, e.g.:

```
Found 21 tables — 13 SQL, 2 file, 2 inline.
  ✓ Attorney Master List  (file: Attorney_Roster.xlsx)
  ✓ Fact_Cases            (4213 rows from [dbo].[vw_CaseDetails])
  ...
Done. Wrote CSVs to: ...\StudioData
```

## What it handles

| M source | Action |
|---|---|
| `Sql.Database(...)` | `SELECT * FROM [schema].[item]` → CSV |
| `Excel.Workbook` / `Csv.Document` (file in folder) | read file → CSV |
| `Table.FromRows` (inline) | already in the model; the Workbench reads it directly |
| Web / OData / other | not yet — export manually to CSV and drop it in as `<Table>.csv` |

## Notes

- The bridge does **not** re-run Power Query transformations (joins, merges,
  custom steps). It pulls the base table/view named in the source. For most
  models that is the data you want; if a table is heavily transformed in M,
  point it at the final view or export that query to CSV manually.
- Nothing leaves your machine — it only writes local CSVs.
