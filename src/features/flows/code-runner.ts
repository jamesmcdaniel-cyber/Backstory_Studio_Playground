import { Worker } from 'node:worker_threads'
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten'
import { loadPyodide, type PyodideAPI } from 'pyodide'

export type CodeLanguage = 'javascript' | 'python'
export type CodeMode = 'all' | 'each'

/** A tabular file mounted into the Python sandbox's virtual filesystem and
 *  handed to the code as a pandas DataFrame under `input["frames"][name]`. */
export type CodeDataset = { name: string; filename: string; bytes: Buffer }

type CodeRunOptions = {
  language: CodeLanguage
  mode: CodeMode
  code: string
  input: unknown
  context?: Record<string, unknown>
  timeoutMs?: number
  /** Adds the data-analysis helpers (statistics, Counter/defaultdict, number
   *  and date coercion) to Python's builtins. Agents' `run_code` sets it;
   *  plain flow code steps keep the minimal builtin set. */
  analysis?: boolean
  /** Dataset mode (Python only): mounts these files and loads pandas/numpy.
   *  Bytes never cross into the model — only what the code returns does. */
  datasets?: CodeDataset[]
}

/** The value the user code returned, plus any console.log / print output it
 *  emitted. Logs are captured for display only — they never affect the data
 *  that flows to downstream nodes. */
export type CodeRunResult = {
  output: unknown
  logs: string[]
}

const MAX_OUTPUT_BYTES = 1_000_000
const MAX_ITEMS = 1_000
const DEFAULT_TIMEOUT_MS = 5_000
const TIMEOUT_MAX_MS = 30_000
// Dataset runs are pandas over tens of megabytes: a 30 s ceiling would turn a
// legitimate 24-month cohort analysis into a timeout, and the chart series a
// dashboard needs do not fit in 1 MB. Both ceilings still exist — they are
// just sized for the work.
export const DATASET_TIMEOUT_MAX_MS = 300_000
const DATASET_MAX_OUTPUT_BYTES = 5_000_000
const DATASET_MOUNT = '/datasets'
const MAX_LOG_ENTRIES = 200
let pyodidePromise: Promise<PyodideAPI> | undefined
let pythonQueue: Promise<void> = Promise.resolve()
// Word 0 is Pyodide's signal slot; word 1 is our durable deadline marker
// (Pyodide clears the signal word after consuming it).
const pythonInterruptBuffer = new Int32Array(new SharedArrayBuffer(8))

function getPyodide(): Promise<PyodideAPI> {
  pyodidePromise ??= loadPyodide({
    stdout: () => undefined,
    stderr: () => undefined,
    // User code cannot import `js`, but an empty JS global is defense in depth.
    jsglobals: Object.create(null),
  }).then((pyodide) => {
    pyodide.setInterruptBuffer(pythonInterruptBuffer)
    return pyodide
  })
  return pyodidePromise
}

let pandasPromise: Promise<void> | undefined
/** pandas + numpy are pyodide packages, not part of the npm bundle: the first
 *  load fetches the wheels into pyodide's package cache (pre-warmed in the
 *  worker image by scripts/warm-pyodide.mjs), later loads come from disk. */
function loadPandas(pyodide: PyodideAPI): Promise<void> {
  pandasPromise ??= pyodide.loadPackage(['pandas', 'numpy'], { messageCallback: () => undefined }).then(() => undefined)
  return pandasPromise
}

