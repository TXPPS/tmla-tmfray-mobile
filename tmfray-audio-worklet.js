// TM-FRAY CP09 Native WASM host. Does not contain DSP algorithms.
const TM_PARAM_NAMES=['DRIVE','WOBBLE','TONE','NOISE','T MIX','FRAY','SIZE','GRAVITY','WEAR','BLEND','F MIX','SPACE','TEXTURE','BLOOM','SOFT','G MIX','TIME','FDBK','WOW','FLTR','D MIX','INPUT','MIX','OUTPUT','SPD MIX'];
const TM_EFFECT_IDS={tape:0,fray:1,grove:2,delay:3};
const TM_FRAY_MODES=['FALL','RISE','SWAY','WANDER','COLLAPSE'];
const TM_GROVE_MODES=['PAPER','WOOD','MOSS','DUST'];
class TMNativeCore {
 constructor(){this.e=null;this.memory=null;this.lastRoute='';this.frames=0;this.lastBrake=null;this.lastPower=null;this.lastSyncKey='';}
 async init(binary,rate){
  const env={exp:Math.exp,sin:Math.sin,cos:Math.cos,tanh:Math.tanh,pow:Math.pow,fmod:(a,b)=>a%b,
   round:(v)=>Math.sign(v)*Math.floor(Math.abs(v)+.5),
   roundf:(v)=>Math.sign(v)*Math.floor(Math.abs(v)+.5),__cxa_atexit:()=>0};
  const result=await WebAssembly.instantiate(binary,{env});
  this.e=result.instance?result.instance.exports:result.exports;
  this.e.__wasm_call_ctors?.();
  if(this.e.tm_init(rate)!==1)throw Error('Native C++ DSP initialization failed');
  this.memory=this.e.memory;
  return true;
 }
 load(left,right){
  if(!this.e)throw Error('C++ DSP not initialized');
  const n=Math.min(left.length,right.length);
  if(n<2)throw Error('Audio has insufficient samples');
  const ptr=this.e.tm_source_alloc(n);
  if(!ptr)throw Error('C++ preview memory limit reached. Try a shorter or lower-sample-rate file.');
  const out=new Float32Array(this.memory.buffer);
  out.set(left.subarray(0,n),ptr>>2);
  out.set(right.subarray(0,n),this.e.tm_source_right()>>2);
  if(this.e.tm_source_commit(1)!==1)throw Error('Native audio source binding failed');
  this.frames=n;
 }
 sync(s){
  if(!this.e||!s)return;
  const key=JSON.stringify(s);
  if(key===this.lastSyncKey)return;
  const e=this.e;
  s.knobs.forEach((v,i)=>e.tm_set_parameter(i,v));
  s.delay.forEach((v,i)=>e.tm_set_parameter(16+i,v));
  e.tm_fray_performance(Math.max(0,Math.min(3,Number(s.frayPerformance)||0)));
  e.tm_mode(1,TM_FRAY_MODES.indexOf(s.frayMode));
  e.tm_mode(2,TM_GROVE_MODES.indexOf(s.groveMode));
  e.tm_mode(3,s.delayAge);
  for(let m=0;m<5;m++)for(let k=0;k<6;k++)e.tm_advanced(1,m,k,s.frayAdvanced[m][k]);
  for(let m=0;m<4;m++)for(let k=0;k<6;k++)e.tm_advanced(2,m,k,s.groveAdvanced[m][k]);
  [s.enabled.tape,s.enabled.fray,s.enabled.grove,s.enabled.delay].forEach((v,i)=>e.tm_enabled(i,v?1:0));
  e.tm_tempo(s.bpm,s.sync?1:0,s.tempoRatio);
  e.tm_transport(s.speed,s.wobble,s.playing?1:0,s.brake?1:0);
  e.tm_touch_enabled(s.touchEnabled?1:0);
  e.tm_pitch_only(s.pitchOnly?1:0,s.pitchRatio);
  e.tm_reverse(s.reverse?1:0);
  if(this.lastBrake!==s.brake){e.tm_brake(s.brake?1:0,s.brakeSeconds);this.lastBrake=s.brake;}
  if(this.lastPower!==s.powered){const seconds=(this.lastPower===null||!s.playing)?0:(s.powered?.95:1.6);e.tm_power(s.powered?1:0,seconds);this.lastPower=s.powered;}
  if(s.route){const r=s.route; e.tm_routing(r.mode,...r.order);e.tm_route_blend(r.blend,r.rawDry?1:0);}
  this.lastSyncKey=key;
 }
 render(frames,outL,outR){
  if(!this.e||!this.e.tm_render(frames)){outL.fill(0);outR.fill(0);return false;}
  // tm_alloc grows linear memory during load; obtain a fresh view each render.
  const f=new Float32Array(this.memory.buffer);
  outL.set(f.subarray(this.e.tm_output_l()>>2,(this.e.tm_output_l()>>2)+frames));
  outR.set(f.subarray(this.e.tm_output_r()>>2,(this.e.tm_output_r()>>2)+frames));
  return true;
 }
 reset(){this.e?.tm_reset();this.lastSyncKey='';}
 play(on){this.e?.tm_play(on?1:0);}
 touch(side,action,amount){this.e?.tm_touch(side,action,amount||.75);}
 travel(){return this.e?.tm_tape_travel()||0;}
}
class TMFrayNativeProcessor extends AudioWorkletProcessor{
 constructor(){
  super();this.core=new TMNativeCore();this.ready=false;this.count=0;
  this.lastRoute='';this.routingFade=1;this.routePending=null;this.routeFadeDelta=0;
  // Global output envelope: wet, dry, feedback and delayed signals share one physical transport gate.
  this.transportGate=1;this.transportFrom=1;this.transportTo=1;this.transportProgress=1;this.transportFrames=1;
  this.transportBrake=false;this.transportPower=true;this.transportPlaying=false;
  this.diag={blocks:0,slow:0,nonfinite:0,spikes:0,maxJump:0,maxAbs:0,maxMs:0,lastL:0,lastR:0,previous:false};
  this.port.onmessage=async e=>{
   const msg=e.data;
   try{
    if(msg.type==='init'){
      await this.core.init(msg.binary,sampleRate);this.ready=true;this.port.postMessage({type:'ready',mode:'AudioWorklet/WASM'});
    }else if(!this.ready)return;
    else if(msg.type==='source'){
      this.core.play(false);this.core.load(msg.left,msg.right);this.port.postMessage({type:'loaded',frames:this.core.frames});
     }else if(msg.type==='state'){
      this.updateTransportGate(msg.value);
      const route=JSON.stringify({route:msg.value.route,enabled:msg.value.enabled,frayPerformance:msg.value.frayPerformance});
      if(this.lastRoute&&route!==this.lastRoute){
        this.routePending=msg.value;this.routingFade=1;this.routeFadeDelta=-1/256;
      }else this.core.sync(msg.value);
      this.lastRoute=route;
    }else if(msg.type==='reset'){this.core.reset();this.routingFade=1;this.routePending=null;}
    else if(msg.type==='play'){this.core.play(msg.value);}
    else if(msg.type==='touch'){this.core.touch(msg.side,msg.action,msg.amount);}
   }catch(error){this.port.postMessage({type:'error',message:String(error.message||error)});this.core.play(false);}
  };
 }
 updateTransportGate(s){
  const brake=!!s.brake,power=!!s.powered,playing=!!s.playing;
  const target=playing&&!brake&&power?1:0;
  const changed=brake!==this.transportBrake||power!==this.transportPower||playing!==this.transportPlaying;
  if(changed){
   const seconds=!playing?0:brake!==this.transportBrake?Math.max(.05,Number(s.brakeSeconds)||1):power!==this.transportPower?(power?.95:1.6):.05;
   this.transportFrom=this.transportGate;this.transportTo=target;
   this.transportFrames=Math.max(1,Math.round(seconds*sampleRate));
   this.transportProgress=seconds===0?1:0;
   if(seconds===0)this.transportGate=target;
   this.transportBrake=brake;this.transportPower=power;this.transportPlaying=playing;
  }
 }
 applyTransportGate(l,r){
  for(let i=0;i<l.length;i++){
   if(this.transportProgress<1){
    this.transportProgress=Math.min(1,this.transportProgress+1/this.transportFrames);
    const u=this.transportProgress,curve=u*u*(3-2*u);
    this.transportGate=this.transportFrom+(this.transportTo-this.transportFrom)*curve;
   }else this.transportGate=this.transportTo;
   // A single post-routing gate prevents any delayed/wet/dry branch from leaking past stop.
   const gain=this.transportGate<1e-7?0:this.transportGate;
   l[i]*=gain;r[i]*=gain;
  }
 }
 process(inputs,outputs){
  const output=outputs[0];if(!output?.[0])return true;
  const l=output[0],r=output[1]||output[0];
  if(!this.ready){l.fill(0);r.fill(0);return true;}
  try{
   if(this.routePending&&this.routingFade<=0){this.core.sync(this.routePending);this.routePending=null;this.routeFadeDelta=1/256;}
   const tmStart=(typeof performance!=='undefined' && typeof performance.now==='function') ? performance.now() : null;
   if(!this.core.render(l.length,l,r)){this.port.postMessage({type:'error',message:'Native render rejected audio block'});return true;}
   if(this.routeFadeDelta){
    for(let i=0;i<l.length;i++){this.routingFade=Math.max(0,Math.min(1,this.routingFade+this.routeFadeDelta));l[i]*=this.routingFade;r[i]*=this.routingFade;}
    if(this.routingFade>=1&&!this.routePending)this.routeFadeDelta=0;
   }
   this.applyTransportGate(l,r);
   // Rebuild 264: diagnostic sampling only; no DSP writes or allocations per sample.
   const d=this.diag;d.blocks++;const ms=tmStart===null ? 0 : performance.now()-tmStart;d.maxMs=Math.max(d.maxMs,ms);
   if(ms>(l.length/sampleRate*1000))d.slow++;
   for(let i=0;i<l.length;i++){
    const a=l[i],b=r[i];if(!Number.isFinite(a)||!Number.isFinite(b)){d.nonfinite++;continue;}
    d.maxAbs=Math.max(d.maxAbs,Math.abs(a),Math.abs(b));
    if(d.previous||i>0){const j=Math.max(Math.abs(a-d.lastL),Math.abs(b-d.lastR));d.maxJump=Math.max(d.maxJump,j);if(j>.2)d.spikes++;}
    d.lastL=a;d.lastR=b;d.previous=true;
   }
   if(this.count%375===0){this.port.postMessage({type:'diagnostic',stats:{...d},time:currentTime});this.diag={blocks:0,slow:0,nonfinite:0,spikes:0,maxJump:0,maxAbs:0,maxMs:0,lastL:d.lastL,lastR:d.lastR,previous:d.previous};}
   if(++this.count%16===0)this.port.postMessage({type:'travel',seconds:this.core.travel()});
  }catch(error){l.fill(0);r.fill(0);this.port.postMessage({type:'error',message:String(error.message||error)});}
  return true;
 }
}
registerProcessor('tmfray-native-wasm',TMFrayNativeProcessor);
