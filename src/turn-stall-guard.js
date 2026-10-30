// Model-phase watchdog. Tool waits pause it; tool completion rearms it.
export const DEFAULT_TURN_STALL_MS = 45000;
export const SUBSTANTIVE_EVENTS = Object.freeze(['assistant/message','assistant/chunk','assistant/delta','assistant/message/delta']);
export function createTurnStallGuard({stallMs=DEFAULT_TURN_STALL_MS,limitForSession,maxModelMs=180000,onStall=()=>{},log=()=>{},timers=globalThis,now=Date.now}={}) {
  const limit=Number(stallMs),enabled=Number.isFinite(limit)&&limit>0,armed=new Map();
  function clearTimer(e){if(e.timer!=null){timers.clearTimeout(e.timer);e.modelElapsed+=Math.max(0,now()-e.activeSince);}e.timer=null;}
  function forget(sid){const e=armed.get(sid);if(e)clearTimer(e);armed.delete(sid);}
  function arm(sid,e){
    clearTimer(e);e.phase='model';e.activeSince=now();
    const snapshot=e;
    e.timer=timers.setTimeout(()=>{
      if(armed.get(sid)!==snapshot||e.phase!=='model')return;
      armed.delete(sid);
      try{Promise.resolve(onStall(sid,{turnId:e.turnId,waitedMs:now()-e.activeSince,stallMs:e.limit,hadToolCall:e.hadToolCall})).catch(error=>log('静默处置失败：'+error.message));}
      catch(error){log('静默处置异常：'+error.message);}
    },Math.max(1,Math.min(e.limit,maxModelMs-e.modelElapsed)));
  }
  function meaningful(event){
    const d=event.data||{};
    if(typeof d.text==='string'&&d.text.trim())return true;
    if(typeof d.delta==='string'&&d.delta.trim())return true;
    if(typeof d.delta?.text==='string'&&d.delta.text.trim())return true;
    if((d.message?.content||[]).some(b=>b?.type==='text'&&b.text?.trim()))return true;
    return [...(d.stream||[]),d.chunk].some(b=>['text','text-delta'].includes(b?.type)&&String(b.text??b.delta??'').trim());
  }
  function observe(sid,event){
    if(!enabled||!sid)return false;
    const type=event?.type,d=event?.data||{},e=armed.get(sid);
    if(type==='turn/start'){
      if(e&&String(e.turnId)===String(d.turn))return false;
      forget(sid);
      const next={turnId:d.turn,startedAt:now(),timer:null,phase:'model',tools:new Set(),hadToolCall:false,modelElapsed:0,limit:Math.max(1,Number(limitForSession?.(sid))||limit)};
      armed.set(sid,next);arm(sid,next);return true;
    }
    if(!e||d.turn!=null&&String(d.turn)!==String(e.turnId))return false;
    if(type==='turn/end'){forget(sid);return true;}
    if(type==='tool/call'){
      clearTimer(e);e.phase='tool';e.hadToolCall=true;e.tools.add(String(d.callId??'tool'));return true;
    }
    if(type==='tool/result'){
      e.tools.delete(String(d.callId??'tool'));
      if(!e.tools.size)arm(sid,e);return true;
    }
    if(['question/requested','approval/requested'].includes(type)){clearTimer(e);e.phase='question';return true;}
    if(SUBSTANTIVE_EVENTS.includes(type)&&e.phase==='model'&&meaningful(event)){arm(sid,e);return true;}
    return false;
  }
  function snapshot(){return Object.fromEntries([...armed].map(([sid,e])=>[sid,{turnId:e.turnId??null,settled:e.phase!=='model',phase:e.phase,hadToolCall:e.hadToolCall,waitedMs:now()-e.startedAt}]));}
  function expect(sid){if(!enabled||!sid||armed.has(sid))return;
    const e={turnId:null,startedAt:now(),timer:null,phase:'model',tools:new Set(),hadToolCall:false,modelElapsed:0,limit:Math.max(1,Number(limitForSession?.(sid))||limit)};
    armed.set(sid,e);arm(sid,e);}
  return {observe,expect,forget,clearAll:()=>{for(const sid of [...armed.keys()])forget(sid);},snapshot,enabled,limit};
}
