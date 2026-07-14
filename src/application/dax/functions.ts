/**
 * APPLICATION — DAX Function Library
 * A structured, comprehensive catalog of DAX functions across every category.
 * Designed to power the DAX editor (autocomplete + reference) AND to be a
 * machine-readable knowledge base an AI layer can ground on.
 *
 * Each entry: name, category, syntax signature, one-line description.
 */

export type DaxCategory =
  | 'Aggregation'
  | 'Filter'
  | 'Time Intelligence'
  | 'Logical'
  | 'Math & Trig'
  | 'Statistical'
  | 'Text'
  | 'Date & Time'
  | 'Information'
  | 'Table'
  | 'Relationship'
  | 'Financial'
  | 'Conversion'
  | 'Window'
  | 'Parent-Child'

export interface DaxFunction {
  name: string
  category: DaxCategory
  syntax: string
  description: string
}

const f = (name: string, category: DaxCategory, syntax: string, description: string): DaxFunction => ({
  name,
  category,
  syntax,
  description,
})

export const DAX_FUNCTIONS: DaxFunction[] = [
  // ---- Aggregation ----
  f('SUM', 'Aggregation', 'SUM(<column>)', 'Adds all the numbers in a column.'),
  f('SUMX', 'Aggregation', 'SUMX(<table>, <expression>)', 'Sums an expression evaluated per row of a table.'),
  f('AVERAGE', 'Aggregation', 'AVERAGE(<column>)', 'Arithmetic mean of the numbers in a column.'),
  f('AVERAGEX', 'Aggregation', 'AVERAGEX(<table>, <expression>)', 'Average of an expression evaluated per row.'),
  f('AVERAGEA', 'Aggregation', 'AVERAGEA(<column>)', 'Average of a column, treating text/booleans as numbers.'),
  f('MIN', 'Aggregation', 'MIN(<column>)', 'Smallest value in a column.'),
  f('MINX', 'Aggregation', 'MINX(<table>, <expression>)', 'Minimum of an expression evaluated per row.'),
  f('MINA', 'Aggregation', 'MINA(<column>)', 'Minimum including logical values and text.'),
  f('MAX', 'Aggregation', 'MAX(<column>)', 'Largest value in a column.'),
  f('MAXX', 'Aggregation', 'MAXX(<table>, <expression>)', 'Maximum of an expression evaluated per row.'),
  f('MAXA', 'Aggregation', 'MAXA(<column>)', 'Maximum including logical values and text.'),
  f('COUNT', 'Aggregation', 'COUNT(<column>)', 'Counts numeric/date values in a column.'),
  f('COUNTA', 'Aggregation', 'COUNTA(<column>)', 'Counts non-blank values in a column.'),
  f('COUNTX', 'Aggregation', 'COUNTX(<table>, <expression>)', 'Counts non-blank results of an expression per row.'),
  f('COUNTAX', 'Aggregation', 'COUNTAX(<table>, <expression>)', 'Counts non-blank (any type) expression results.'),
  f('COUNTROWS', 'Aggregation', 'COUNTROWS(<table>)', 'Counts the number of rows in a table.'),
  f('COUNTBLANK', 'Aggregation', 'COUNTBLANK(<column>)', 'Counts blank values in a column.'),
  f('DISTINCTCOUNT', 'Aggregation', 'DISTINCTCOUNT(<column>)', 'Counts distinct values, blank included.'),
  f('DISTINCTCOUNTNOBLANK', 'Aggregation', 'DISTINCTCOUNTNOBLANK(<column>)', 'Counts distinct values excluding blank.'),
  f('PRODUCT', 'Aggregation', 'PRODUCT(<column>)', 'Multiplies all numbers in a column.'),
  f('PRODUCTX', 'Aggregation', 'PRODUCTX(<table>, <expression>)', 'Product of an expression evaluated per row.'),
  f('CONCATENATEX', 'Aggregation', 'CONCATENATEX(<table>, <expression>, [<delimiter>])', 'Concatenates an expression across rows.'),

  // ---- Filter ----
  f('CALCULATE', 'Filter', 'CALCULATE(<expression>, [<filter1>], …)', 'Evaluates an expression in a modified filter context.'),
  f('CALCULATETABLE', 'Filter', 'CALCULATETABLE(<table>, [<filter1>], …)', 'Evaluates a table expression in a modified filter context.'),
  f('FILTER', 'Filter', 'FILTER(<table>, <condition>)', 'Returns rows of a table meeting a condition.'),
  f('ALL', 'Filter', 'ALL([<table> | <column>, …])', 'Removes filters from a table or columns.'),
  f('ALLEXCEPT', 'Filter', 'ALLEXCEPT(<table>, <column1>, …)', 'Removes all filters except the specified columns.'),
  f('ALLSELECTED', 'Filter', 'ALLSELECTED([<table>|<column>])', 'Filter context from outside the current query but inside slicers.'),
  f('ALLNOBLANKROW', 'Filter', 'ALLNOBLANKROW(<table>|<column>)', 'All rows except the blank row from relationships.'),
  f('ALLCROSSFILTERED', 'Filter', 'ALLCROSSFILTERED(<table>)', 'Clears filters applied to a table by cross-filtering.'),
  f('KEEPFILTERS', 'Filter', 'KEEPFILTERS(<expression>)', 'Preserves existing filters when adding new ones in CALCULATE.'),
  f('REMOVEFILTERS', 'Filter', 'REMOVEFILTERS([<table>|<column>, …])', 'Removes filters (modern ALL for CALCULATE).'),
  f('VALUES', 'Filter', 'VALUES(<column>|<table>)', 'Distinct values, including the blank row.'),
  f('DISTINCT', 'Filter', 'DISTINCT(<column>|<table>)', 'Distinct values, excluding the blank row.'),
  f('EARLIER', 'Filter', 'EARLIER(<column>, [<number>])', 'Value of a column in an outer evaluation pass.'),
  f('EARLIEST', 'Filter', 'EARLIEST(<column>)', 'Value from the outermost evaluation pass.'),
  f('HASONEVALUE', 'Filter', 'HASONEVALUE(<column>)', 'TRUE when the column is filtered to a single value.'),
  f('HASONEFILTER', 'Filter', 'HASONEFILTER(<column>)', 'TRUE when exactly one value is directly filtering a column.'),
  f('ISFILTERED', 'Filter', 'ISFILTERED(<column>)', 'TRUE when the column is being filtered directly.'),
  f('ISCROSSFILTERED', 'Filter', 'ISCROSSFILTERED(<column>)', 'TRUE when a column is filtered by another column.'),
  f('SELECTEDVALUE', 'Filter', 'SELECTEDVALUE(<column>, [<alternate>])', 'The single filtered value, or an alternate.'),
  f('FIRSTNONBLANK', 'Filter', 'FIRSTNONBLANK(<column>, <expression>)', 'First value where the expression is non-blank.'),
  f('LASTNONBLANK', 'Filter', 'LASTNONBLANK(<column>, <expression>)', 'Last value where the expression is non-blank.'),
  f('CALCULATE', 'Filter', 'CALCULATE(<expression>, <filter>)', 'Core context-transition & filtering engine of DAX.'),

  // ---- Relationship ----
  f('RELATED', 'Relationship', 'RELATED(<column>)', 'Fetches a related value from the one-side of a relationship.'),
  f('RELATEDTABLE', 'Relationship', 'RELATEDTABLE(<table>)', 'Related rows from the many-side of a relationship.'),
  f('USERELATIONSHIP', 'Relationship', 'USERELATIONSHIP(<col1>, <col2>)', 'Activates an inactive relationship within CALCULATE.'),
  f('CROSSFILTER', 'Relationship', 'CROSSFILTER(<col1>, <col2>, <direction>)', 'Sets cross-filter direction within CALCULATE.'),
  f('TREATAS', 'Relationship', 'TREATAS(<table>, <column>, …)', 'Applies a table as a virtual relationship filter.'),
  f('LOOKUPVALUE', 'Relationship', 'LOOKUPVALUE(<result>, <search_col>, <search_val>, …)', 'Returns a value by matching search columns.'),

  // ---- Time Intelligence ----
  f('TOTALYTD', 'Time Intelligence', 'TOTALYTD(<expression>, <dates>, [<filter>], [<year_end>])', 'Year-to-date total of an expression.'),
  f('TOTALQTD', 'Time Intelligence', 'TOTALQTD(<expression>, <dates>)', 'Quarter-to-date total.'),
  f('TOTALMTD', 'Time Intelligence', 'TOTALMTD(<expression>, <dates>)', 'Month-to-date total.'),
  f('DATESYTD', 'Time Intelligence', 'DATESYTD(<dates>, [<year_end>])', 'Set of dates from year start to current.'),
  f('DATESQTD', 'Time Intelligence', 'DATESQTD(<dates>)', 'Dates from quarter start to current.'),
  f('DATESMTD', 'Time Intelligence', 'DATESMTD(<dates>)', 'Dates from month start to current.'),
  f('SAMEPERIODLASTYEAR', 'Time Intelligence', 'SAMEPERIODLASTYEAR(<dates>)', 'Same dates shifted back one year.'),
  f('PREVIOUSYEAR', 'Time Intelligence', 'PREVIOUSYEAR(<dates>, [<year_end>])', 'All dates of the previous year.'),
  f('PREVIOUSQUARTER', 'Time Intelligence', 'PREVIOUSQUARTER(<dates>)', 'All dates of the previous quarter.'),
  f('PREVIOUSMONTH', 'Time Intelligence', 'PREVIOUSMONTH(<dates>)', 'All dates of the previous month.'),
  f('PREVIOUSDAY', 'Time Intelligence', 'PREVIOUSDAY(<dates>)', 'The previous day.'),
  f('NEXTYEAR', 'Time Intelligence', 'NEXTYEAR(<dates>)', 'All dates of the next year.'),
  f('NEXTMONTH', 'Time Intelligence', 'NEXTMONTH(<dates>)', 'All dates of the next month.'),
  f('DATEADD', 'Time Intelligence', 'DATEADD(<dates>, <number>, <interval>)', 'Shifts dates by an interval (YEAR/QUARTER/MONTH/DAY).'),
  f('DATESBETWEEN', 'Time Intelligence', 'DATESBETWEEN(<dates>, <start>, <end>)', 'Dates between two boundaries.'),
  f('DATESINPERIOD', 'Time Intelligence', 'DATESINPERIOD(<dates>, <start>, <number>, <interval>)', 'A rolling window of dates.'),
  f('PARALLELPERIOD', 'Time Intelligence', 'PARALLELPERIOD(<dates>, <number>, <interval>)', 'A parallel period shifted in time.'),
  f('STARTOFYEAR', 'Time Intelligence', 'STARTOFYEAR(<dates>)', 'First date of the year in context.'),
  f('STARTOFMONTH', 'Time Intelligence', 'STARTOFMONTH(<dates>)', 'First date of the month in context.'),
  f('ENDOFYEAR', 'Time Intelligence', 'ENDOFYEAR(<dates>)', 'Last date of the year in context.'),
  f('ENDOFMONTH', 'Time Intelligence', 'ENDOFMONTH(<dates>)', 'Last date of the month in context.'),
  f('FIRSTDATE', 'Time Intelligence', 'FIRSTDATE(<dates>)', 'Earliest date in the current context.'),
  f('LASTDATE', 'Time Intelligence', 'LASTDATE(<dates>)', 'Latest date in the current context.'),
  f('CLOSINGBALANCEMONTH', 'Time Intelligence', 'CLOSINGBALANCEMONTH(<expression>, <dates>)', 'Value at the last date of the month.'),
  f('OPENINGBALANCEYEAR', 'Time Intelligence', 'OPENINGBALANCEYEAR(<expression>, <dates>)', 'Value at the last date of the previous year.'),
  f('CALENDAR', 'Time Intelligence', 'CALENDAR(<start_date>, <end_date>)', 'A single-column date table between two dates.'),
  f('CALENDARAUTO', 'Time Intelligence', 'CALENDARAUTO([<fiscal_month>])', 'A date table spanning the model’s dates.'),

  // ---- Logical ----
  f('IF', 'Logical', 'IF(<test>, <then>, [<else>])', 'Conditional branch.'),
  f('IF.EAGER', 'Logical', 'IF.EAGER(<test>, <then>, [<else>])', 'IF that evaluates both branches eagerly.'),
  f('IFERROR', 'Logical', 'IFERROR(<value>, <value_if_error>)', 'Returns an alternate value on error.'),
  f('SWITCH', 'Logical', 'SWITCH(<expression>, <value>, <result>, …, [<else>])', 'Multi-branch selection.'),
  f('AND', 'Logical', 'AND(<a>, <b>)', 'Logical AND of two conditions.'),
  f('OR', 'Logical', 'OR(<a>, <b>)', 'Logical OR of two conditions.'),
  f('NOT', 'Logical', 'NOT(<logical>)', 'Logical negation.'),
  f('TRUE', 'Logical', 'TRUE()', 'Logical TRUE.'),
  f('FALSE', 'Logical', 'FALSE()', 'Logical FALSE.'),
  f('COALESCE', 'Logical', 'COALESCE(<value1>, <value2>, …)', 'First non-blank argument.'),

  // ---- Information ----
  f('ISBLANK', 'Information', 'ISBLANK(<value>)', 'TRUE if the value is blank.'),
  f('ISERROR', 'Information', 'ISERROR(<value>)', 'TRUE if the value is an error.'),
  f('ISNUMBER', 'Information', 'ISNUMBER(<value>)', 'TRUE if the value is numeric.'),
  f('ISTEXT', 'Information', 'ISTEXT(<value>)', 'TRUE if the value is text.'),
  f('ISNONTEXT', 'Information', 'ISNONTEXT(<value>)', 'TRUE if the value is not text.'),
  f('ISLOGICAL', 'Information', 'ISLOGICAL(<value>)', 'TRUE if the value is boolean.'),
  f('ISEVEN', 'Information', 'ISEVEN(<number>)', 'TRUE if the number is even.'),
  f('ISODD', 'Information', 'ISODD(<number>)', 'TRUE if the number is odd.'),
  f('ISINSCOPE', 'Information', 'ISINSCOPE(<column>)', 'TRUE if the column is a grouping level in scope.'),
  f('ISEMPTY', 'Information', 'ISEMPTY(<table>)', 'TRUE if the table has no rows.'),
  f('ISSELECTEDMEASURE', 'Information', 'ISSELECTEDMEASURE(<measure>, …)', 'TRUE if the current measure is one listed (calc groups).'),
  f('CONTAINS', 'Information', 'CONTAINS(<table>, <column>, <value>, …)', 'TRUE if a row exists with the given values.'),
  f('CONTAINSSTRING', 'Information', 'CONTAINSSTRING(<within>, <find>)', 'TRUE if one string contains another (case-insensitive).'),
  f('CONTAINSROW', 'Information', 'CONTAINSROW(<table>, <value>, …)', 'TRUE if the table contains the row.'),
  f('USERNAME', 'Information', 'USERNAME()', 'Domain\\user of the current user.'),
  f('USERPRINCIPALNAME', 'Information', 'USERPRINCIPALNAME()', 'The user principal name (UPN).'),

  // ---- Math & Trig ----
  f('DIVIDE', 'Math & Trig', 'DIVIDE(<numerator>, <denominator>, [<alternate>])', 'Safe division that avoids divide-by-zero errors.'),
  f('ABS', 'Math & Trig', 'ABS(<number>)', 'Absolute value.'),
  f('SQRT', 'Math & Trig', 'SQRT(<number>)', 'Square root.'),
  f('POWER', 'Math & Trig', 'POWER(<number>, <power>)', 'Number raised to a power.'),
  f('EXP', 'Math & Trig', 'EXP(<number>)', 'e raised to a power.'),
  f('LN', 'Math & Trig', 'LN(<number>)', 'Natural logarithm.'),
  f('LOG', 'Math & Trig', 'LOG(<number>, [<base>])', 'Logarithm to a base.'),
  f('LOG10', 'Math & Trig', 'LOG10(<number>)', 'Base-10 logarithm.'),
  f('SIGN', 'Math & Trig', 'SIGN(<number>)', 'Sign of a number (-1, 0, 1).'),
  f('ROUND', 'Math & Trig', 'ROUND(<number>, <digits>)', 'Rounds to a number of digits.'),
  f('ROUNDUP', 'Math & Trig', 'ROUNDUP(<number>, <digits>)', 'Rounds away from zero.'),
  f('ROUNDDOWN', 'Math & Trig', 'ROUNDDOWN(<number>, <digits>)', 'Rounds toward zero.'),
  f('MROUND', 'Math & Trig', 'MROUND(<number>, <multiple>)', 'Rounds to the nearest multiple.'),
  f('TRUNC', 'Math & Trig', 'TRUNC(<number>, [<digits>])', 'Truncates to an integer or digits.'),
  f('INT', 'Math & Trig', 'INT(<number>)', 'Rounds down to the nearest integer.'),
  f('FLOOR', 'Math & Trig', 'FLOOR(<number>, <significance>)', 'Rounds down to a multiple of significance.'),
  f('CEILING', 'Math & Trig', 'CEILING(<number>, <significance>)', 'Rounds up to a multiple of significance.'),
  f('MOD', 'Math & Trig', 'MOD(<number>, <divisor>)', 'Remainder after division.'),
  f('QUOTIENT', 'Math & Trig', 'QUOTIENT(<numerator>, <denominator>)', 'Integer portion of a division.'),
  f('FACT', 'Math & Trig', 'FACT(<number>)', 'Factorial.'),
  f('GCD', 'Math & Trig', 'GCD(<number1>, …)', 'Greatest common divisor.'),
  f('LCM', 'Math & Trig', 'LCM(<number1>, …)', 'Least common multiple.'),
  f('PI', 'Math & Trig', 'PI()', 'The constant π.'),
  f('RAND', 'Math & Trig', 'RAND()', 'Random number between 0 and 1.'),
  f('RANDBETWEEN', 'Math & Trig', 'RANDBETWEEN(<bottom>, <top>)', 'Random integer in a range.'),
  f('EVEN', 'Math & Trig', 'EVEN(<number>)', 'Rounds up to the nearest even integer.'),
  f('ODD', 'Math & Trig', 'ODD(<number>)', 'Rounds up to the nearest odd integer.'),
  f('SIN', 'Math & Trig', 'SIN(<number>)', 'Sine.'),
  f('COS', 'Math & Trig', 'COS(<number>)', 'Cosine.'),
  f('TAN', 'Math & Trig', 'TAN(<number>)', 'Tangent.'),
  f('DEGREES', 'Math & Trig', 'DEGREES(<radians>)', 'Radians to degrees.'),
  f('RADIANS', 'Math & Trig', 'RADIANS(<degrees>)', 'Degrees to radians.'),

  // ---- Statistical ----
  f('RANKX', 'Statistical', 'RANKX(<table>, <expression>, [<value>], [<order>], [<ties>])', 'Ranks an expression over a table.'),
  f('RANK.EQ', 'Statistical', 'RANK.EQ(<value>, <column>, [<order>])', 'Rank of a value in a column.'),
  f('TOPN', 'Statistical', 'TOPN(<n>, <table>, <orderBy>, [<order>], …)', 'Top N rows of a table by an expression.'),
  f('SAMPLE', 'Statistical', 'SAMPLE(<n>, <table>, <orderBy>, …)', 'An evenly-spaced sample of N rows.'),
  f('MEDIAN', 'Statistical', 'MEDIAN(<column>)', 'Median value of a column.'),
  f('MEDIANX', 'Statistical', 'MEDIANX(<table>, <expression>)', 'Median of an expression per row.'),
  f('PERCENTILE.INC', 'Statistical', 'PERCENTILE.INC(<column>, <k>)', 'k-th percentile, inclusive.'),
  f('PERCENTILE.EXC', 'Statistical', 'PERCENTILE.EXC(<column>, <k>)', 'k-th percentile, exclusive.'),
  f('STDEV.P', 'Statistical', 'STDEV.P(<column>)', 'Population standard deviation.'),
  f('STDEV.S', 'Statistical', 'STDEV.S(<column>)', 'Sample standard deviation.'),
  f('VAR.P', 'Statistical', 'VAR.P(<column>)', 'Population variance.'),
  f('VAR.S', 'Statistical', 'VAR.S(<column>)', 'Sample variance.'),
  f('GEOMEAN', 'Statistical', 'GEOMEAN(<column>)', 'Geometric mean.'),
  f('NORM.DIST', 'Statistical', 'NORM.DIST(<x>, <mean>, <stdev>, <cumulative>)', 'Normal distribution.'),
  f('BETA.DIST', 'Statistical', 'BETA.DIST(<x>, <alpha>, <beta>, <cumulative>, …)', 'Beta distribution.'),
  f('POISSON.DIST', 'Statistical', 'POISSON.DIST(<x>, <mean>, <cumulative>)', 'Poisson distribution.'),

  // ---- Text ----
  f('CONCATENATE', 'Text', 'CONCATENATE(<text1>, <text2>)', 'Joins two text strings.'),
  f('FORMAT', 'Text', 'FORMAT(<value>, <format_string>)', 'Formats a value using a format string.'),
  f('LEFT', 'Text', 'LEFT(<text>, <num_chars>)', 'Leftmost characters.'),
  f('RIGHT', 'Text', 'RIGHT(<text>, <num_chars>)', 'Rightmost characters.'),
  f('MID', 'Text', 'MID(<text>, <start>, <num_chars>)', 'Substring from a position.'),
  f('LEN', 'Text', 'LEN(<text>)', 'Number of characters.'),
  f('UPPER', 'Text', 'UPPER(<text>)', 'Uppercase.'),
  f('LOWER', 'Text', 'LOWER(<text>)', 'Lowercase.'),
  f('TRIM', 'Text', 'TRIM(<text>)', 'Removes extra spaces.'),
  f('SUBSTITUTE', 'Text', 'SUBSTITUTE(<text>, <old>, <new>, [<instance>])', 'Replaces text.'),
  f('REPLACE', 'Text', 'REPLACE(<old>, <start>, <length>, <new>)', 'Replaces by position.'),
  f('SEARCH', 'Text', 'SEARCH(<find>, <within>, [<start>], [<not_found>])', 'Position of text (case-insensitive).'),
  f('FIND', 'Text', 'FIND(<find>, <within>, [<start>], [<not_found>])', 'Position of text (case-sensitive).'),
  f('REPT', 'Text', 'REPT(<text>, <times>)', 'Repeats text.'),
  f('VALUE', 'Text', 'VALUE(<text>)', 'Converts text to a number.'),
  f('COMBINEVALUES', 'Text', 'COMBINEVALUES(<delimiter>, <expr1>, …)', 'Joins values with a delimiter (relationship-safe).'),
  f('UNICHAR', 'Text', 'UNICHAR(<number>)', 'The Unicode character for a code.'),

  // ---- Date & Time ----
  f('DATE', 'Date & Time', 'DATE(<year>, <month>, <day>)', 'Builds a date value.'),
  f('TIME', 'Date & Time', 'TIME(<hour>, <minute>, <second>)', 'Builds a time value.'),
  f('NOW', 'Date & Time', 'NOW()', 'Current date and time.'),
  f('TODAY', 'Date & Time', 'TODAY()', 'Current date.'),
  f('YEAR', 'Date & Time', 'YEAR(<date>)', 'The year.'),
  f('MONTH', 'Date & Time', 'MONTH(<date>)', 'The month (1–12).'),
  f('DAY', 'Date & Time', 'DAY(<date>)', 'The day of month.'),
  f('HOUR', 'Date & Time', 'HOUR(<datetime>)', 'The hour.'),
  f('MINUTE', 'Date & Time', 'MINUTE(<datetime>)', 'The minute.'),
  f('SECOND', 'Date & Time', 'SECOND(<datetime>)', 'The second.'),
  f('WEEKDAY', 'Date & Time', 'WEEKDAY(<date>, [<return_type>])', 'Day of the week as a number.'),
  f('WEEKNUM', 'Date & Time', 'WEEKNUM(<date>, [<return_type>])', 'Week number of the year.'),
  f('QUARTER', 'Date & Time', 'QUARTER(<date>)', 'The quarter (1–4).'),
  f('EOMONTH', 'Date & Time', 'EOMONTH(<start>, <months>)', 'End of month, offset by months.'),
  f('EDATE', 'Date & Time', 'EDATE(<start>, <months>)', 'A date offset by months.'),
  f('DATEDIFF', 'Date & Time', 'DATEDIFF(<start>, <end>, <interval>)', 'Difference between dates in an interval.'),
  f('DATEVALUE', 'Date & Time', 'DATEVALUE(<date_text>)', 'Converts text to a date.'),
  f('YEARFRAC', 'Date & Time', 'YEARFRAC(<start>, <end>, [<basis>])', 'Fraction of a year between dates.'),
  f('NETWORKDAYS', 'Date & Time', 'NETWORKDAYS(<start>, <end>, [<weekend>], [<holidays>])', 'Count of working days.'),

  // ---- Table ----
  f('ADDCOLUMNS', 'Table', 'ADDCOLUMNS(<table>, <name>, <expression>, …)', 'Adds calculated columns to a table.'),
  f('SUMMARIZE', 'Table', 'SUMMARIZE(<table>, <groupBy>, …, [<name>, <expr>, …])', 'Groups a table and adds summaries.'),
  f('SUMMARIZECOLUMNS', 'Table', 'SUMMARIZECOLUMNS(<groupBy>, …, [<filter>], [<name>, <expr>])', 'Modern grouping/summarizing engine.'),
  f('SELECTCOLUMNS', 'Table', 'SELECTCOLUMNS(<table>, <name>, <expression>, …)', 'Projects specific columns.'),
  f('ROW', 'Table', 'ROW(<name>, <expression>, …)', 'A single-row table.'),
  f('DATATABLE', 'Table', 'DATATABLE(<name>, <type>, …, {{…}})', 'An inline constant table.'),
  f('GENERATESERIES', 'Table', 'GENERATESERIES(<start>, <end>, [<step>])', 'A single-column numeric series.'),
  f('GROUPBY', 'Table', 'GROUPBY(<table>, <groupBy>, …, [<name>, <expr>])', 'Groups without context transition (CURRENTGROUP).'),
  f('CROSSJOIN', 'Table', 'CROSSJOIN(<table1>, <table2>, …)', 'Cartesian product of tables.'),
  f('UNION', 'Table', 'UNION(<table1>, <table2>, …)', 'Appends tables with matching columns.'),
  f('INTERSECT', 'Table', 'INTERSECT(<table1>, <table2>)', 'Rows common to both tables.'),
  f('EXCEPT', 'Table', 'EXCEPT(<table1>, <table2>)', 'Rows in the first table not in the second.'),
  f('NATURALINNERJOIN', 'Table', 'NATURALINNERJOIN(<left>, <right>)', 'Inner join on common columns.'),
  f('NATURALLEFTOUTERJOIN', 'Table', 'NATURALLEFTOUTERJOIN(<left>, <right>)', 'Left outer join on common columns.'),
  f('GENERATE', 'Table', 'GENERATE(<table1>, <table2>)', 'Row-context join of two tables.'),
  f('TOPN', 'Table', 'TOPN(<n>, <table>, <orderBy>, [<order>])', 'Top N rows of a table.'),

  // ---- Window (DAX window functions) ----
  f('WINDOW', 'Window', 'WINDOW(<from>, <fromType>, <to>, <toType>, <relation>, [<orderBy>], [<partitionBy>])', 'Rows within a moving window.'),
  f('OFFSET', 'Window', 'OFFSET(<delta>, [<relation>], [<orderBy>], [<partitionBy>])', 'A row offset from the current one.'),
  f('INDEX', 'Window', 'INDEX(<position>, [<relation>], [<orderBy>], [<partitionBy>])', 'The row at an absolute position.'),
  f('RANK', 'Window', 'RANK([<ties>], [<relation>], [<orderBy>], [<partitionBy>])', 'Rank of the current row in a partition.'),
  f('ROWNUMBER', 'Window', 'ROWNUMBER([<relation>], [<orderBy>], [<partitionBy>])', 'Sequential number of the current row.'),
  f('MOVINGAVERAGE', 'Window', 'MOVINGAVERAGE(<relation>, <numberOfRows>, …)', 'Moving average over a window of rows.'),
  f('RUNNINGSUM', 'Window', 'RUNNINGSUM(<relation>, …)', 'Cumulative running sum over a window.'),
  f('ORDERBY', 'Window', 'ORDERBY(<expression>, [<order>])', 'Sort order for window functions.'),
  f('PARTITIONBY', 'Window', 'PARTITIONBY(<column>, …)', 'Partition columns for window functions.'),

  // ---- Financial ----
  f('PMT', 'Financial', 'PMT(<rate>, <nper>, <pv>, [<fv>], [<type>])', 'Payment for a loan.'),
  f('FV', 'Financial', 'FV(<rate>, <nper>, <pmt>, [<pv>], [<type>])', 'Future value of an investment.'),
  f('PV', 'Financial', 'PV(<rate>, <nper>, <pmt>, [<fv>], [<type>])', 'Present value.'),
  f('NPER', 'Financial', 'NPER(<rate>, <pmt>, <pv>, [<fv>], [<type>])', 'Number of periods.'),
  f('RATE', 'Financial', 'RATE(<nper>, <pmt>, <pv>, [<fv>], [<type>], [<guess>])', 'Interest rate per period.'),
  f('IPMT', 'Financial', 'IPMT(<rate>, <per>, <nper>, <pv>, …)', 'Interest portion of a payment.'),
  f('PPMT', 'Financial', 'PPMT(<rate>, <per>, <nper>, <pv>, …)', 'Principal portion of a payment.'),
  f('XNPV', 'Financial', 'XNPV(<table>, <values>, <dates>, <rate>)', 'Net present value for irregular cash flows.'),
  f('XIRR', 'Financial', 'XIRR(<table>, <values>, <dates>, [<guess>])', 'Internal rate of return, irregular flows.'),
  f('SLN', 'Financial', 'SLN(<cost>, <salvage>, <life>)', 'Straight-line depreciation.'),
  f('DB', 'Financial', 'DB(<cost>, <salvage>, <life>, <period>, …)', 'Fixed-declining balance depreciation.'),

  // ---- Conversion / Parent-Child ----
  f('CONVERT', 'Conversion', 'CONVERT(<expression>, <datatype>)', 'Converts a value to another data type.'),
  f('CURRENCY', 'Conversion', 'CURRENCY(<value>)', 'Converts to the currency data type.'),
  f('PATH', 'Parent-Child', 'PATH(<id_column>, <parent_column>)', 'The hierarchy path from a parent-child relationship.'),
  f('PATHITEM', 'Parent-Child', 'PATHITEM(<path>, <position>, [<type>])', 'An item at a position in a path.'),
  f('PATHLENGTH', 'Parent-Child', 'PATHLENGTH(<path>)', 'Number of levels in a path.'),
  f('PATHCONTAINS', 'Parent-Child', 'PATHCONTAINS(<path>, <item>)', 'TRUE if a path contains an item.'),
]

