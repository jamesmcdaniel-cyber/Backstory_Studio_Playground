import pythonPackage from 'pyodide/package.json'
/** Runs only in the opaque-origin artifact frame, never in the app window. */
export const ARTIFACT_CLIENT_RUNTIME = String.raw`
(function(){
  // Runtime errors: the first 20 (message + stack, de-duplicated) go to the
  // parent once the page has loaded, and again as new ones appear, so the
  // assistant can see what broke instead of being told "it looks wrong".
  var errors=[], errorIndex=new Map(), errorsPosted=0, errorTimer=null, loaded=document.readyState==='complete';
  function clip(v){return String(v==null?'':v).slice(0,500);}
  function record(e){
    try{
      if(e&&typeof e==='object'){if(e.__backstorySeen)return;try{Object.defineProperty(e,'__backstorySeen',{value:true});}catch(x){}}
      var message=clip(e&&typeof e==='object'&&'message' in e?e.message:e)||'Unknown error';
      var stack=e&&typeof e==='object'&&e.stack?clip(String(e.stack).split('\n').slice(0,6).join('\n')):'';
      var id=message+' @@ '+stack, known=errorIndex.get(id);
      if(known){known.count++;}
      else if(errors.length>=20)return;
      else{known={message:message,count:1};if(stack)known.stack=stack;errors.push(known);errorIndex.set(id,known);}
      scheduleErrorReport();
    }catch(x){}
  }
  function postErrors(){
    errorTimer=null;
    if(!errors.length||window.parent===window)return;
    errorsPosted=errors.length;
    window.parent.postMessage({type:'backstory:render-errors',errors:errors.map(function(e){return {message:e.message,stack:e.stack,count:e.count};})},'*');
  }
  function scheduleErrorReport(){
    if(!loaded||errorTimer)return;
    errorTimer=setTimeout(postErrors,errorsPosted?2000:50);
  }
  if(!loaded)window.addEventListener('load',function(){loaded=true;setTimeout(function(){if(errors.length)scheduleErrorReport();},0);});
  window.addEventListener('error',function(e){record(e.error||e.message);});
  window.addEventListener('unhandledrejection',function(e){record(e.reason);});
  (function(){var original=window.console&&window.console.error;if(!original)return;window.console.error=function(){try{var parts=Array.prototype.map.call(arguments,function(a){if(a&&typeof a==='object'&&a.message)return a;if(typeof a==='string')return a;try{return JSON.stringify(a);}catch(x){return String(a);}});var first=parts[0];record(first&&typeof first==='object'?first:parts.join(' '));}catch(x){}return original.apply(this,arguments);};})();
  // The page's error panel (the prelude installs its own) stays whatever it
  // is; every error shown through it is recorded here first.
  var errorPanel=window.__artifactError||function(e){var node=document.createElement('div');node.setAttribute('role','alert');node.setAttribute('data-backstory-runtime-error','');node.style.cssText='position:fixed;bottom:8px;left:8px;right:8px;background:#fff1f2;color:#9f1239;padding:12px;z-index:2147483647';node.textContent=String(e&&e.message||e);(document.body||document.documentElement).appendChild(node);};
  Object.defineProperty(window,'__artifactError',{configurable:true,enumerable:true,get:function(){return function(e){record(e);return errorPanel(e);};},set:function(fn){if(typeof fn==='function')errorPanel=fn;}});
  var pending = new Map(), seq = 0;
  window.addEventListener('message', function(e){
    if(e.source !== window.parent || !e.data || e.data.type !== 'backstory:state-result') return;
    var p = pending.get(e.data.id); if(!p) return;
    pending.delete(e.data.id); clearTimeout(p.timer);
    if(e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
  });
  function noBridge(message){var e=new Error(message);e.noBridge=true;return e;}
  function request(op, payload){
    return new Promise(function(resolve,reject){
      if(window.parent === window) return reject(noBridge('Open this artifact inside Backstory to use private saved state.'));
      var id = String(++seq);
      // A first read that nobody answers (a public link, a thumbnail, a page
      // outside the viewer) means there is no bridge here, not an outage.
      var timer = setTimeout(function(){pending.delete(id);reject(op==='get'?noBridge('No saved-state service here.'):new Error('State service did not respond. Changes are not saved.'));},op==='get'?4000:15000);
      pending.set(id,{resolve:resolve,reject:reject,timer:timer});
      window.parent.postMessage({type:'backstory:state',id:id,op:op,payload:payload},'*');
    });
  }
  var slots = new Map();
  function canonical(value){return JSON.stringify(value,function(key,v){if(!v||typeof v!=='object'||Array.isArray(v))return v;var sorted={};Object.keys(v).sort().forEach(function(k){sorted[k]=v[k];});return sorted;});}
  var manualDirty=false;
  function signalDirty(){window.parent.postMessage({type:'backstory:dirty',dirty:manualDirty||Array.from(slots.values()).some(function(s){return s.saving||s.dirty;})},'*');}
  // Typing alone is not a draft: a search box or filter in ordinary state
  // used to pin the frame to a stale version and prompt on every navigation.
  // Pages flag real drafts with setDirty(true); saved-state slots flag their own.
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
      // A write still waiting in the coalescing window goes first, so the
      // recovery compares against what the page actually holds.
      if(s.flushTimer){clearTimeout(s.flushTimer);flush(s,key);}
      await s.chain;
      var result=await request('get',{key:key,shared:s.shared});
      if(!s.ready||discard){if(result.revision)s.value=result.value;s.revision=result.revision;s.ready=true;s.dirty=false;}
      else if(canonical(result.value)===canonical(s.value)){s.revision=result.revision;s.dirty=false;}
      else {
        if(result.revision!==s.revision)throw new Error('Another save changed this data. Export your draft, then reload saved data before merging.');
        var saved=await request('set',{key:key,value:s.value,revision:result.revision,shared:s.shared});s.revision=saved.revision;s.dirty=false;
      }
      s.error=null;manualDirty=false;if(s.notice){s.notice.remove();s.notice=null;}
    }catch(e){s.error=e.message;recovery(s,key);}finally{s.recovering=false;s.emit();}
  }
  function slot(key, initial, shared){
    var slotId=(shared?'shared:':'private:')+key;
    if(slots.has(slotId)) return slots.get(slotId);
    var s={value:typeof initial==='function'?initial():initial,revision:0,ready:false,readOnly:false,error:null,saving:false,dirty:false,recovering:false,writes:0,flushTimer:null,listeners:new Set(),chain:Promise.resolve(),shared:!!shared};
    slots.set(slotId,s);
    s.emit=function(){s.listeners.forEach(function(fn){fn();});signalDirty();};
    s.load=request('get',{key:key,shared:s.shared}).then(function(r){if(r.revision) s.value=r.value;s.revision=r.revision;s.readOnly=!!r.readOnly;s.ready=true;s.emit();}).catch(function(e){
      // No bridge: the page works on its initial data, read-only, with no banner.
      if(e.noBridge){s.readOnly=true;s.ready=true;s.emit();return;}
      s.error=e.message;recovery(s,key);s.emit();});
    return s;
  }
  // Writes to one key within a short window become one save: a field bound
  // to state used to send a request per keystroke and hit the save limit.
  var FLUSH_MS=400;
  function flush(s,key){
    s.flushTimer=null;
    var payload=s.value;
    s.writes++;s.saving=true;
    s.chain=s.chain.then(function(){if(s.error)return;return request('set',{key:key,value:payload,revision:s.revision,shared:s.shared}).then(function(r){s.revision=r.revision;});}).catch(function(e){s.error=e.message;recovery(s,key);}).finally(function(){
      s.writes--;
      if(s.value!==payload&&!s.flushTimer&&!s.error){s.flushTimer=setTimeout(function(){flush(s,key);},0);}
      s.saving=s.writes>0||!!s.flushTimer;
      if(!s.saving&&!s.error){s.dirty=false;}
      s.emit();});
  }
  function useStateSlot(key, initial, shared){
    var R=window.React,s=slot(key,initial,shared), force=R.useState(0)[1];
    R.useEffect(function(){var f=function(){force(function(v){return v+1;});};s.listeners.add(f);f();return function(){s.listeners.delete(f);};},[key]);
    function set(value){
      if(!s.ready || s.recovering){window.__artifactError(new Error('Saved state is loading; please wait or retry.'));return;}
      var next=typeof value==='function'?value(s.value):value;
      // Snapshot before queueing: callers cannot mutate a pending payload.
      try{next=JSON.parse(JSON.stringify(next));}catch(e){window.__artifactError(e);return;}
      s.value=next;
      // Read-only here: the page keeps working on the value in memory.
      if(s.readOnly){s.emit();return;}
      s.dirty=true;s.saving=true;
      if(!s.flushTimer)s.flushTimer=setTimeout(function(){flush(s,key);},FLUSH_MS);
      s.emit();
    }
    return [s.value,R.useCallback(set,[s,key]),{ready:s.ready,readOnly:s.readOnly,shared:s.shared,saving:s.saving,error:s.error,dirty:s.dirty,recovering:s.recovering,retry:function(){return recover(s,key,false);},reload:function(){return recover(s,key,true);}}];
  }
  function useArtifactState(key, initial){return useStateSlot(key,initial,false);}
  // Shared state: one value for everyone who opens the artifact, keyed by
  // artifact + key alone. Readers see it; editors change it; a conflict
  // means someone else saved first.
  function useSharedArtifactState(key, initial){return useStateSlot(key,initial,true);}
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
  window.BackstoryArtifact={useArtifactState:useArtifactState,useSharedArtifactState:useSharedArtifactState,setDirty:function(value){manualDirty=!!value;signalDirty();},loadState:function(key){return request('get',{key:key});},saveState:async function(key,value,revision){manualDirty=true;signalDirty();var result=await request('set',{key:key,value:value,revision:revision});manualDirty=false;signalDirty();return result;},loadSharedState:function(key){return request('get',{key:key,shared:true});},saveSharedState:async function(key,value,revision){manualDirty=true;signalDirty();var result=await request('set',{key:key,value:value,revision:revision,shared:true});manualDirty=false;signalDirty();return result;},runPython:runPython,cancelPython:cancelPython};
})();
`

export function artifactClientRuntime(origin: string): string {
  return ARTIFACT_CLIENT_RUNTIME.replaceAll('__ARTIFACT_ORIGIN__', JSON.stringify(origin).replace(/</g, '\\u003c')).replaceAll('__PYTHON_VERSION__', JSON.stringify(pythonPackage.version))
}
