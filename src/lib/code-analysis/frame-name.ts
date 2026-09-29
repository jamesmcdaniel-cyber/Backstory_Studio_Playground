/** The key a dataset gets in run_code's input["frames"]: the filename without
 *  its extension, lower-cased, non-word runs collapsed — "Raw Data Extract.csv"
 *  becomes "raw_data_extract". repository_list shows it so the agent can
 *  address the frame. Lives apart from tools.ts so the repository tools can
 *  import it without a cycle. */
export function datasetFrameName(filename: string): string {
  return filename.replace(/\.(csv|tsv)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset'
}
