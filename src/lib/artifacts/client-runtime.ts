import pythonPackage from 'pyodide/package.json'
/** Runs only in the opaque-origin artifact frame, never in the app window. */
export const ARTIFACT_CLIENT_RUNTIME = String.raw`
(function(){
  // The sandbox's opaque origin has no Web Storage: touching localStorage or
  // sessionStorage throws a SecurityError, which broke pages (and their
  // validation) that only meant to remember a filter. They get an in-memory
  // store for the page's lifetime; durable data belongs in saved state.
  ['localStorage','sessionStorage'].forEach(function(name){
    try{if(window[name])return;}catch(x){}
    var data=new Map();
    var store={getItem:function(k){k=String(k);return data.has(k)?data.get(k):null;},setItem:function(k,v){data.set(String(k),String(v));},removeItem:function(k){data.delete(String(k));},clear:function(){data.clear();},key:function(i){var keys=Array.from(data.keys());return i>=0&&i<keys.length?keys[i]:null;}};
    Object.defineProperty(store,'length',{get:function(){return data.size;}});
    try{Object.defineProperty(window,name,{configurable:true,enumerable:true,get:function(){return store;}});}catch(x){}
  });
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
  var STATE_TIMEOUT_MS=15000;
  function stateTimedOut(id,reject){return setTimeout(function(){pending.delete(id);reject(new Error('State service did not respond. Changes are not saved.'));},STATE_TIMEOUT_MS);}
  window.addEventListener('message', function(e){
    if(e.source !== window.parent || !e.data) return;
    if(e.data.type === 'backstory:shared-state-changed'){ applyShared(e.data); return; }
    var p = pending.get(e.data.id); if(!p) return;
    // The viewer acknowledges a request before its fetch: a bridge is here,
    // however slow its first load, so wait for its answer (it gives up at 12s).
    if(e.data.type === 'backstory:state-ack'){ if(!p.acked){p.acked=true;clearTimeout(p.timer);p.timer=stateTimedOut(e.data.id,p.reject);} return; }
    if(e.data.type !== 'backstory:state-result') return;
    pending.delete(e.data.id); clearTimeout(p.timer);
    if(e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
  });
  function noBridge(message){var e=new Error(message);e.noBridge=true;return e;}
  function request(op, payload){
    return new Promise(function(resolve,reject){
      if(window.parent === window) return reject(noBridge('Open this artifact inside Backstory to use private saved state.'));
      var id = String(++seq);
      // A first read that nobody acknowledges or answers (a public link, a
      // thumbnail, a page outside the viewer) means there is no bridge here,
      // not an outage — said fast. One acknowledged waits for its answer.
      var timer = op==='get' ? setTimeout(function(){pending.delete(id);reject(noBridge('No saved-state service here.'));},4000) : stateTimedOut(id,reject);
      pending.set(id,{resolve:resolve,reject:reject,timer:timer,acked:false});
      window.parent.postMessage({type:'backstory:state',id:id,op:op,payload:payload},'*');
    });
  }
  var slots = new Map();
  // Live shared state: the viewer relays another person's save as
  // {key,value,revision}. The highest revision this page holds per key drops
  // echoes and stale deliveries; a slot with an unsaved local edit keeps it
  // (the next save meets the revision check and its conflict path).
  var sharedKnown = new Map(), sharedWatchers = new Map(), sharedSaving = new Map(), sharedHeld = new Map();
  function noteShared(key,revision){if(typeof revision==='number'&&revision>(sharedKnown.get(key)||0))sharedKnown.set(key,revision);}
  function applyShared(d){
    if(typeof d.key!=='string'||typeof d.revision!=='number'||!(d.revision>0))return;
    var s=slots.get('shared:'+d.key);
    if(s){
      // Still loading: the load applies whichever is newer.
      if(!s.ready){if(!s.remote||d.revision>s.remote.revision)s.remote={value:d.value,revision:d.revision};return;}
      if(d.revision<=s.revision)return;
      if(s.dirty||s.saving||s.flushTimer||s.recovering||s.error){if(!s.stale){s.stale=true;s.emit();}return;}
      s.value=d.value;s.revision=d.revision;s.stale=false;
    }else{
      if(d.revision<=(sharedKnown.get(d.key)||0))return;
      // An HTML save of this key is in flight: judge the change once it lands.
      if(sharedSaving.get(d.key)){var h=sharedHeld.get(d.key);if(!h||d.revision>h.revision)sharedHeld.set(d.key,d);return;}
    }
    noteShared(d.key,d.revision);
    if(s)s.emit();
    var fns=sharedWatchers.get(d.key);
    if(fns)Array.from(fns).forEach(function(fn){try{fn({key:d.key,value:d.value,revision:d.revision});}catch(x){record(x);}});
  }
  function onSharedStateChange(key,fn){
    if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(key)||typeof fn!=='function')throw new Error('onSharedStateChange(key, callback): key is letters, digits, underscore or hyphen (max 64).');
    if(!sharedWatchers.has(key))sharedWatchers.set(key,new Set());
    sharedWatchers.get(key).add(fn);
    if(window.parent!==window)window.parent.postMessage({type:'backstory:shared-watch',key:key},'*');
    return function(){var fns=sharedWatchers.get(key);if(fns)fns.delete(fn);};
  }
  async function saveShared(key,value,revision){
    sharedSaving.set(key,(sharedSaving.get(key)||0)+1);
    try{var result=await request('set',{key:key,value:value,revision:revision,shared:true});noteShared(key,result&&result.revision);return result;}
    finally{
      var left=sharedSaving.get(key)-1;
      if(left>0)sharedSaving.set(key,left);
      else{sharedSaving.delete(key);var held=sharedHeld.get(key);sharedHeld.delete(key);if(held)applyShared(held);}
    }
  }
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
      s.error=null;s.stale=false;manualDirty=false;if(s.notice){s.notice.remove();s.notice=null;}
    }catch(e){s.error=e.message;recovery(s,key);}finally{s.recovering=false;s.emit();}
  }
  function slot(key, initial, shared){
    var slotId=(shared?'shared:':'private:')+key;
    if(slots.has(slotId)) return slots.get(slotId);
    var s={value:typeof initial==='function'?initial():initial,revision:0,ready:false,readOnly:false,error:null,saving:false,dirty:false,recovering:false,stale:false,remote:null,writes:0,flushTimer:null,listeners:new Set(),chain:Promise.resolve(),shared:!!shared};
    slots.set(slotId,s);
    s.emit=function(){s.listeners.forEach(function(fn){fn();});signalDirty();};
    s.load=request('get',{key:key,shared:s.shared}).then(function(r){var value=r.value,revision=r.revision;if(s.remote&&s.remote.revision>(revision||0)){value=s.remote.value;revision=s.remote.revision;}s.remote=null;if(revision) s.value=value;s.revision=revision;s.readOnly=!!r.readOnly;s.ready=true;s.emit();}).catch(function(e){
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
    return [s.value,R.useCallback(set,[s,key]),{ready:s.ready,readOnly:s.readOnly,shared:s.shared,saving:s.saving,error:s.error,dirty:s.dirty,recovering:s.recovering,stale:s.stale,retry:function(){return recover(s,key,false);},reload:function(){return recover(s,key,true);}}];
  }
  function useArtifactState(key, initial){return useStateSlot(key,initial,false);}
  // Shared state: one value for everyone who opens the artifact, keyed by
  // artifact + key alone. Readers see it; editors change it; a conflict
  // means someone else saved first. Live: another viewer's save re-renders
  // this one (applyShared) unless it holds an unsaved edit (shared.stale).
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
  window.BackstoryArtifact={useArtifactState:useArtifactState,useSharedArtifactState:useSharedArtifactState,setDirty:function(value){manualDirty=!!value;signalDirty();},loadState:function(key){return request('get',{key:key});},saveState:async function(key,value,revision){manualDirty=true;signalDirty();var result=await request('set',{key:key,value:value,revision:revision});manualDirty=false;signalDirty();return result;},loadSharedState:function(key){return request('get',{key:key,shared:true}).then(function(r){noteShared(key,r&&r.revision);return r;});},saveSharedState:async function(key,value,revision){manualDirty=true;signalDirty();var result=await saveShared(key,value,revision);manualDirty=false;signalDirty();return result;},onSharedStateChange:onSharedStateChange,runPython:runPython,cancelPython:cancelPython};
})();
`

export function artifactClientRuntime(origin: string): string {
  return ARTIFACT_CLIENT_RUNTIME.replaceAll('__ARTIFACT_ORIGIN__', JSON.stringify(origin).replace(/</g, '\\u003c')).replaceAll('__PYTHON_VERSION__', JSON.stringify(pythonPackage.version))
}
