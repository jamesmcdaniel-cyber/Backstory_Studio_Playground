import { spawn } from 'node:child_process'

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

// The Node Permission Model flag was renamed from --experimental-permission to
// --permission when it stabilized in v23.5.0. Passing an unknown flag makes
// Node exit before our code runs, so pick the right spelling for the running
// binary instead of assuming one.
function nodePermissionFlag(): string {
  const [major, minor] = process.versions.node.split('.').map((part) => Number(part))
  const stabilized = major > 23 || (major === 23 && minor >= 5)
  return stabilized ? '--permission' : '--experimental-permission'
}

// The child owns the VM and is killed at the deadline. The permission model
// denies filesystem/process/worker/native-addon access. User code only sees
// JSON-cloned input/context plus a console that collects output into a logs
// array returned alongside the value (never into the host's stderr).
const JAVASCRIPT_HOST = String.raw`
const vm = require('node:vm');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(raw);
    const sandbox = Object.create(null);
    // Reconstruct data *inside* the VM realm. Passing host-created objects or
    // functions into a context would expose their host Function constructor.
    const inputJson = JSON.stringify(request.input === undefined ? null : request.input);
    const contextJson = JSON.stringify(request.context || {});
    const source =
      '(async () => {' +
      'const input = JSON.parse(' + JSON.stringify(inputJson) + ');' +
      'const context = JSON.parse(' + JSON.stringify(contextJson) + ');' +
      'const __logs__ = [];' +
      'const __fmt__ = (args) => args.map((a) => typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })()).join(" ");' +
      'const __push__ = (level, args) => { if (__logs__.length < ' + ${MAX_LOG_ENTRIES} + ') __logs__.push((level + ": " + __fmt__(args)).slice(0, 2000)); };' +
      'const console = Object.freeze({ log: (...a) => __push__("log", a), info: (...a) => __push__("info", a), warn: (...a) => __push__("warn", a), error: (...a) => __push__("error", a), debug: (...a) => __push__("debug", a) });' +
      'const value = await (async (input, context, console) => {\n' + request.code + '\n})(input, context, console);' +
      'return { value: value === undefined ? null : value, logs: __logs__ };' +
      '})()';
    const result = await new vm.Script(source, { filename: 'flow-code.js' }).runInNewContext(sandbox, {
      timeout: request.timeoutMs,
      contextCodeGeneration: { strings: false, wasm: false },
    });
    process.stdout.write(JSON.stringify({ ok: true, value: result.value, logs: result.logs }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }));
  }
});
`

// Python is launched isolated (-I), without site packages (-S), with a small
// builtin allowlist. The AST gate blocks imports, filesystem/process primitives,
// and dunder-based object traversal before the function is compiled. print()
// output is collected into a logs list returned with the value.
const PYTHON_HOST = String.raw`
import ast, json, sys

# Cap address space so a runaway allocation can't exhaust the worker. Best
# effort: RLIMIT_AS is unsupported/ignored on some platforms (e.g. macOS), and
# the wall-clock SIGKILL remains the primary bound.
try:
    import resource
    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    cap = 512 * 1024 * 1024
    if soft == resource.RLIM_INFINITY or soft > cap:
        resource.setrlimit(resource.RLIMIT_AS, (cap, hard))
except Exception:
    pass

request = json.loads(sys.stdin.read())
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
            logs.append(sep.join(str(v) for v in values)[:2000])

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
    sys.stdout.write(json.dumps({"ok": True, "value": value, "logs": logs}, separators=(",", ":")))
except BaseException as error:
    sys.stdout.write(json.dumps({"ok": False, "error": str(error), "logs": logs}, separators=(",", ":")))
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

async function runOne(options: Omit<CodeRunOptions, 'mode'>): Promise<CodeRunResult> {
  const timeoutMs = Math.max(1_000, Math.min(30_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const isJavaScript = options.language === 'javascript'
  const command = isJavaScript ? process.execPath : (process.env.FLOW_PYTHON_BIN?.trim() || 'python3')
  const args = isJavaScript
    ? [nodePermissionFlag(), '--max-old-space-size=128', '--disable-proto=throw', '-e', JAVASCRIPT_HOST]
    : ['-I', '-S', '-c', PYTHON_HOST]
  const payload = JSON.stringify({
    code: options.code,
    input: options.input ?? null,
    context: options.context ?? {},
    timeoutMs,
  })
  const childEnv = (isJavaScript
    ? { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' }
    : { PATH: process.env.PATH ?? '', PYTHONHASHSEED: '0' }) as unknown as NodeJS.ProcessEnv

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'] as const,
    })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    const finish = (error?: Error, value?: CodeRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value as CodeRunResult)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`Code step timed out after ${Math.round(timeoutMs / 1000)}s.`))
    }, timeoutMs + 250)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        finish(new Error('Code step output exceeded 1 MB.'))
        return
      }
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 20_000) stderr += chunk.toString()
    })
    child.on('error', (error) => finish(new Error(
      options.language === 'python' && (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Python is not installed on this flow worker.'
        : error.message,
    )))
    child.on('close', (code) => {
      if (settled) return
      if (code !== 0) {
        finish(new Error(stderr.trim() || `Code process exited with status ${code}.`))
        return
      }
      try {
        const response = JSON.parse(stdout) as { ok: boolean; value?: unknown; error?: string; logs?: unknown }
        const logs = Array.isArray(response.logs) ? response.logs.map((entry) => String(entry)) : []
        if (!response.ok) finish(new Error(response.error || 'Code step failed.'))
        else finish(undefined, { output: response.value ?? null, logs })
      } catch {
        finish(new Error('Code step returned an invalid result.'))
      }
    })
    child.stdin.end(payload)
  })
}

export async function runFlowCode(options: CodeRunOptions): Promise<CodeRunResult> {
  if (!options.code.trim()) throw new Error('Code step is empty.')
  if (options.mode === 'all') return runOne(options)
  const items = itemsOf(options.input)
  if (items.length > MAX_ITEMS) throw new Error(`Code step can process at most ${MAX_ITEMS} items at once.`)
  const output: unknown[] = []
  const logs: string[] = []
  // Deliberately sequential: predictable ordering and one bounded child at a
  // time keeps a large input list from exhausting the worker.
  for (let index = 0; index < items.length; index += 1) {
    const result = await runOne({
      ...options,
      input: items[index],
      context: { ...(options.context ?? {}), index },
    })
    output.push(result.output)
    for (const entry of result.logs) {
      if (logs.length < MAX_LOG_ENTRIES) logs.push(`[item ${index}] ${entry}`)
    }
  }
  return { output, logs }
}
