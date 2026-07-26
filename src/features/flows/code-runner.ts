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

const MAX_OUTPUT_BYTES = 1_000_000
const MAX_ITEMS = 1_000
const DEFAULT_TIMEOUT_MS = 5_000

// The child owns the VM and is killed at the deadline. The permission model
// denies filesystem/process/worker/native-addon access. User code only sees
// JSON-cloned input/context plus a console whose output goes to stderr.
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
      'const console = Object.freeze({log(){},info(){},warn(){},error(){}});' +
      'return (async (input, context, console) => {\n' + request.code + '\n})(input, context, console);' +
      '})()';
    const value = await new vm.Script(source, { filename: 'flow-code.js' }).runInNewContext(sandbox, {
      timeout: request.timeoutMs,
      contextCodeGeneration: { strings: false, wasm: false },
    });
    process.stdout.write(JSON.stringify({ ok: true, value: value === undefined ? null : value }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }));
  }
});
`

// Python is launched isolated (-I), without site packages (-S), with a small
// builtin allowlist. The AST gate blocks imports, filesystem/process primitives,
// and dunder-based object traversal before the function is compiled.
const PYTHON_HOST = String.raw`
import ast, json, sys

request = json.loads(sys.stdin.read())
source = "def __flow_user__(input, context):\n" + "".join("    " + line + "\n" for line in request["code"].splitlines())
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
        print(*values, file=sys.stderr)

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
    sys.stdout.write(json.dumps({"ok": True, "value": value}, separators=(",", ":")))
except BaseException as error:
    sys.stdout.write(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")))
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

async function runOne(options: Omit<CodeRunOptions, 'mode'>): Promise<unknown> {
  const timeoutMs = Math.max(1_000, Math.min(30_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const isJavaScript = options.language === 'javascript'
  const command = isJavaScript ? process.execPath : (process.env.FLOW_PYTHON_BIN?.trim() || 'python3')
  const args = isJavaScript
    ? ['--experimental-permission', '--max-old-space-size=128', '--disable-proto=throw', '-e', JAVASCRIPT_HOST]
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
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
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
        const response = JSON.parse(stdout) as { ok: boolean; value?: unknown; error?: string }
        if (!response.ok) finish(new Error(response.error || 'Code step failed.'))
        else finish(undefined, response.value)
      } catch {
        finish(new Error('Code step returned an invalid result.'))
      }
    })
    child.stdin.end(payload)
  })
}

export async function runFlowCode(options: CodeRunOptions): Promise<unknown> {
  if (!options.code.trim()) throw new Error('Code step is empty.')
  if (options.mode === 'all') return runOne(options)
  const items = itemsOf(options.input)
  if (items.length > MAX_ITEMS) throw new Error(`Code step can process at most ${MAX_ITEMS} items at once.`)
  const output: unknown[] = []
  // Deliberately sequential: predictable ordering and one bounded child at a
  // time keeps a large input list from exhausting the worker.
  for (let index = 0; index < items.length; index += 1) {
    output.push(await runOne({
      ...options,
      input: items[index],
      context: { ...(options.context ?? {}), index },
    }))
  }
  return output
}