// The AST gate blocks imports, filesystem/process primitives, and dunder-based
// object traversal before the function is compiled. Only a small builtin
// allowlist is exposed. The host request crosses the WASM boundary as JSON.
const PYTHON_HOST = String.raw`
import ast, json, statistics, collections, datetime, re

request = json.loads(_flow_request_json)
source = "def __flow_user__(input, context):\n" + "".join("    " + line + "\n" for line in request["code"].splitlines())
logs = []
try:
    tree = ast.parse(source, filename="flow-code.py", mode="exec")
    forbidden_nodes = (ast.Import, ast.ImportFrom, ast.Global, ast.Nonlocal, ast.ClassDef)
    forbidden_names = {"open", "eval", "exec", "compile", "__import__", "globals", "locals", "vars", "dir", "getattr", "setattr", "delattr", "breakpoint", "help", "input"}
    for node in ast.walk(tree):
        if isinstance(node, forbidden_nodes):
            raise ValueError("Imports, classes, and global/nonlocal statements are not available in flow code.")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise ValueError("Private and dunder attributes are not available in flow code.")
        if isinstance(node, ast.Name) and (node.id.startswith("__") or node.id in forbidden_names):
            if node.id not in {"input", "__flow_user__"}:
                raise ValueError("That Python capability is not available in flow code.")

    def flow_print(*values, **kwargs):
        if len(logs) < ${MAX_LOG_ENTRIES}:
            sep = kwargs.get("sep", " ")
            entry = sep.join(str(v) for v in values)
            if len(entry) > 2000:
                logs.append(entry[:2000] + "\n… [truncated " + str(len(entry) - 2000) + " chars]")
            else:
                logs.append(entry)
        elif len(logs) == ${MAX_LOG_ENTRIES}:
            logs.append("… [log truncated at ${MAX_LOG_ENTRIES} entries]")

    safe_builtins = {
        "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
        "enumerate": enumerate, "filter": filter, "float": float, "int": int,
        "len": len, "list": list, "map": map, "max": max, "min": min,
        "next": next, "print": flow_print, "range": range, "reversed": reversed,
        "round": round, "set": set, "sorted": sorted, "str": str, "sum": sum,
        "tuple": tuple, "zip": zip, "Exception": Exception, "ValueError": ValueError,
    }
    if request.get("analysis"):
        def to_number(value, default=None):
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return value
            text = re.sub(r"[\s$€£,%]", "", str(value or ""))
            if text.startswith("(") and text.endswith(")"):
                text = "-" + text[1:-1]
            try:
                return float(text)
            except ValueError:
                return default

        date_formats = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d", "%d-%b-%Y", "%b %d, %Y", "%B %d, %Y", "%Y-%m")
        def parse_date(value):
            text = str(value or "").strip()
            try:
                return datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                pass
            for fmt in date_formats:
                try:
                    return datetime.datetime.strptime(text, fmt)
                except ValueError:
                    pass
            return None

        def month_key(value):
            parsed = parse_date(value)
            return parsed.strftime("%Y-%m") if parsed else None

        safe_builtins.update({
            "mean": statistics.fmean, "median": statistics.median, "stdev": statistics.stdev,
            "Counter": collections.Counter, "defaultdict": collections.defaultdict,
            "isinstance": isinstance, "to_number": to_number, "parse_date": parse_date, "month_key": month_key,
            "KeyError": KeyError, "TypeError": TypeError, "ZeroDivisionError": ZeroDivisionError,
        })
    user_input = request.get("input")
    datasets = request.get("datasets") or []
    if datasets:
        import pandas as pd
        import numpy as np
        import math

        def clean(value):
            # pandas hands back numpy scalars, NaN and Timestamps — none of
            # which JSON.parse on the host will accept. Normalise once here so
            # the code can return frames and series as they are.
            if isinstance(value, dict):
                return {str(k): clean(v) for k, v in value.items()}
            if isinstance(value, (list, tuple, set)):
                return [clean(v) for v in value]
            if isinstance(value, pd.DataFrame):
                return clean(value.to_dict(orient="records"))
            if isinstance(value, pd.Series):
                return clean(value.to_dict())
            if isinstance(value, pd.Index):
                return clean(list(value))
            if isinstance(value, np.generic):
                return clean(value.item())
            if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
                return None
            if value is pd.NaT:
                return None
            if isinstance(value, (pd.Timestamp, datetime.datetime, datetime.date)):
                return value.isoformat()
            if isinstance(value, (pd.Period, pd.Interval, pd.Timedelta, datetime.timedelta)):
                return str(value)
            return value

        def records(frame):
            return clean(frame)

        frames = {}
        for dataset in datasets:
            sep = "\t" if dataset["filename"].lower().endswith(".tsv") else ","
            frames[dataset["name"]] = pd.read_csv(dataset["path"], sep=sep, low_memory=False)
        if isinstance(user_input, dict):
            user_input = dict(user_input, frames=frames)
        else:
            user_input = {"frames": frames, "data": user_input}
        safe_builtins.update({"pd": pd, "np": np, "records": records, "clean": clean})
    scope = {"__builtins__": safe_builtins}
    exec(compile(tree, "flow-code.py", "exec"), scope, scope)
    value = scope["__flow_user__"](user_input, request.get("context") or {})
    if datasets:
        value = clean(value)
    # Analysis output may hold dates; render them as strings rather than failing.
    _flow_result_json = json.dumps({"ok": True, "value": value, "logs": logs}, separators=(",", ":"), default=str if request.get("analysis") else None)
except BaseException as error:
    _flow_result_json = json.dumps({"ok": False, "error": str(error), "logs": logs}, separators=(",", ":"))
finally:
    # Frames are tens of MB; nothing from this run may survive into the next.
    for _name in ("frames", "datasets", "user_input", "scope", "value", "request", "tree"):
        globals().pop(_name, None)

_flow_result_json
`

