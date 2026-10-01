/* First-party artifact compute worker. No app credentials or arbitrary network access. */
let runtime;
self.onmessage = async ({ data }) => {
  try {
    if (!runtime) {
      importScripts(data.origin + '/vendor/pyodide/pyodide.js');
      runtime = await loadPyodide({ indexURL: data.origin + '/vendor/pyodide/', stdout: () => {}, stderr: () => {} });
    }
    const scope = runtime.toPy(data.globals || {});
    const input = runtime.toPy(data.input === undefined ? null : data.input);
    try {
      scope.set('input', input);
      await runtime.loadPackagesFromImports(data.code, { messageCallback: () => {} });
      const value = await runtime.runPythonAsync(data.code, { globals: scope });
      try {
        const js = value && typeof value.toJs === 'function' ? value.toJs({ dict_converter: Object.fromEntries }) : value;
        self.postMessage({ id: data.id, result: js === undefined ? null : JSON.parse(JSON.stringify(js)) });
      } finally { if (value && typeof value.destroy === 'function') value.destroy(); }
    } finally { scope.destroy(); if (input && typeof input.destroy === 'function') input.destroy(); }
  } catch (error) { self.postMessage({ id: data.id, error: String(error && error.message || error) }); }
};
