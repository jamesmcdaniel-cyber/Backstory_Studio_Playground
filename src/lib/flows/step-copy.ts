import type { DataOp, VariableOp } from '@/lib/flows/graph'

/**
 * Shared plain-English editor copy for the variable / data-operation step
 * editors — the drawer and the expanded canvas card render the same fields and
 * must teach them with the same words.
 */

/** Placeholder for a data operation's input field — teaches the expected shape. */
export const DATA_OP_INPUT_PLACEHOLDER: Record<DataOp, string> = {
  compose: 'The value to pass along',
  parseJson: 'The JSON text to parse',
  join: 'The list to join',
  csvTable: 'The list of records to turn into a table',
  htmlTable: 'The list of records to turn into a table',
  filterArray: 'The list to filter',
  select: 'The list to map',
  split: 'The text to split into a list',
  replace: 'The text to search through',
  getItem: 'The list to take an item from',
  flatten: 'The nested list to flatten',
  trim: 'The list to trim items from',
  parseCsv: 'The CSV text to parse',
  sort: 'The list to sort',
  limit: 'The list to take items from',
  removeDuplicates: 'The list to de-duplicate',
  aggregate: 'The list to collapse into one value',
  summarize: 'The list of records to summarize',
  formatDate: 'The date to format',
  dateShift: 'The date to shift',
  dateDiff: 'The start date',
  datePart: 'The date to read from',
  renameKeys: 'The record (or list of records) to rename fields on',
  markdownToHtml: 'The Markdown text to convert',
  htmlToMarkdown: 'The HTML to convert',
  xmlParse: 'The XML text to parse',
  xmlBuild: 'The record to turn into XML',
  columnarToRecords: 'The columns-and-rows response to convert',
  compareDatasets: 'The first list to compare',
  hash: 'The value to hash',
  hmac: 'The value to authenticate',
  jwtSign: 'The object of claims to sign',
  jwtVerify: 'The JWT to verify',
  totpGenerate: 'No input required',
  totpVerify: 'The one-time code to verify',
}

/** One-line helper under each data operation's fields. */
export const DATA_OP_HELPER: Record<DataOp, string> = {
  compose: 'Holds values for later steps to reuse under this step’s name. Add fields to build an object, or leave them empty to pass the input straight through.',
  parseJson: 'Turns JSON text into structured data so later steps can map its fields.',
  join: 'Combines the list into one text value, with the separator between items.',
  csvTable: 'Builds a CSV table from the list — columns come from the record fields.',
  htmlTable: 'Builds an HTML table from the list — columns come from the record fields.',
  filterArray: 'Keeps only the items where every condition passes. Conditions check each item.',
  select: 'Maps every item to a new shape — values can reference fields of the current item.',
  split: 'Splits the text at every separator into a list of trimmed pieces.',
  replace: 'Replaces every occurrence of the search text with the replacement.',
  getItem: 'Takes one item from the list by position — negatives count from the end.',
  flatten: 'Unnests lists inside lists into one flat list.',
  trim: 'Removes a number of items from the start (or end) of the list.',
  parseCsv: 'Turns CSV text into a list of records — the first row names the fields.',
  sort: 'Orders the list by a field — numbers numerically, everything else alphabetically. Equal values keep their original order.',
  limit: 'Keeps the first (or last) few items and drops the rest.',
  removeDuplicates: 'Drops repeated items, keeping the first of each. Match on one field, or on the whole record.',
  aggregate: 'Collapses the list into a single value — one field’s values, or the whole list as one item.',
  summarize: 'Groups the records by a field and calculates totals, averages, counts, or extremes for each group.',
  formatDate: 'Writes the date in the pattern you choose (YYYY, MM, DD, HH, mm, ss tokens). All dates are read and written in UTC.',
  dateShift: 'Adds the amount of time to the date — a negative amount subtracts. All math happens in UTC.',
  dateDiff: 'Counts the time between the input date and the end date, in the unit you choose.',
  datePart: 'Picks one part of the date — year, month, day, hour, minute, second, weekday, date, or time.',
  renameKeys: 'Renames fields on the record — or on every record in a list — leaving other fields untouched.',
  markdownToHtml: 'Converts Markdown text into HTML.',
  htmlToMarkdown: 'Converts HTML into Markdown text.',
  xmlParse: 'Turns XML text into structured data so later steps can map its fields.',
  xmlBuild: 'Builds an XML document from a record — field names become the tags.',
  columnarToRecords: 'Turns a columns-and-rows API response (like a Snowflake SQL result) into a list of records so later steps can map its fields.',
  compareDatasets: 'Matches both lists by the field(s) you choose and returns same, changed, first-only, and second-only groups.',
  hash: 'Produces a hexadecimal SHA-2 digest without storing the input outside normal run-retention policy.',
  hmac: 'Produces a hexadecimal keyed digest. Reference the secret at run time; literal secrets are blocked by the graph scanner.',
  jwtSign: 'Signs JSON claims with HS256/384/512 and the run’s frozen clock for deterministic issued/expiry timestamps.',
  jwtVerify: 'Checks the signature, expiry, not-before, and optional issuer/audience before returning claims.',
  totpGenerate: 'Generates a standards-based one-time code from a base32 secret and the run’s frozen clock.',
  totpVerify: 'Checks the supplied one-time code with a one-period clock-skew window.',
}

/** Placeholder for a variable step's value field, per operation. */
export const VARIABLE_VALUE_PLACEHOLDER: Record<VariableOp, string> = {
  initialize: 'Starting value (optional)',
  set: 'The new value',
  increment: 'Defaults to 1',
  decrement: 'Defaults to 1',
  appendArray: 'The item to add',
  appendString: 'The text to add',
}

/** Whether a variable operation's value field is optional. */
export function variableValueOptional(op: VariableOp): boolean {
  return op === 'initialize' || op === 'increment' || op === 'decrement'
}

/** Plain-English names for the summarize calculations — the UI shows these, never the op key. */
export const SUMMARIZE_OP_LABELS: Record<'sum' | 'avg' | 'count' | 'min' | 'max' | 'countUnique' | 'concat' | 'append', string> = {
  sum: 'Total',
  avg: 'Average',
  count: 'Count',
  min: 'Lowest',
  max: 'Highest',
  countUnique: 'Unique count',
  concat: 'Join as text',
  append: 'Collect as list',
}

/** Every summarize calculation, in display order. */
export const SUMMARIZE_OPS = ['sum', 'avg', 'count', 'countUnique', 'min', 'max', 'concat', 'append'] as const
