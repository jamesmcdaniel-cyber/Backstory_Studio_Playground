import { Worker } from 'node:worker_threads'
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten'
import { loadPyodide, type PyodideAPI } from 'pyodide'

export type CodeLanguage = 'javascript' | 'python'
export type CodeMode = 'all' | 'each'

type CodeRunOptions = {
  language: CodeLanguage
  mode: CodeMode
  code: string
  input: unknown
  context?: Record<string, unknown>
  timeoutMs?: number
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

// The AST gate blocks imports, filesystem/process primitives, and dunder-based
// object traversal before the function is compiled. Only a small builtin
// allowlist is exposed. The host request crosses the WASM boundary as JSON.
const PYTHON_HOST = String.raw`
import ast, json

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
    scope = {"__builtins__": safe_builtins}
    exec(compile(tree, "flow-code.py", "exec"), scope, scope)
    value = scope["__flow_user__"](request.get("input"), request.get("context") or {})
    _flow_result_json = json.dumps({"ok": True, "value": value, "logs": logs}, separators=(",", ":"))
except BaseException as error:
    _flow_result_json = json.dumps({"ok": False, "error": str(error), "logs": logs}, separators=(",", ":"))

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

function parseResponse(raw: string): CodeRunResult {
  if (Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) throw new Error('Code step output exceeded 1 MB.')
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
    }))
    try {
      result = parseResponse(String(pyodide.runPython(PYTHON_HOST)))
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
  const timeoutMs = Math.max(1_000, Math.min(30_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
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
