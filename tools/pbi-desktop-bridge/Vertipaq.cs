using Dax.ViewModel;

namespace PbiDesktopBridge;

/// <summary>
/// VertiPaq Analyzer — what is eating the model's memory.
/// We do NOT re-derive the storage math from raw DMVs. Instead we call SQLBI's
/// own Dax.Model.Extractor (MIT), the same library DAX Studio and the standalone
/// VertiPaq Analyzer use, so the numbers agree with them by construction. It
/// reads the VertiPaq column statistics from the live engine and we flatten the
/// resulting VpaModel into a plain DTO the browser can render.
/// </summary>
public static class Vertipaq
{
    public sealed record VpColumn(
        string Table, string Column, string DataType, string Encoding,
        long Cardinality, long TotalSize, long DataSize, long DictionarySize,
        long HierarchiesSize, double PercentDb);

    public sealed record VpTable(
        string Name, long Rows, long TotalSize, long ColumnsSize, double PercentDb,
        int Columns);

    public sealed record VpRelationship(
        string Name, long UsedSize, bool MissingKeys);

    public sealed record VpReport(
        string Database, long ModelSize, int TableCount, int ColumnCount,
        IReadOnlyList<VpTable> Tables, IReadOnlyList<VpColumn> ColumnsList,
        IReadOnlyList<VpRelationship> Relationships);

    /// <summary>Extract storage metrics for the model on the given instance.</summary>
    public static VpReport Analyze(Instance inst)
    {
        // TomExtractor connects via AMO, which reads "Initial Catalog" — NOT the
        // ADOMD "Catalog" key. Getting this wrong yields a confusing
        // "database '' could not be found".
        var connStr = $"Data Source={inst.DataSource};Initial Catalog={inst.Database}";

        // readStatisticsFromData:true is the whole point — it reads the real
        // VertiPaq segment/dictionary sizes and column cardinalities from the
        // engine, not just metadata. sampleRows:0 = use the full model.
        var daxModel = Dax.Model.Extractor.TomExtractor.GetDaxModel(
            connStr, "DAX Workbench", "0.3.0",
            readStatisticsFromData: true,
            sampleRows: 0);

        var vpa = new VpaModel(daxModel);

        var columns = vpa.Columns
            .Select(c => new VpColumn(
                Table: c.Table.TableName,
                Column: c.ColumnName,
                DataType: c.DataType ?? "",
                Encoding: c.Encoding ?? "",
                Cardinality: c.ColumnCardinality,
                TotalSize: c.TotalSize,
                DataSize: c.DataSize,
                DictionarySize: c.DictionarySize,
                HierarchiesSize: c.HierarchiesSize,
                PercentDb: c.PercentageDatabase))
            .OrderByDescending(c => c.TotalSize)
            .ToList();

        var tables = vpa.Tables
            .Select(t => new VpTable(
                Name: t.TableName,
                Rows: t.RowsCount,
                TotalSize: t.TableSize,
                ColumnsSize: t.ColumnsTotalSize,
                PercentDb: t.PercentageDatabase,
                Columns: t.ColumnsNumber))
            .OrderByDescending(t => t.TotalSize)
            .ToList();

        var rels = vpa.Relationships
            .Select(r => new VpRelationship(
                Name: r.RelationshipFromToName,
                UsedSize: r.UsedSize,
                MissingKeys: r.MissingKeys > 0))
            .OrderByDescending(r => r.UsedSize)
            .ToList();

        var modelSize = tables.Sum(t => t.TotalSize) + rels.Sum(r => r.UsedSize);

        return new VpReport(
            Database: inst.Database,
            ModelSize: modelSize,
            TableCount: tables.Count,
            ColumnCount: columns.Count,
            Tables: tables,
            ColumnsList: columns,
            Relationships: rels);
    }
}