// De-duplicate (a few functions appear across categories intentionally above).
const seen = new Set<string>()
export const DAX_CATALOG: DaxFunction[] = DAX_FUNCTIONS.filter((fn) => {
  if (seen.has(fn.name)) return false
  seen.add(fn.name)
  return true
})

export const DAX_BY_NAME: Record<string, DaxFunction> = Object.fromEntries(
  DAX_CATALOG.map((fn) => [fn.name, fn]),
)

export const DAX_CATEGORIES: DaxCategory[] = [
  'Aggregation',
  'Filter',
  'Time Intelligence',
  'Relationship',
  'Logical',
  'Information',
  'Math & Trig',
  'Statistical',
  'Text',
  'Date & Time',
  'Table',
  'Window',
  'Financial',
  'Conversion',
  'Parent-Child',
]

/** Fuzzy search the catalog for the editor autocomplete / reference. */
export function searchDax(query: string, limit = 40): DaxFunction[] {
  const q = query.trim().toLowerCase()
  if (!q) return DAX_CATALOG.slice(0, limit)
  const starts: DaxFunction[] = []
  const contains: DaxFunction[] = []
  for (const fn of DAX_CATALOG) {
    const n = fn.name.toLowerCase()
    if (n.startsWith(q)) starts.push(fn)
    else if (n.includes(q) || fn.description.toLowerCase().includes(q)) contains.push(fn)
  }
  return [...starts, ...contains].slice(0, limit)
}
