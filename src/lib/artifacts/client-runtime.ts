/** Runs only in the opaque-origin artifact frame, never in the app window. */
export const ARTIFACT_CLIENT_RUNTIME = String.raw`
(function(){
  window.__artifactError=window.__artifactError||function(e){var node=document.createElement('div');node.setAttribute('role','alert');node.style.cssText='position:fixed;bottom:8px;left:8px;right:8px;background:#fff1f2;color:#9f1239;padding:12px;z-index:2147483647';node.textContent=String(e.message||e);(document.body||document.documentElement).appendChild(node);};
  var pending = new Map(), seq = 0;
  window.addEventListener('message', function(e){
    if(e.source !== window.parent || !e.data || e.data.type !== 'backstory:state-result') return;
    var p = pending.get(e.data.id); if(!p) return;
    pending.delete(e.data.id); clearTimeout(p.timer);
    if(e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
  });
  function request(op, payload){
    return new Promise(function(resolve,reject){
      if(window.parent === window) return reject(new Error('Open this artifact inside Backstory to use private saved state.'));
      var id = String(++seq);
      var timer = setTimeout(function(){pending.delete(id);reject(new Error('State service did not respond. Changes are not saved.'));},15000);
      pending.set(id,{resolve:resolve,reject:reject,timer:timer});
      window.parent.postMessage({type:'backstory:state',id:id,op:op,payload:payload},'*');
    });
  }
  var slots = new Map();
  window.addEventListener('beforeunload',function(e){if(Array.from(slots.values()).some(function(s){return s.saving;})){e.preventDefault();e.returnValue='';}});
  function slot(key, initial){
    if(slots.has(key)) return slots.get(key);
    var s={value:typeof initial==='function'?initial():initial,revision:0,ready:false,error:null,saving:false,writes:0,listeners:new Set(),chain:Promise.resolve()};
    slots.set(key,s);
    s.emit=function(){s.listeners.forEach(function(fn){fn();});};
    s.load=request('get',{key:key}).then(function(r){if(r.revision) s.value=r.value;s.revision=r.revision;s.ready=true;s.emit();}).catch(function(e){s.error=e.message;s.emit();});
    return s;
  }
  function useArtifactState(key, initial){
    var R=window.React,s=slot(key,initial), force=R.useState(0)[1];
    R.useEffect(function(){var f=function(){force(function(v){return v+1;});};s.listeners.add(f);f();return function(){s.listeners.delete(f);};},[key]);
    function set(value){
      if(!s.ready || s.error){window.__artifactError(new Error(s.error || 'Saved state is loading; please wait.'));return;}
      var next=typeof value==='function'?value(s.value):value;
      // Snapshot before queueing: callers cannot mutate a pending payload.
      try{next=JSON.parse(JSON.stringify(next));}catch(e){window.__artifactError(e);return;}
      s.value=next;s.writes++;s.saving=true;s.emit();
      s.chain=s.chain.then(function(){if(s.error)return;return request('set',{key:key,value:next,revision:s.revision}).then(function(r){s.revision=r.revision;});}).catch(function(e){s.error=e.message;window.__artifactError(e);}).finally(function(){s.writes--;s.saving=s.writes>0;s.emit();});
    }
    return [s.value,set,{ready:s.ready,saving:s.saving,error:s.error}];
  }
  var worker=null, active=null, jobs=[], globals={}, pythonSeq=0;
  function pump(){
    if(active || !jobs.length)return;
    active=jobs.shift();
    try {
    if(!worker){
      var source="importScripts("+JSON.stringify(__ARTIFACT_ORIGIN__+'/vendor/artifact-python-worker.js')+");";
      var url=URL.createObjectURL(new Blob([source],{type:'application/javascript'}));
      worker=new Worker(url);URL.revokeObjectURL(url);
      worker.onmessage=function(e){if(!active || e.data.id!==active.id)return;var job=active;clearTimeout(job.timer);active=null;e.data.error?job.reject(new Error(e.data.error)):job.resolve(e.data.result);pump();};
      worker.onerror=function(e){var job=active;if(worker)worker.terminate();worker=null;active=null;if(job){clearTimeout(job.timer);job.reject(new Error(e.message||'Python worker failed'));}pump();};
    }
    active.timer=setTimeout(function(){var job=active;worker.terminate();worker=null;active=null;job.reject(new Error('Python exceeded its execution deadline; the worker was stopped.'));pump();},active.timeout);
    worker.postMessage({id:active.id,code:active.code,input:active.input,globals:active.globals,origin:__ARTIFACT_ORIGIN__});
    } catch(e) {var failed=active;if(worker)worker.terminate();worker=null;active=null;if(failed){clearTimeout(failed.timer);failed.reject(e);}pump();}
  }
  function runPython(code,input,options){
    return new Promise(function(resolve,reject){
      if(typeof code!=='string'||code.length>100000)return reject(new Error('Python code must be at most 100,000 characters.'));
      if(jobs.length>=4)return reject(new Error('Too many queued Python calculations.'));
      jobs.push({id:++pythonSeq,code:code,input:input,globals:JSON.parse(JSON.stringify(globals)),timeout:Math.max(1000,Math.min(60000,options&&options.timeoutMs||30000)),resolve:resolve,reject:reject});pump();
    });
  }
  function cancelPython(){if(worker)worker.terminate();worker=null;if(active){clearTimeout(active.timer);active.reject(new Error('Python cancelled.'));active=null;}jobs.splice(0).forEach(function(j){j.reject(new Error('Python cancelled.'));});}
  // Compatibility facade for generated components that previously checked
  // window.pyodide. Execution initializes lazily, in an isolated worker.
  window.pyodide={runPythonAsync:function(code){return runPython(code,null);},globals:{set:function(k,v){globals[k]=v;},delete:function(k){delete globals[k];}},loadPackagesFromImports:function(){return Promise.resolve();}};
  window.BackstoryArtifact={useArtifactState:useArtifactState,loadState:function(key){return request('get',{key:key});},saveState:function(key,value,revision){return request('set',{key:key,value:value,revision:revision});},runPython:runPython,cancelPython:cancelPython};
})();
`

export function artifactClientRuntime(origin: string): string {
  return ARTIFACT_CLIENT_RUNTIME.replaceAll('__ARTIFACT_ORIGIN__', JSON.stringify(origin).replace(/</g, '\\u003c'))
}
