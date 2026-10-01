import { version as pythonVersion } from 'pyodide/package.json'
/** Runs only in the opaque-origin artifact frame, never in the app window. */
export const ARTIFACT_CLIENT_RUNTIME = String.raw`
(function(){
  window.__artifactError=window.__artifactError||function(e){var node=document.createElement('div');node.setAttribute('role','alert');node.setAttribute('data-backstory-runtime-error','');node.style.cssText='position:fixed;bottom:8px;left:8px;right:8px;background:#fff1f2;color:#9f1239;padding:12px;z-index:2147483647';node.textContent=String(e.message||e);(document.body||document.documentElement).appendChild(node);};
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
  var manualDirty=false;
  function signalDirty(){window.parent.postMessage({type:'backstory:dirty',dirty:manualDirty||Array.from(slots.values()).some(function(s){return s.saving||s.dirty;})},'*');}
  document.addEventListener('input',function(){manualDirty=true;signalDirty();});
  window.addEventListener('beforeunload',function(e){if(manualDirty||Array.from(slots.values()).some(function(s){return s.saving||s.dirty;})){e.preventDefault();e.returnValue='';}});
  function recovery(s,key){
    if(s.notice)s.notice.remove();
    var node=document.createElement('div');node.setAttribute('role','alert');node.style.cssText='position:fixed;bottom:8px;left:8px;right:8px;background:#fff1f2;color:#9f1239;padding:12px;z-index:2147483647';
    node.textContent='Saved state: '+s.error+' Your draft is retained. ';
    [['Retry',false],['Discard draft and reload saved data',true]].forEach(function(item){var button=document.createElement('button');button.textContent=item[0];button.style.margin='0 8px';button.onclick=function(){if(item[1]&&!window.confirm('Discard your unsaved draft?'))return;void recover(s,key,item[1]);};node.appendChild(button);});
    var exportButton=document.createElement('button');exportButton.textContent='Export draft';exportButton.onclick=function(){var url=URL.createObjectURL(new Blob([JSON.stringify(s.value,null,2)],{type:'application/json'}));var a=document.createElement('a');a.href=url;a.download=key+'-draft.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);};node.appendChild(exportButton);
    (document.body||document.documentElement).appendChild(node);s.notice=node;
  }
  async function recover(s,key,discard){
    if(s.recovering)return;
    s.recovering=true;s.emit();
    try{
      await s.chain;
      var result=await request('get',{key:key});
      if(!s.ready||discard){if(result.revision)s.value=result.value;s.revision=result.revision;s.ready=true;s.dirty=false;}
      else if(JSON.stringify(result.value)===JSON.stringify(s.value)){s.revision=result.revision;s.dirty=false;}
      else {
        if(result.revision!==s.revision)throw new Error('Another save changed this data. Export your draft, then reload saved data before merging.');
        var saved=await request('set',{key:key,value:s.value,revision:result.revision});s.revision=saved.revision;s.dirty=false;
      }
      s.error=null;manualDirty=false;if(s.notice){s.notice.remove();s.notice=null;}
    }catch(e){s.error=e.message;recovery(s,key);}finally{s.recovering=false;s.emit();}
  }
  function slot(key, initial){
    if(slots.has(key)) return slots.get(key);
    var s={value:typeof initial==='function'?initial():initial,revision:0,ready:false,error:null,saving:false,dirty:false,recovering:false,writes:0,listeners:new Set(),chain:Promise.resolve()};
    slots.set(key,s);
    s.emit=function(){s.listeners.forEach(function(fn){fn();});signalDirty();};
    s.load=request('get',{key:key}).then(function(r){if(r.revision) s.value=r.value;s.revision=r.revision;s.ready=true;s.emit();}).catch(function(e){s.error=e.message;recovery(s,key);s.emit();});
    return s;
  }
  function useArtifactState(key, initial){
    var R=window.React,s=slot(key,initial), force=R.useState(0)[1];
    R.useEffect(function(){var f=function(){force(function(v){return v+1;});};s.listeners.add(f);f();return function(){s.listeners.delete(f);};},[key]);
    function set(value){
      if(!s.ready || s.recovering){window.__artifactError(new Error('Saved state is loading; please wait or retry.'));return;}
      var next=typeof value==='function'?value(s.value):value;
      // Snapshot before queueing: callers cannot mutate a pending payload.
      try{next=JSON.parse(JSON.stringify(next));}catch(e){window.__artifactError(e);return;}
      s.value=next;s.dirty=true;s.writes++;s.saving=true;s.emit();
      s.chain=s.chain.then(function(){if(s.error)return;return request('set',{key:key,value:next,revision:s.revision}).then(function(r){s.revision=r.revision;});}).catch(function(e){s.error=e.message;recovery(s,key);}).finally(function(){s.writes--;s.saving=s.writes>0;if(!s.saving&&!s.error){s.dirty=false;manualDirty=false;}s.emit();});
    }
    return [s.value,R.useCallback(set,[s,key]),{ready:s.ready,saving:s.saving,error:s.error,dirty:s.dirty,recovering:s.recovering,retry:function(){return recover(s,key,false);},reload:function(){return recover(s,key,true);}}];
  }
  var worker=null, active=null, jobs=[], globals={}, pythonSeq=0;
  function pump(){
    if(active || !jobs.length)return;
    active=jobs.shift();
    try {
    if(!worker){
      var source="importScripts("+JSON.stringify(__ARTIFACT_ORIGIN__+'/vendor/artifact-python-worker.js?v=2')+");";
      var url=URL.createObjectURL(new Blob([source],{type:'application/javascript'}));
      worker=new Worker(url);URL.revokeObjectURL(url);
      var ownWorker=worker;
      worker.onmessage=function(e){if(worker!==ownWorker || !active || e.data.id!==active.id)return;if(e.data.phase){window.dispatchEvent(new CustomEvent('backstory:python-status',{detail:{phase:e.data.phase}}));if(active.onStatus)try{active.onStatus(e.data.phase);}catch{}if(e.data.phase==='executing'){clearTimeout(active.timer);active.timer=setTimeout(stopTimedOut,active.timeout);}return;}var job=active;clearTimeout(job.timer);active=null;try{if(job.onOutput)job.onOutput(String(e.data.stdout||'')+String(e.data.stderr||''));e.data.error?job.reject(new Error(e.data.error)):job.resolve(e.data.result);}catch(error){job.reject(error);}window.dispatchEvent(new CustomEvent('backstory:python-status',{detail:{phase:e.data.error?'error':'ready'}}));pump();};
      worker.onerror=function(e){if(worker!==ownWorker)return;var job=active;if(worker)worker.terminate();worker=null;active=null;if(job){clearTimeout(job.timer);job.reject(new Error(e.message||'Python worker failed'));}pump();};
    }
    active.timer=setTimeout(stopTimedOut,90000);
    worker.postMessage({id:active.id,code:active.code,input:active.input,globals:active.globals,inlineSession:active.inlineSession,origin:__ARTIFACT_ORIGIN__,runtimeVersion:__PYTHON_VERSION__,protocol:2});
    } catch(e) {var failed=active;if(worker)worker.terminate();worker=null;active=null;if(failed){clearTimeout(failed.timer);failed.reject(e);}pump();}
  }
  function stopTimedOut(){var job=active;if(!job)return;worker.terminate();worker=null;active=null;job.reject(new Error('Python startup or execution timed out. Retry the calculation to restart the runtime.'));pump();}
  function runPython(code,input,options){
    return new Promise(function(resolve,reject){
      if(typeof code!=='string'||code.length>100000)return reject(new Error('Python code must be at most 100,000 characters.'));
      if(jobs.length>=4)return reject(new Error('Too many queued Python calculations.'));
      var snapshot=JSON.stringify(input===undefined?null:input);
      if(typeof snapshot!=='string')return reject(new Error('Python input must be JSON-compatible.'));
      if(snapshot.length>1000000)return reject(new Error('Python input exceeds 1,000,000 characters.'));
      var timeout=options&&options.timeoutMs!==undefined?options.timeoutMs:30000;
      if(typeof timeout!=='number'||!Number.isFinite(timeout))return reject(new Error('Python timeout must be a finite number.'));
      jobs.push({id:++pythonSeq,code:code,input:JSON.parse(snapshot),globals:JSON.parse(JSON.stringify(globals)),inlineSession:!!(options&&options.inlineSession),onStatus:options&&typeof options.onStatus==='function'?options.onStatus:null,onOutput:options&&typeof options.onOutput==='function'?options.onOutput:null,timeout:Math.max(1000,Math.min(60000,timeout)),resolve:resolve,reject:reject});pump();
    });
  }
  function cancelPython(){if(worker)worker.terminate();worker=null;if(active){clearTimeout(active.timer);active.reject(new Error('Python cancelled.'));active=null;}jobs.splice(0).forEach(function(j){j.reject(new Error('Python cancelled.'));});}
  // Compatibility facade for generated components that previously checked
  // window.pyodide. Execution initializes lazily, in an isolated worker.
  window.pyodide={runPythonAsync:function(code){return runPython(code,null);},globals:{set:function(k,v){globals[k]=v;},delete:function(k){delete globals[k];}},loadPackagesFromImports:function(){return Promise.resolve();}};
  window.BackstoryArtifact={useArtifactState:useArtifactState,setDirty:function(value){manualDirty=!!value;signalDirty();},loadState:function(key){return request('get',{key:key});},saveState:async function(key,value,revision){manualDirty=true;signalDirty();var result=await request('set',{key:key,value:value,revision:revision});manualDirty=false;signalDirty();return result;},runPython:runPython,cancelPython:cancelPython};
})();
`

export function artifactClientRuntime(origin: string): string {
  return ARTIFACT_CLIENT_RUNTIME.replaceAll('__ARTIFACT_ORIGIN__', JSON.stringify(origin).replace(/</g, '\\u003c')).replaceAll('__PYTHON_VERSION__', JSON.stringify(pythonVersion))
}
