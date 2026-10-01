/* First-party artifact compute worker. No app credentials or arbitrary network access. */
let runtime;
let inlineScope;
self.onmessage = async ({ data }) => {
  let stdout = '', stderr = '';
  const phase = value => { if (data.protocol === 2) self.postMessage({ id: data.id, phase: value }); };
  try {
    if (!runtime) {
      phase('loading-runtime');
      const base = data.origin + '/vendor/pyodide/' + (data.runtimeVersion && /^[\d.]+$/.test(data.runtimeVersion) ? data.runtimeVersion + '/' : '');
      importScripts(base + 'pyodide.js');
      runtime = await loadPyodide({ indexURL: base, stdout: () => {}, stderr: () => {} });
    }
    runtime.setStdout({ batched: line => { if (stdout.length < 65536) stdout += (String(line) + '\n').slice(0, 65536 - stdout.length); } });
    runtime.setStderr({ batched: line => { if (stderr.length < 65536) stderr += (String(line) + '\n').slice(0, 65536 - stderr.length); } });
    // Inline blocks share one document-scoped namespace. Terminating the
    // worker resets it; separate artifact frames never share a worker.
    const scope = data.inlineSession ? (inlineScope ||= runtime.toPy({})) : runtime.toPy(data.globals || {});
    const input = runtime.toPy(data.input === undefined ? null : data.input);
    try {
      scope.set('input', input);
      phase('loading-packages');
      await runtime.loadPackagesFromImports(data.code, { messageCallback: () => {} });
      phase('executing');
      const value = await runtime.runPythonAsync(data.code, { globals: scope });
      try {
        const js = value && typeof value.toJs === 'function' ? value.toJs({ dict_converter: Object.fromEntries }) : value;
        self.postMessage({ id: data.id, result: js === undefined ? null : JSON.parse(JSON.stringify(js)), ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) });
      } finally { if (value && typeof value.destroy === 'function') value.destroy(); }
    } finally { if (!data.inlineSession) scope.destroy(); if (input && typeof input.destroy === 'function') input.destroy(); }
  } catch (error) { self.postMessage({ id: data.id, error: String(error && error.message || error), ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) }); }
};