function itemsOf(input: unknown): unknown[] {
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object') {
    for (const key of ['items', 'records', 'results', 'data']) {
      const value = (input as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value
    }
  }
  return [input]
}

function parseResponse(raw: string, maxOutputBytes = MAX_OUTPUT_BYTES): CodeRunResult {
  if (Buffer.byteLength(raw) > maxOutputBytes) throw new Error(`Code step output exceeded ${Math.round(maxOutputBytes / 1_000_000)} MB.`)
  const response = JSON.parse(raw) as { ok: boolean; value?: unknown; error?: string; logs?: unknown }
  const logs = Array.isArray(response.logs) ? response.logs.map((entry) => String(entry)) : []
  if (!response.ok) throw new Error(response.error || 'Code step failed.')
  return { output: response.value ?? null, logs }
}

async function runJavaScript(options: Omit<CodeRunOptions, 'mode'>, timeoutMs: number): Promise<CodeRunResult> {
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(128 * 1024 * 1024)
  runtime.setMaxStackSize(2 * 1024 * 1024)
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs))
  const vm = runtime.newContext()
  try {
    const inputJson = JSON.stringify(options.input ?? null)
    const contextJson = JSON.stringify(options.context ?? {})
    const source = String.raw`
      (async () => {
        const input = JSON.parse(${JSON.stringify(inputJson)});
        const context = JSON.parse(${JSON.stringify(contextJson)});
        const __logs__ = [];
        const __fmt__ = (args) => args.map((a) => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })()).join(' ');
        const __push__ = (level, args) => {
          if (__logs__.length < ${MAX_LOG_ENTRIES}) {
            const __entry__ = level + ': ' + __fmt__(args);
            __logs__.push(__entry__.length > 2000 ? __entry__.slice(0, 2000) + '\n… [truncated ' + (__entry__.length - 2000) + ' chars]' : __entry__);
          } else if (__logs__.length === ${MAX_LOG_ENTRIES}) {
            __logs__.push('… [log truncated at ${MAX_LOG_ENTRIES} entries]');
          }
        };
        const console = Object.freeze({ log: (...a) => __push__('log', a), info: (...a) => __push__('info', a), warn: (...a) => __push__('warn', a), error: (...a) => __push__('error', a), debug: (...a) => __push__('debug', a) });
        try {
          const value = await (async (input, context, console) => {
${options.code}
          })(input, context, console);
          return JSON.stringify({ ok: true, value: value === undefined ? null : value, logs: __logs__ });
        } catch (error) {
          return JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error), logs: __logs__ });
        }
      })()
    `
    const evaluated = vm.evalCode(source, 'flow-code.js')
    if (evaluated.error) {
      const error = vm.dump(evaluated.error)
      evaluated.error.dispose()
      throw new Error(error instanceof Error ? error.message : String(error?.message ?? error))
    }
    const promiseHandle = evaluated.value
    const settled = vm.resolvePromise(promiseHandle)
    runtime.executePendingJobs()
    const resolved = await settled
    promiseHandle.dispose()
    if (resolved.error) {
      const error = vm.dump(resolved.error)
      resolved.error.dispose()
      throw new Error(error instanceof Error ? error.message : String(error?.message ?? error))
    }
    const raw = vm.getString(resolved.value)
    resolved.value.dispose()
    return parseResponse(raw)
  } catch (error) {
    if (String(error).includes('interrupted')) {
      throw new Error(`Code step timed out after ${Math.round(timeoutMs / 1000)}s.`)
    }
    throw error
  } finally {
    vm.dispose()
    runtime.dispose()
  }
}

async function runPython(options: Omit<CodeRunOptions, 'mode'>, timeoutMs: number): Promise<CodeRunResult> {
  let result: CodeRunResult | undefined
  let failure: unknown
  // A Pyodide interpreter is stateful and not re-entrant. Serialize calls and
  // remove the one temporary global after every execution.
  const execution = pythonQueue.catch(() => undefined).then(async () => {
    const pyodide = await getPyodide()
    const datasets = options.datasets ?? []
    const mounted: string[] = []
    if (datasets.length) {
      await loadPandas(pyodide)
      if (!pyodide.FS.analyzePath(DATASET_MOUNT).exists) pyodide.FS.mkdir(DATASET_MOUNT)
      datasets.forEach((dataset, index) => {
        const path = `${DATASET_MOUNT}/${index}-${dataset.name.replace(/[^\w.-]+/g, '_')}`
        pyodide.FS.writeFile(path, dataset.bytes)
        mounted.push(path)
      })
    }
    Atomics.store(pythonInterruptBuffer, 0, 0)
    Atomics.store(pythonInterruptBuffer, 1, 0)
    // A separate Node thread can flip Pyodide's signal word even while Python
    // is occupying this thread. Repeating the signal also defeats user code
    // that attempts to catch KeyboardInterrupt and continue forever.
    const timer = new Worker(String.raw`
      const { workerData } = require('node:worker_threads')
      const interrupt = new Int32Array(workerData.buffer)
      setTimeout(() => {
        Atomics.store(interrupt, 1, 1)
        Atomics.store(interrupt, 0, 2)
        setInterval(() => Atomics.store(interrupt, 0, 2), 10)
      }, workerData.timeoutMs)
    `, {
      eval: true,
      workerData: { buffer: pythonInterruptBuffer.buffer, timeoutMs },
    })
    pyodide.globals.set('_flow_request_json', JSON.stringify({
      code: options.code,
      input: options.input ?? null,
      context: options.context ?? {},
      analysis: options.analysis === true,
      datasets: datasets.map((dataset, index) => ({ name: dataset.name, filename: dataset.filename, path: mounted[index] })),
    }))
    try {
      result = parseResponse(String(pyodide.runPython(PYTHON_HOST)), datasets.length ? DATASET_MAX_OUTPUT_BYTES : MAX_OUTPUT_BYTES)
      if (Atomics.load(pythonInterruptBuffer, 1) === 1) {
        throw new Error(`Code step timed out after ${Math.round(timeoutMs / 1000)}s.`)
      }
    } catch (error) {
      failure = Atomics.load(pythonInterruptBuffer, 1) === 1
        ? new Error(`Code step timed out after ${Math.round(timeoutMs / 1000)}s.`)
        : error
    } finally {
      void timer.terminate()
      pyodide.globals.delete('_flow_request_json')
      for (const path of mounted) {
        try { pyodide.FS.unlink(path) } catch { /* already gone */ }
      }
      Atomics.store(pythonInterruptBuffer, 0, 0)
      Atomics.store(pythonInterruptBuffer, 1, 0)
    }
  })
  pythonQueue = execution
  await execution
  if (failure) throw failure
  return result as CodeRunResult
}

async function runOne(options: Omit<CodeRunOptions, 'mode'>): Promise<CodeRunResult> {
  const ceiling = options.datasets?.length ? DATASET_TIMEOUT_MAX_MS : TIMEOUT_MAX_MS
  const timeoutMs = Math.max(1_000, Math.min(ceiling, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  if (options.datasets?.length && options.language !== 'python') throw new Error('Datasets are available to Python code only.')
  return options.language === 'javascript'
    ? runJavaScript(options, timeoutMs)
    : runPython(options, timeoutMs)
}

export async function runFlowCode(options: CodeRunOptions): Promise<CodeRunResult> {
  if (!options.code.trim()) throw new Error('Code step is empty.')
  if (options.mode === 'all') return runOne(options)
  const items = itemsOf(options.input)
  if (items.length > MAX_ITEMS) throw new Error(`Code step can process at most ${MAX_ITEMS} items at once.`)
  const output: unknown[] = []
  const logs: string[] = []
  for (let index = 0; index < items.length; index += 1) {
    const result = await runOne({
      ...options,
      input: items[index],
      context: { ...(options.context ?? {}), index },
    })
    output.push(result.output)
    for (const entry of result.logs) {
      if (logs.length < MAX_LOG_ENTRIES) {
        logs.push(`[item ${index}] ${entry}`)
      } else if (logs.length === MAX_LOG_ENTRIES) {
        logs.push(`… [log truncated at ${MAX_LOG_ENTRIES} entries]`)
      }
    }
  }
  return { output, logs }
}
