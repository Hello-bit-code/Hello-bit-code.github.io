'use strict';
/* FOLD//MIX — independent, local-only Web Audio DJ console.
   All user music stays inside this browser tab. No uploads or external libraries. */
const el = id => document.getElementById(id);
const statusNode = el('status');
const notice = value => { statusNode.textContent = value; };
const AC = window.AudioContext || window.webkitAudioContext;
if (!AC) {
  notice('이 브라우저는 Web Audio API를 지원하지 않습니다. Chrome에서 열어주세요.');
  throw new Error('Web Audio API is required');
}
const ctx = new AC({latencyHint:'interactive'});
const compressor = ctx.createDynamicsCompressor();
compressor.threshold.value = -10;
compressor.knee.value = 10;
compressor.ratio.value = 6;
compressor.attack.value = 0.004;
compressor.release.value = 0.19;
const master = ctx.createGain();
master.gain.value = .84;
const masterAnalyser = ctx.createAnalyser();
masterAnalyser.fftSize = 512;
compressor.connect(master);
master.connect(masterAnalyser);
masterAnalyser.connect(ctx.destination);
const recordDestination = ctx.createMediaStreamDestination();
masterAnalyser.connect(recordDestination);

const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const number = (n, digits = 1) => Number(n).toFixed(digits);
function timeLabel(sec, dec = false) {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const minutes = String(Math.floor(s / 60)).padStart(2, '0');
  const seconds = String(Math.floor(s % 60)).padStart(2, '0');
  return minutes + ':' + seconds + (dec ? '.' + Math.floor(s * 10 % 10) : '');
}
function setMeter(id, amount) {
  const holder = el(id);
  if (!holder) return;
  const count = Math.round(clamp(amount, 0, 1) * 12);
  Array.from(holder.children).forEach((segment, i) => {
    const lit = i >= 12 - count;
    segment.classList.toggle('lit', lit);
    segment.classList.toggle('hot', lit && i < 3 && id === 'master-meter');
    segment.classList.toggle('peak', lit && i === 0 && id === 'master-meter');
  });
}
function initMeters() {
  for (const id of ['vu-a', 'vu-b', 'master-meter']) {
    const parent = el(id);
    for (let i = 0; i < 12; i++) parent.appendChild(document.createElement('i'));
  }
}
function meterDb(analyser, arr) {
  analyser.getFloatTimeDomainData(arr);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  const rms = Math.sqrt(sum / arr.length);
  return rms > .00001 ? 20 * Math.log10(rms) : -Infinity;
}
const dbToMeter = db => Number.isFinite(db) ? clamp((db + 45) / 42, 0, 1) : 0;
let vinylModulePromise = null;
function ensureVinylModule() {
  if (!ctx.audioWorklet) return Promise.reject(new Error('AudioWorklet 미지원'));
  if (!vinylModulePromise) vinylModulePromise=ctx.audioWorklet.addModule('./scratch-worklet.js').catch(e=>{vinylModulePromise=null;throw e;});
  return vinylModulePromise;
}
// Preload the worklet to avoid a long first touch; playback still requires a user gesture.
void ensureVinylModule().catch(()=>{});
let reverbImpulse=null;
function makeReverbImpulse() {
  if(reverbImpulse) return reverbImpulse;
  const len=Math.floor(ctx.sampleRate*1.7);
  reverbImpulse=ctx.createBuffer(2,len,ctx.sampleRate);
  let state=93827;
  const rand=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  for(let ch=0;ch<2;ch++) {
    const pcm=reverbImpulse.getChannelData(ch);
    for(let i=0;i<len;i++)pcm[i]=(rand()*2-1)*Math.pow(1-i/len,2.65)*.42;
  }
  return reverbImpulse;
}


class Deck {
  constructor(id) {
    this.id = id;
    this.buffer = null;
    this.source = null;
    this.playing = false;
    this.offset = 0;
    this.startedAt = 0;
    this.tempo = 0;
    this.rate = 1;
    this.bpm = 120;
    this.bpmEstimated = false;
    this.beatOffset = 0;
    this.cue = 0;
    this.cueSet = false;
    this.cueHolding = false;
    this.cuePreviewToken = 0;
    this.taps = [];
    this.hot = Array(8).fill(null);
    this.padMode='hot';
    this.samples=[];
    this.scratchVinyl=true;
    this.scratching=false;
    this.scratchTime=0;
    this.scratchSequence=0;
    this.scratchWindowStart=0;
    this.scratchWindowEnd=0;
    this.scratchNode=null;
    this.fxType='echo';
    this.fxTime=1;
    this.fxMix=.35;
    this.fxActive=false;
    this.fxCleanup=[];
    this.loopBeats = 0;
    this.loopIn = 0;
    this.loopOut = 0;
    this.demoRepeat = false;
    this.peaks = [];
    this.generation = 0;

    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf'; this.low.frequency.value = 200;
    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking'; this.mid.frequency.value = 1100; this.mid.Q.value = .85;
    this.high = ctx.createBiquadFilter();
    this.high.type = 'highshelf'; this.high.frequency.value = 6500;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass'; this.filter.frequency.value = 19000;
    this.trimGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.fxSend = ctx.createGain();this.fxSend.gain.value=0;
    this.fxWet = ctx.createGain();this.fxWet.gain.value=.35;
    this.channelGain = ctx.createGain(); this.channelGain.gain.value = .86;
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512;
    this.crossGain = ctx.createGain(); this.crossGain.gain.value = Math.SQRT1_2;
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.filter);
    this.filter.connect(this.trimGain);
    this.trimGain.connect(this.dryGain);
    this.dryGain.connect(this.channelGain);
    this.trimGain.connect(this.fxSend);
    this.fxWet.connect(this.channelGain);
    this.channelGain.connect(this.analyser);
    this.analyser.connect(this.crossGain);
    this.crossGain.connect(compressor);
    this.meterData = new Float32Array(this.analyser.fftSize);
    this.buildEffect();
  }
  get position() {
    if (!this.buffer) return 0;
    if (this.scratching) return this.scratchTime;
    let value = this.playing ? this.offset + (ctx.currentTime - this.startedAt) * this.rate : this.offset;
    if (this.loopBeats > 0 && value >= this.loopOut) {
      const len = this.loopOut - this.loopIn;
      if (len > .01) value = this.loopIn + ((value - this.loopIn) % len);
    } else if (this.demoRepeat && this.loopBeats === 0) {
      value %= this.buffer.duration;
    }
    return clamp(value, 0, this.buffer.duration);
  }
  effectDelaySeconds() {
    return clamp((60/(this.bpm*this.rate||120))*this.fxTime,.045,1.6);
  }
  buildEffect() {
    try{this.fxSend.disconnect();}catch(_){/* initial */}
    for(const node of this.fxCleanup){try{node.stop?.();}catch(_){}try{node.disconnect();}catch(_){}}
    this.fxCleanup=[];
    const remember=node=>{this.fxCleanup.push(node);return node;};
    const type=this.fxType;
    if (['echo','dub','delay'].includes(type)) {
      const delay=remember(ctx.createDelay(2));
      delay.delayTime.value=this.effectDelaySeconds();
      const feedback=remember(ctx.createGain());
      feedback.gain.value=type==='dub'?.58:type==='echo'?.43:.24;
      const feedbackFilter=remember(ctx.createBiquadFilter());
      feedbackFilter.type='lowpass';feedbackFilter.frequency.value=type==='dub'?1800:7500;
      this.fxSend.connect(delay);
      delay.connect(this.fxWet);
      delay.connect(feedback);
      feedback.connect(feedbackFilter);feedbackFilter.connect(delay);
      this.fxDelay=delay;
    } else if(type==='reverb') {
      const conv=remember(ctx.createConvolver());conv.buffer=makeReverbImpulse();
      this.fxSend.connect(conv);conv.connect(this.fxWet);
      this.fxDelay=null;
    } else if(type==='flanger') {
      const delay=remember(ctx.createDelay(.05));delay.delayTime.value=.003;
      const fb=remember(ctx.createGain());fb.gain.value=.25;
      const osc=remember(ctx.createOscillator());osc.frequency.value=.34;
      const depth=remember(ctx.createGain());depth.gain.value=.0025;
      osc.connect(depth);depth.connect(delay.delayTime);osc.start();
      this.fxSend.connect(delay);delay.connect(fb);fb.connect(delay);delay.connect(this.fxWet);
      this.fxDelay=null;
    } else if(type==='phaser') {
      const filters=Array.from({length:3},()=>{const f=remember(ctx.createBiquadFilter());f.type='allpass';f.frequency.value=750;f.Q.value=.8;return f;});
      const osc=remember(ctx.createOscillator());osc.frequency.value=.35;
      const depth=remember(ctx.createGain());depth.gain.value=550;
      osc.connect(depth);for(const f of filters)depth.connect(f.frequency);osc.start();
      this.fxSend.connect(filters[0]);filters[0].connect(filters[1]);filters[1].connect(filters[2]);filters[2].connect(this.fxWet);
      this.fxDelay=null;
    }
    this.fxSend.gain.setTargetAtTime(this.fxActive?1:0,ctx.currentTime,.02);
    this.fxWet.gain.setTargetAtTime(this.fxMix,ctx.currentTime,.02);
  }
  refreshEffectTime() {
    if(this.fxDelay)this.fxDelay.delayTime.setTargetAtTime(this.effectDelaySeconds(),ctx.currentTime,.025);
  }
  async beginScratch() {
    if(!this.buffer || this.scratching)return;
    this.scratchWasPlaying=this.playing;
    this.pause();
    this.scratching=true;
    this.scratchTime=this.offset;
    const ticket=++this.scratchSequence;
    renderControls(this);
    try {
      await ctx.resume();
      await ensureVinylModule();
      if(ticket!==this.scratchSequence || !this.scratching)return;
      if(!this.scratchNode){
        this.scratchNode=new AudioWorkletNode(ctx,'vinyl-touch-processor',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
        this.scratchNode.connect(this.low);
      }
      this.loadScratchWindow();
    }catch(error){
      this.scratchFailed=true;
      notice('스크래치 오디오 엔진을 시작할 수 없습니다: '+error.message);
    }
  }
  loadScratchWindow() {
    if(!this.buffer || !this.scratchNode)return;
    const rate=this.buffer.sampleRate;
    const size=Math.min(this.buffer.duration,8);
    const begin=clamp(this.scratchTime-size/2,0,Math.max(0,this.buffer.duration-size));
    const from=Math.floor(begin*rate);
    const to=Math.min(this.buffer.length,from+Math.ceil(size*rate));
    const left=this.buffer.getChannelData(0).slice(from,to);
    const right=this.buffer.getChannelData(Math.min(1,this.buffer.numberOfChannels-1)).slice(from,to);
    this.scratchWindowStart=from/rate;
    this.scratchWindowEnd=to/rate;
    this.scratchNode.port.postMessage({type:'load',left:left.buffer,right:right.buffer,head:(this.scratchTime-this.scratchWindowStart)*rate},[left.buffer,right.buffer]);
  }
  moveScratch(radians) {
    if(!this.scratching||!this.buffer)return;
    const seconds=radians/(Math.PI*2)*1.55;
    this.scratchTime=clamp(this.scratchTime+seconds,0,Math.max(0,this.buffer.duration-.005));
    if(this.scratchNode&&!this.scratchFailed){
      if(this.scratchTime<this.scratchWindowStart+.25 || this.scratchTime>this.scratchWindowEnd-.25) this.loadScratchWindow();
      this.scratchNode.port.postMessage({type:'move',head:(this.scratchTime-this.scratchWindowStart)*this.buffer.sampleRate});
    }
  }
  endScratch(resume=true) {
    if(!this.scratching)return;
    ++this.scratchSequence;
    this.scratchNode?.port.postMessage({type:'stop'});
    const shouldPlay=this.scratchWasPlaying && resume;
    this.scratching=false;
    this.offset=this.scratchTime;
    renderControls(this);
    if(shouldPlay)void this.play();
  }
  updateLoopSource() {
    if (!this.source || !this.buffer) return;
    const active = this.loopBeats > 0;
    this.source.loop = active || this.demoRepeat;
    this.source.loopStart = active ? this.loopIn : 0;
    this.source.loopEnd = active ? this.loopOut : this.buffer.duration;
  }
  stopSource() {
    if (!this.source) return;
    const old = this.source;
    this.source = null;
    old.onended = null;
    try { old.stop(); } catch (_) { /* already stopped */ }
    old.disconnect();
  }
  pause() {
    if (!this.playing) return;
    this.offset = this.position;
    this.playing = false;
    this.stopSource();
    renderControls(this);
  }
  stop() {
    this.pause();
    this.offset = 0;
    renderControls(this);
  }
  async play() {
    if (!this.buffer || this.playing) {
      if (!this.buffer) notice('DECK ' + this.id.toUpperCase() + ': 먼저 음원이나 DEMO를 선택하세요.');
      return;
    }
    try { await ctx.resume(); }
    catch (error) { notice('오디오 재생 실패: ' + error.message); return; }
    if (this.playing) return;
    if (this.offset >= this.buffer.duration - .01) this.offset = 0;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    this.source = src;
    this.updateLoopSource();
    src.connect(this.low);
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.playing = false;
      this.offset = 0;
      renderControls(this);
    };
    this.startedAt = ctx.currentTime;
    this.playing = true;
    try { src.start(0, this.offset); }
    catch (error) {
      this.source = null; this.playing = false;
      notice('재생 실패: ' + error.message);
      return;
    }
    renderControls(this);
    notice('DECK ' + this.id.toUpperCase() + ' 재생 중 · 크로스페이더로 믹싱하세요.');
  }
  async toggle() { if (this.playing) this.pause(); else await this.play(); }
  seek(time) {
    if (!this.buffer) return;
    const current = clamp(time, 0, Math.max(0, this.buffer.duration - .005));
    const resume = this.playing;
    if (resume) this.pause();
    this.offset = current;
    if (resume) void this.play();
    renderControls(this);
  }
  setPitch(percent) {
    const next = clamp(Number(percent) || 0, -25, 25);
    if (this.playing) {
      this.offset = this.position;
      this.startedAt = ctx.currentTime;
    }
    this.tempo = next;
    this.rate = 1 + next / 100;
    if (this.source) this.source.playbackRate.setValueAtTime(this.rate, ctx.currentTime);
    this.refreshEffectTime();
    el('pitch-' + this.id).value = String(next);
    renderControls(this);
  }
  // CDJ-style CUE: playing -> pause and return; paused off-cue -> set;
  // paused at cue -> momentary preview while pressed.
  setCue() {
    this.cue = this.position;
    this.cueSet = true;
    renderControls(this);
    notice('DECK ' + this.id.toUpperCase() + ' CUE 설정: ' + timeLabel(this.cue, true));
  }
  returnToCue() {
    if (!this.buffer) return;
    this.cuePreviewToken++;
    this.cueHolding = false;
    this.pause();
    this.seek(this.cueSet ? this.cue : 0);
    renderControls(this);
    notice('DECK ' + this.id.toUpperCase() + ' CUE 복귀');
  }
  pressCue() {
    if (!this.buffer) { notice('먼저 음원을 선택하세요.'); return; }
    if (this.playing) { this.returnToCue(); return; }
    if (!this.cueSet || Math.abs(this.position - this.cue) > .075) {
      this.setCue();
      return;
    }
    this.cueHolding = true;
    const token = ++this.cuePreviewToken;
    this.seek(this.cue);
    el('cue-' + this.id).classList.add('is-preview');
    void this.play().then(() => {
      if (token !== this.cuePreviewToken || !this.cueHolding) this.returnToCue();
    });
  }
  releaseCue() {
    if (!this.cueHolding) return;
    this.cueHolding = false;
    this.cuePreviewToken++;
    el('cue-' + this.id).classList.remove('is-preview');
    this.returnToCue();
  }
  hotAction(i) {
    if (!this.buffer) return;
    if (this.hot[i] === null) {
      this.hot[i] = this.position;
      notice('DECK ' + this.id.toUpperCase() + ' HOT CUE ' + (i + 1) + ' 저장');
    } else {
      this.seek(this.hot[i]);
      if (!this.playing) void this.play();
      notice('DECK ' + this.id.toUpperCase() + ' HOT CUE ' + (i + 1) + ' 실행');
    }
    renderControls(this);
  }
  clearHot(i) {
    this.hot[i] = null;
    renderControls(this);
    notice('DECK ' + this.id.toUpperCase() + ' HOT CUE ' + (i + 1) + ' 삭제');
  }
  playSample(i) {
    const buffer=this.samples[i]||stockSamples[i];
    if(!buffer)return;
    void ctx.resume();
    const sound=ctx.createBufferSource();sound.buffer=buffer;
    const level=ctx.createGain();level.gain.value=.79;
    sound.connect(level);level.connect(this.low);
    sound.onended=()=>{sound.disconnect();level.disconnect();};
    sound.start();
  }
  beatJump(beats) {if(this.buffer)this.seek(this.position+beats*60/(this.bpm*this.rate));}
  startRoll(beats) {
    if(!this.buffer||this.rolling)return;
    this.rollStart={position:this.position,time:ctx.currentTime,rate:this.rate,wasPlaying:this.playing};
    this.rolling=true;
    this.setLoop(beats);
    if(!this.playing)void this.play();
  }
  stopRoll(){
    if(!this.rolling)return;
    const roll=this.rollStart;
    this.rolling=false;
    this.setLoop(0);
    this.seek(roll.position+Math.max(0,ctx.currentTime-roll.time)*roll.rate);
    if(!roll.wasPlaying)this.pause();
  }
  setLoop(beats) {
    if (!this.buffer) return;
    if (beats === 0 || (beats === this.loopBeats)) {
      if (this.playing) { this.offset = this.position; this.startedAt = ctx.currentTime; }
      this.loopBeats = 0;
      this.updateLoopSource();
      notice('DECK ' + this.id.toUpperCase() + ' 루프 종료');
    } else {
      const at = this.position;
      const len = beats * 60 / this.bpm;
      const start = Math.min(at, Math.max(0, this.buffer.duration - .09));
      const end = Math.min(this.buffer.duration, start + len);
      if (end - start < .08) return;
      if (this.playing) { this.offset = start; this.startedAt = ctx.currentTime; }
      this.loopIn = start;
      this.loopOut = end;
      this.loopBeats = beats;
      this.updateLoopSource();
      notice('DECK ' + this.id.toUpperCase() + ' · ' + beats + ' BEAT LOOP');
    }
    renderControls(this);
  }
  setBuffer(audioBuffer, title, bpm, repeat) {
    this.endScratch(false);
    this.scratchNode?.port.postMessage({type:'stop'});
    this.pause();
    this.stopSource();
    this.buffer = audioBuffer;
    this.offset = 0;
    this.bpm = bpm;
    this.bpmEstimated = false;
    this.beatOffset = 0;
    this.cueSet = true;
    this.cueHolding = false;
    this.taps = [];
    this.demoRepeat = Boolean(repeat);
    this.cue = 0;
    this.hot = Array(8).fill(null);
    this.loopBeats = 0;
    this.loopIn = 0;
    this.loopOut = 0;
    this.peaks = computePeaks(audioBuffer);
    this.refreshEffectTime();
    el('track-' + this.id).textContent = title;
    el('bpm-' + this.id).value = String(bpm);
    el('bpm-source-' + this.id).textContent = repeat ? 'DEMO' : 'ANALYZING';
    this.setPitch(0);
    renderControls(this);
    drawWave(this);
  }
}
const decks = {a:new Deck('a'), b:new Deck('b')};
function makeStockSamples() {
  const rate=ctx.sampleRate;
  const kinds=['KICK','SNARE','CLAP','HAT','OPEN','TOM','RIM','RISER'];
  let seed=918273;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*2-1;};
  return kinds.map((kind,k)=>{
    const dur=[.6,.32,.32,.14,.6,.54,.22,1.15][k];
    const b=ctx.createBuffer(1,Math.floor(rate*dur),rate);
    const data=b.getChannelData(0);
    for(let n=0;n<data.length;n++){
      const t=n/rate,noise=rand();let x=0;
      if(k===0) x=Math.sin(2*Math.PI*(53*t+100*(1-Math.exp(-t*27))/27))*Math.exp(-t*17)*.88;
      if(k===1) x=(noise*.59+Math.sin(2*Math.PI*180*t)*.35)*Math.exp(-t*23);
      if(k===2) x=noise*.55*(Math.exp(-t*60)+.9*Math.exp(-Math.max(0,t-.045)*70)*(t>.045)+.65*Math.exp(-Math.max(0,t-.09)*76)*(t>.09));
      if(k===3) x=noise*.42*Math.exp(-t*65);
      if(k===4) x=noise*.42*Math.exp(-t*8);
      if(k===5) x=Math.sin(2*Math.PI*(110*t+40*(1-Math.exp(-t*17))/17))*Math.exp(-t*12)*.63;
      if(k===6) x=(Math.sin(2*Math.PI*570*t)*.36+noise*.22)*Math.exp(-t*31);
      if(k===7) x=noise*.32*Math.sin(2*Math.PI*(350*t+900*t*t))*Math.pow(t/dur,.6)*Math.exp(-t*2);
      data[n]=Math.tanh(x);
    }
    return b;
  });
}
const stockSamples=makeStockSamples();
for (const deck of Object.values(decks))deck.samples=stockSamples.slice();
const samplerNames=['KICK','SNARE','CLAP','HAT','OPEN','TOM','RIM','RISER'];
const rollBeats=[.125,.25,.5,1,2,4,8,16];
const beatJumps=[-8,-4,-2,-1,1,2,4,8];
function renderPads(deck){
  const id=deck.id;
  document.querySelectorAll('.pad-modes button[data-deck="'+id+'"]').forEach(b=>b.classList.toggle('selected',b.dataset.padMode===deck.padMode));
  const hints={hot:'HOT CUE: 첫 탭 저장 · 재탭 재생 · 길게 눌러 삭제',sampler:'SAMPLER: 8개의 드럼 소리 재생 · 샘플 불러오기로 교체',roll:'BEAT ROLL: 누르는 동안 루프 · 떼면 원래 타임라인 복귀',jump:'BEAT JUMP: 패드를 누르면 지정 비트만큼 이동'};
  el('pad-hint-'+id).textContent=hints[deck.padMode];
  el('sample-assign-'+id).hidden=deck.padMode!=='sampler';
  document.querySelectorAll('.hotpad[data-deck="'+id+'"]').forEach(button=>{
    const i=Number(button.dataset.pad),mode=deck.padMode;
    let label='';
    if(mode==='hot')label=String(i+1);
    else if(mode==='sampler')label=deck.sampleLabels?.[i]||samplerNames[i];
    else if(mode==='roll')label=(rollBeats[i]<1?'1/'+Math.round(1/rollBeats[i]):rollBeats[i])+' B';
    else label=(beatJumps[i]>0?'+':'')+beatJumps[i];
    button.textContent=label;
    button.classList.toggle('is-set',mode==='hot'&&deck.hot[i]!==null);
    button.classList.toggle('is-sampler',mode==='sampler');
    button.dataset.mode=mode;
    button.title=mode==='hot'?(deck.hot[i]===null?'누르기: CUE 저장':'누르기: CUE 재생, 길게: 삭제'):mode==='sampler'?'샘플 트리거':mode==='roll'?'누르는 동안 롤':'비트 점프';
    button.setAttribute('aria-label',id.toUpperCase()+' '+mode+' 패드 '+label);
  });
}

function computePeaks(buffer) {
  const pcm = buffer.getChannelData(0);
  const count = 600;
  const step = Math.max(1, Math.floor(pcm.length / count));
  const peaks = [];
  for (let x = 0; x < count; x++) {
    const start = Math.floor(x / count * pcm.length);
    const end = Math.min(pcm.length, start + step);
    let peak = .025;
    const hop = Math.max(1, Math.floor((end - start) / 32));
    for (let y = start; y < end; y += hop) peak = Math.max(peak, Math.abs(pcm[y]));
    peaks.push(Math.min(1, peak));
  }
  return peaks;
}
function renderControls(deck) {
  const id = deck.id;
  const played = deck.playing;
  el('play-icon-' + id).textContent = played ? '❚❚' : '▶';
  el('play-label-' + id).textContent = played ? 'PAUSE' : 'PLAY';
  el('play-' + id).classList.toggle('is-playing', played);
  el('state-' + id).textContent = !deck.buffer ? 'READY' : played ? 'PLAYING' : 'PAUSED';
  el('jog-state-' + id).textContent = deck.scratching ? 'SCRATCH' : !deck.buffer ? 'READY' : played ? 'PLAY' : 'CUE';
  el('pitch-display-' + id).textContent = (deck.tempo > 0 ? '+' : '') + number(deck.tempo) + '%';
  el('pitch-value-' + id).textContent = (deck.tempo > 0 ? '+' : '') + number(deck.tempo) + '%';
  el('live-bpm-' + id).textContent = deck.buffer ? number(deck.bpm * deck.rate) + ' BPM' : '--.- BPM';
  el('mini-bpm-' + id).textContent = deck.buffer ? number(deck.bpm * deck.rate) : '--.-';
  el('cue-' + id).classList.toggle('is-cue', deck.cueSet);
  el('cue-' + id).classList.toggle('is-preview', deck.cueHolding);
  el('loop-indicator-' + id).textContent = deck.loopBeats ? 'LOOP ' + deck.loopBeats + ' BEATS' : deck.demoRepeat ? 'DEMO REPEAT' : 'LOOP OFF';
  document.querySelectorAll('[data-loop][data-deck="' + id + '"]').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.loop) > 0 && Number(button.dataset.loop) === deck.loopBeats);
  });
  renderPads(deck);
  updateTime(deck);
}
function updateTime(deck) {
  const id = deck.id;
  const pos = deck.position;
  const duration = deck.buffer ? deck.buffer.duration : 0;
  el('elapsed-' + id).textContent = timeLabel(pos, true);
  el('remain-' + id).textContent = '−' + timeLabel(duration - pos);
  el('jog-' + id).style.setProperty('--rotation', String(pos * 80) + 'deg');
  el('jog-' + id).setAttribute('aria-valuenow', String(duration ? Math.round(pos / duration * 100) : 0));
}
function drawWave(deck) {
  const canvas = el('wave-' + deck.id);
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.ceil(rect.width * dpr), ph = Math.ceil(rect.height * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const p = canvas.getContext('2d');
  p.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width, h = rect.height;
  p.clearRect(0, 0, w, h);
  p.fillStyle = '#090e12'; p.fillRect(0,0,w,h);
  p.strokeStyle = '#273039'; p.lineWidth = 1;
  for (let i = 0; i < 17; i++) { const x = Math.floor(i * w / 16) + .5; p.beginPath(); p.moveTo(x,0);p.lineTo(x,h);p.stroke(); }
  p.beginPath(); p.moveTo(0,h/2+.5);p.lineTo(w,h/2+.5);p.stroke();
  if (!deck.buffer) {
    p.fillStyle = '#78828a'; p.font = 'bold 11px system-ui'; p.textAlign = 'center';
    p.fillText('LOAD TRACK   /   TAP DEMO', w/2, h/2+4);
    return;
  }
  const peaks = deck.peaks;
  const progress = deck.position / deck.buffer.duration;
  for (let i = 0; i < peaks.length; i++) {
    const x = i * w / peaks.length;
    const height = Math.max(2, peaks[i] * h * .44);
    const done = (i / peaks.length) <= progress;
    p.fillStyle = deck.id === 'a' ? (done ? '#9cabb5' : '#4e5962') : (done ? '#b49e82' : '#695f55');
    p.fillRect(x, h / 2 - height, Math.max(.8, w/peaks.length-.3), height*2);
  }
  if (deck.loopBeats) {
    const x = deck.loopIn / deck.buffer.duration * w;
    const end = deck.loopOut / deck.buffer.duration * w;
    p.fillStyle = '#b8a17724'; p.fillRect(x,0,end-x,h);
    p.strokeStyle = '#b59b66'; p.beginPath();p.moveTo(x,0);p.lineTo(x,h);p.moveTo(end,0);p.lineTo(end,h);p.stroke();
  }
  for (let i = 0; i < deck.hot.length; i++) {
    const cue = deck.hot[i];
    if (cue === null) continue;
    const x = cue / deck.buffer.duration * w;
    p.fillStyle = '#d16a50'; p.fillRect(x,0,2,14);
    p.font = 'bold 9px system-ui';p.fillText(String(i+1),x+3,10);
  }
  const x = clamp(progress, 0, 1) * w;
  p.fillStyle = '#f8fcff'; p.fillRect(x-1,0,2,h);
  p.fillStyle = '#eefbff'; p.beginPath();p.moveTo(x-5,0);p.lineTo(x+5,0);p.lineTo(x,7);p.fill();
}
function setCrossfader(value) {
  const x = clamp(Number(value)/100,0,1);
  decks.a.crossGain.gain.setTargetAtTime(Math.cos(x * Math.PI / 2),ctx.currentTime,.01);
  decks.b.crossGain.gain.setTargetAtTime(Math.sin(x * Math.PI / 2),ctx.currentTime,.01);
  el('cross-caption').textContent = 'A ' + Math.round((1-x)*100) + '% : B ' + Math.round(x*100) + '%';
  el('crossfader').value = String(Math.round(x*100));
  el('crossfader-mobile').value = String(Math.round(x*100));
  el('mini-cross-value').textContent = 'A ' + Math.round((1-x)*100) + ' : B ' + Math.round(x*100);
  noteCrossfaderMove(x);
}
function applyKnob(deck, key, value) {
  switch (key) {
    case 'trim': deck.trimGain.gain.setTargetAtTime(Math.pow(10,value/20),ctx.currentTime,.01); break;
    case 'hi': deck.high.gain.setTargetAtTime(value,ctx.currentTime,.01); break;
    case 'mid': deck.mid.gain.setTargetAtTime(value,ctx.currentTime,.01); break;
    case 'low': deck.low.gain.setTargetAtTime(value,ctx.currentTime,.01); break;
    case 'filter': {
      if (value < -2) {
        deck.filter.type = 'lowpass';
        deck.filter.frequency.setTargetAtTime(19000 * Math.pow(200/19000, Math.abs(value)/100),ctx.currentTime,.012);
      } else if (value > 2) {
        deck.filter.type = 'highpass';
        deck.filter.frequency.setTargetAtTime(20 * Math.pow(6500/20, Math.abs(value)/100),ctx.currentTime,.012);
      } else {
        deck.filter.type = 'lowpass';
        deck.filter.frequency.setTargetAtTime(19000,ctx.currentTime,.012);
      }
      break;
    }
  }
}
function wireKnobs() {
  document.querySelectorAll('.knob-control').forEach(wrap => {
    const face = wrap.querySelector('.knob');
    const low = Number(wrap.dataset.min), high = Number(wrap.dataset.max);
    const step = Number(wrap.dataset.step);
    const initial = Number(wrap.dataset.default);
    const deck = decks[wrap.dataset.deck];
    let value = initial;
    const set = next => {
      value = clamp(Math.round(Number(next)/step)*step,low,high);
      const degree = -135 + (value-low)/(high-low)*270;
      face.style.setProperty('--angle',degree+'deg');
      face.setAttribute('aria-valuemin',String(low));
      face.setAttribute('aria-valuemax',String(high));
      face.setAttribute('aria-valuenow',String(value));
      face.title = wrap.dataset.param.toUpperCase() + ': ' + value + (wrap.dataset.param==='filter'?'':' dB') + ' · 더블클릭: 초기화';
      applyKnob(deck,wrap.dataset.param,value);
    };
    let drag = null;
    face.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      face.setPointerCapture(e.pointerId);
      if(drag)return;
      drag = {y:e.clientY, value, pointer:e.pointerId};
    });
    face.addEventListener('pointermove', e => {
      if (!drag || drag.pointer!==e.pointerId) return;
      set(drag.value + (drag.y - e.clientY) * (high-low) / 160);
    });
    const done = e => {if(drag?.pointer===e.pointerId)drag=null;};
    face.addEventListener('pointerup',done);
    face.addEventListener('pointercancel',done);
    face.addEventListener('lostpointercapture',done);
    face.addEventListener('dblclick',()=>set(initial));
    face.addEventListener('keydown',e => {
      const delta = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? step : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -step : 0;
      if (e.key === 'Home') {e.preventDefault();set(low);}
      if (e.key === 'End') {e.preventDefault();set(high);}
      if (delta) {e.preventDefault();set(value+delta);}
    });
    set(initial);
  });
}
function wireJog(deck) {
  const jog=el('jog-'+deck.id);
  let motion=null;
  const angle = event => {
    const r=jog.getBoundingClientRect();
    return Math.atan2(event.clientY-r.top-r.height/2,event.clientX-r.left-r.width/2);
  };
  jog.addEventListener('pointerdown',e=>{
    if (!deck.buffer || motion || (e.pointerType==='mouse' && e.button!==0))return;
    e.preventDefault();
    jog.setPointerCapture(e.pointerId);
    motion={pointer:e.pointerId,old:angle(e)};
    if(deck.scratchVinyl)void deck.beginScratch();
  });
  jog.addEventListener('pointermove',e=>{
    if(!motion||e.pointerId!==motion.pointer||!deck.buffer)return;
    const next=angle(e);let delta=next-motion.old;
    if(delta>Math.PI)delta-=Math.PI*2;
    if(delta< -Math.PI)delta+=Math.PI*2;
    if(Math.abs(delta)>.0015){
      if(deck.scratchVinyl){deck.moveScratch(delta);noteScratchMovement(deck.id,delta);}
      else deck.seek(deck.position+delta/(Math.PI*2)*2.5);
    }
    motion.old=next;
  });
  const finish=e=>{
    if(!motion || e.pointerId!==motion.pointer)return;
    motion=null;
    if(deck.scratchVinyl)deck.endScratch();
    noteScratchEnd(deck.id);
  };
  jog.addEventListener('pointerup',finish);
  jog.addEventListener('pointercancel',finish);
  jog.addEventListener('lostpointercapture',finish);
  jog.addEventListener('keydown',e=>{
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
      e.preventDefault();
      if(deck.scratchVinyl){void deck.beginScratch();deck.moveScratch(e.key==='ArrowRight'?.16:-.16);noteScratchMovement(deck.id,e.key==='ArrowRight'?.16:-.16);setTimeout(()=>deck.endScratch(),120);}
      else deck.seek(deck.position+(e.key==='ArrowRight'?1:-1));
    }
  });
  const modeButton=el('vinyl-'+deck.id);
  modeButton.addEventListener('click',()=>{
    if(deck.scratching)deck.endScratch();
    deck.scratchVinyl=!deck.scratchVinyl;
    modeButton.setAttribute('aria-pressed',String(deck.scratchVinyl));
    modeButton.textContent=deck.scratchVinyl?'● VINYL ON':'○ SEEK MODE';
    el('scratch-status-'+deck.id).textContent=deck.scratchVinyl?'위쪽을 잡고 앞뒤로 스크래치':'조그로 트랙 위치 탐색';
    notice(deck.scratchVinyl?'VINYL 모드: 손가락 이동에 따라 앞뒤로 소리 재생':'SEEK 모드: 조그로 곡 위치 탐색');
  });
}
function generateDemo(bpm, variant) {
  const sampleRate=44100;
  const duration=16*60/bpm;
  const length=Math.round(duration*sampleRate);
  const buffer=ctx.createBuffer(2,length,sampleRate);
  const left=buffer.getChannelData(0);
  const right=buffer.getChannelData(1);
  let seed=variant==='a'?13579:24680;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const add = (at, maxSeconds, fn, pan=0) => {
    const start=Math.round(at*sampleRate);
    const size=Math.min(Math.floor(maxSeconds*sampleRate),length-start);
    for(let i=0;i<size;i++) {
      const v=fn(i/sampleRate,i);
      left[start+i]+=v*(pan>0?1-pan*.35:1);
      right[start+i]+=v*(pan<0?1+pan*.35:1);
    }
  };
  const beat=60/bpm;
  for(let i=0;i<16;i++) {
    const t=i*beat;
    if (i%4===0 || i%4===2) {
      add(t,.32,(s)=>{
        const phase=2*Math.PI*(54*s+85*(1-Math.exp(-s*35))/35);
        return .78*Math.sin(phase)*Math.exp(-s*18);
      });
    }
    if(i%4===1 || i%4===3) {
      add(t,.2,s=>((rand()-.5)*.4+Math.sin(s*2*Math.PI*188)*.10)*Math.exp(-s*27));
    }
    for(let h=0;h<2;h++) {
      add(t+h*beat/2,.10,s=>(rand()-.5)*.22*Math.exp(-s*48),h===0?-.15:.15);
    }
    if(variant==='b' || i%2===0) {
      const notes=variant==='a'?[55,55,65.4,73.42]:[65.4,73.42,82.41,73.42];
      const freq=notes[Math.floor(i/4)%4];
      add(t,.42,s=>(Math.sin(2*Math.PI*freq*s)+.23*Math.sin(2*Math.PI*freq*2*s))*.22*Math.exp(-s*5),variant==='a'?.14:-.14);
    }
  }
  for(let i=0;i<length;i++) {left[i]=Math.tanh(left[i]*1.15);right[i]=Math.tanh(right[i]*1.15);}
  return buffer;
}
function wireDeck(deck) {
  const id=deck.id;
  const input=el('file-'+id);
  input.addEventListener('change',async e=>{
    const file=e.target.files && e.target.files[0];
    if (!file) return;
    const ticket=++deck.generation;
    notice('DECK '+id.toUpperCase()+' 음원 분석 중: '+file.name);
    try {
      const raw=await file.arrayBuffer();
      const decoded=await ctx.decodeAudioData(raw);
      if(ticket!==deck.generation) return;
      deck.setBuffer(decoded,file.name,120,false);
      el('bpm-source-'+id).textContent = 'ANALYZING';
      // Yield so the load status appears before the local analysis starts.
      await new Promise(resolve=>setTimeout(resolve,30));
      if (ticket !== deck.generation) return;
      const result = window.FoldTempoAnalyzer?.detect(decoded);
      if (ticket !== deck.generation) return;
      if (result) {
        deck.bpm = result.bpm;
        deck.beatOffset = result.offset;
        deck.bpmEstimated = true;
        el('bpm-'+id).value = number(result.bpm);
        el('bpm-source-'+id).textContent = 'AUTO EST.';
        notice('DECK '+id.toUpperCase()+' BPM 추정 '+number(result.bpm)+' · 틀리면 BPM 직접 수정 또는 TAP 4회 이상 입력');
      } else {
        deck.bpmEstimated = false;
        el('bpm-source-'+id).textContent = 'MANUAL / TAP';
        notice('BPM 분석이 불확실합니다. 원곡 BPM을 입력하거나 TAP을 4회 이상 누르세요.');
      }
      renderControls(deck);
    } catch(error) {
      notice('음원 파일을 열 수 없습니다. MP3/WAV 등 지원 형식을 사용하세요: '+error.message);
    } finally { input.value=''; }
  });
  el('play-'+id).addEventListener('click',()=>void deck.toggle());
  const cueButton=el('cue-'+id);
  cueButton.addEventListener('pointerdown', e=>{
    if(e.pointerType==='mouse' && e.button!==0)return;
    e.preventDefault();
    cueButton.setPointerCapture(e.pointerId);
    deck.pressCue();
  });
  cueButton.addEventListener('pointerup',()=>deck.releaseCue());
  cueButton.addEventListener('pointercancel',()=>deck.releaseCue());
  cueButton.addEventListener('lostpointercapture',()=>deck.releaseCue());
  cueButton.addEventListener('click',e=>{
    if(e.detail===0) { deck.pressCue(); deck.releaseCue(); }
  });
  el('bpm-'+id).addEventListener('change',e=>{
    deck.bpm=clamp(Math.round((Number(e.target.value)||120)*10)/10,50,220);
    deck.bpmEstimated = false;
    deck.beatOffset = 0;
    el('bpm-source-'+id).textContent = 'MANUAL';
    e.target.value=String(deck.bpm);
    if(deck.loopBeats) deck.setLoop(0);
    renderControls(deck);
    notice('DECK '+id.toUpperCase()+' BPM을 '+deck.bpm+'으로 수동 보정했습니다.');
  });
  el('pitch-'+id).addEventListener('input',e=>deck.setPitch(e.target.value));
  el('pitch-reset-'+id).addEventListener('click',()=>deck.setPitch(0));
  el('level-'+id).addEventListener('input',e=>deck.channelGain.gain.setTargetAtTime(Number(e.target.value)/100,ctx.currentTime,.012));
  el('tap-'+id).addEventListener('click',()=>{
    const now = performance.now();
    deck.taps = deck.taps.filter(t => now - t < 3800);
    if (deck.taps.length && now - deck.taps.at(-1) > 2100) deck.taps = [];
    deck.taps.push(now);
    if(deck.taps.length < 4) {notice('DECK '+id.toUpperCase()+' TAP BPM: '+deck.taps.length+' / 4회 이상 박자에 맞춰 누르세요.');return;}
    const intervals = [];
    for (let i=1; i<deck.taps.length; i++) intervals.push(deck.taps[i]-deck.taps[i-1]);
    intervals.sort((a,b)=>a-b);
    const interval=intervals[Math.floor(intervals.length/2)];
    if(!interval)return;
    deck.bpm=clamp(Math.round((60000/interval)*10)/10,50,220);
    deck.bpmEstimated = false;
    deck.beatOffset = (deck.position % (60/deck.bpm));
    el('bpm-'+id).value=String(deck.bpm);
    el('bpm-source-'+id).textContent='TAP';
    if(deck.loopBeats)deck.setLoop(0);
    renderControls(deck);
    notice('DECK '+id.toUpperCase()+' TAP BPM '+number(deck.bpm)+' 설정 완료');
  });
  el('sync-'+id).addEventListener('click',()=>{
    if(!deck.buffer) {notice('DECK '+id.toUpperCase()+' 음원을 먼저 선택하세요.');return;}
    const other=decks[id==='a'?'b':'a'];
    if(!other.buffer) {notice('SYNC: 양쪽 데크에 음원을 불러오세요.');return;}
    const target=other.bpm*other.rate;
    const pct=(target/deck.bpm-1)*100;
    if(!Number.isFinite(pct)||pct < -25 || pct > 25) {
      notice('SYNC 불가: BPM 차이가 ±25%를 넘습니다. 실제 BPM 또는 하프/더블타임 값을 확인하세요.');return;
    }
    deck.setPitch(pct);
    let aligned = false;
    if(deck.playing && other.playing) {
      const beatSeconds=60/target;
      const mod = (x,m)=>((x%m)+m)%m;
      const otherPhase=mod(other.position-other.beatOffset,beatSeconds);
      const deckPhase=mod(deck.position-deck.beatOffset,beatSeconds);
      let delta=otherPhase-deckPhase;
      if(delta>beatSeconds/2)delta-=beatSeconds;
      if(delta< -beatSeconds/2)delta+=beatSeconds;
      const at=clamp(deck.position+delta,0,deck.buffer.duration-.02);
      deck.seek(at);
      aligned=true;
    }
    renderControls(deck);
    notice('DECK '+id.toUpperCase()+' '+number(target)+' BPM 동기화'+(aligned?' · 추정 비트그리드 위상 맞춤':' · 박자 위치는 두 데크 재생 중에 다시 SYNC하세요.')+' (키락 미지원)');
  });
  el('wave-'+id).addEventListener('pointerdown',e=>{
    if(!deck.buffer)return;
    const r=e.currentTarget.getBoundingClientRect();
    deck.seek(deck.buffer.duration*clamp((e.clientX-r.left)/r.width,0,1));
  });
  el('wave-'+id).addEventListener('keydown',e=>{
    if(e.key==='ArrowLeft'||e.key==='ArrowRight') {e.preventDefault();deck.seek(deck.position+(e.key==='ArrowRight'?5:-5));}
  });
  const player=el('deck-'+id);
  player.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();player.classList.add('is-dragover');}});
  player.addEventListener('dragleave',()=>player.classList.remove('is-dragover'));
  player.addEventListener('drop',e=>{e.preventDefault();player.classList.remove('is-dragover');const f=e.dataTransfer?.files?.[0];if(f){const dt=new DataTransfer();dt.items.add(f);input.files=dt.files;input.dispatchEvent(new Event('change'));}});
  document.querySelectorAll('[data-loop][data-deck="'+id+'"]').forEach(button=>button.addEventListener('click',()=>deck.setLoop(Number(button.dataset.loop))));
  document.querySelectorAll('.pad-modes button[data-deck="'+id+'"]').forEach(button=>button.addEventListener('click',()=>{
    deck.stopRoll();
    deck.padMode=button.dataset.padMode;
    renderPads(deck);
  }));
  el('sample-assign-'+id).addEventListener('click',()=>{
    deck.waitingSample=true;
    notice('DECK '+id.toUpperCase()+': 교체할 샘플 패드(1~8)를 누르세요.');
  });
  const sampleInput=el('sample-file-'+id);
  sampleInput.addEventListener('change',async e=>{
    const file=e.target.files?.[0],index=deck.pendingSample;
    if(!file||!Number.isInteger(index))return;
    try {
      const raw=await file.arrayBuffer();
      const pcm=await ctx.decodeAudioData(raw);
      deck.samples[index]=pcm;
      if(!deck.sampleLabels)deck.sampleLabels={};
      deck.sampleLabels[index]=file.name.length>10?file.name.slice(0,9)+'…':file.name;
      renderPads(deck);
      notice('DECK '+id.toUpperCase()+' 샘플 '+(index+1)+' 교체 완료: '+file.name);
    }catch(error){notice('샘플 파일을 열지 못했습니다: '+error.message);}
    finally{sampleInput.value='';deck.pendingSample=null;}
  });
  document.querySelectorAll('.hotpad[data-deck="'+id+'"]').forEach(button=>{
    const index=Number(button.dataset.pad);
    let pointer=null,longTimer=null,longDone=false,pressedMode=null;
    const release=()=>{
      if(pointer===null)return;
      if(longTimer!==null){clearTimeout(longTimer);longTimer=null;}
      const mode=pressedMode;
      if(mode==='roll')deck.stopRoll();
      if(mode==='hot'&&!longDone)deck.hotAction(index);
      button.classList.remove('is-pressed');
      pointer=null;pressedMode=null;
    };
    button.addEventListener('pointerdown',e=>{
      if(e.pointerType==='mouse'&&e.button!==0)return;
      e.preventDefault();
      if(pointer!==null)return;
      button.setPointerCapture(e.pointerId);
      pointer=e.pointerId;longDone=false;pressedMode=deck.padMode;
      button.classList.add('is-pressed');
      void ctx.resume();
      if(deck.padMode==='hot'){
        longTimer=setTimeout(()=>{longDone=true;deck.clearHot(index);},700);
      }else if(deck.padMode==='sampler'){
        if(deck.waitingSample){
          deck.waitingSample=false;
          deck.pendingSample=index;
          sampleInput.click();
        }else deck.playSample(index);
      }else if(deck.padMode==='roll')deck.startRoll(rollBeats[index]);
      else if(deck.padMode==='jump')deck.beatJump(beatJumps[index]);
    });
    button.addEventListener('pointerup',e=>{if(e.pointerId===pointer)release();});
    button.addEventListener('pointercancel',e=>{if(e.pointerId===pointer){longDone=true;release();}});
    button.addEventListener('lostpointercapture',e=>{if(e.pointerId===pointer){longDone=true;release();}});
    button.addEventListener('click',e=>{
      if(e.detail!==0)return; // keyboard action only, pointer input is processed by pointer events
      if(deck.padMode==='hot')deck.hotAction(index);
      else if(deck.padMode==='sampler')deck.playSample(index);
      else if(deck.padMode==='jump')deck.beatJump(beatJumps[index]);
      else {deck.startRoll(rollBeats[index]);setTimeout(()=>deck.stopRoll(),220);}
    });
    button.addEventListener('contextmenu',e=>{e.preventDefault();if(deck.padMode==='hot')deck.clearHot(index);});
  });
  // Independent channel Beat FX: send, effect, feedback and wet/dry mixing.
  const fxButton=el('fx-on-'+id),fxKind=el('fx-type-'+id),fxTime=el('fx-time-'+id),fxMix=el('fx-mix-'+id);
  fxButton.addEventListener('click',()=>{
    deck.fxActive=!deck.fxActive;
    deck.fxSend.gain.setTargetAtTime(deck.fxActive?1:0,ctx.currentTime,.015);
    fxButton.setAttribute('aria-pressed',String(deck.fxActive));
    fxButton.textContent=deck.fxActive?'FX ON':'FX OFF';
  });
  fxKind.addEventListener('change',()=>{deck.fxType=fxKind.value;deck.buildEffect();notice('DECK '+id.toUpperCase()+' FX: '+fxKind.options[fxKind.selectedIndex].text);});
  fxTime.addEventListener('change',()=>{deck.fxTime=Number(fxTime.value);deck.refreshEffectTime();});
  fxMix.addEventListener('input',()=>{deck.fxMix=Number(fxMix.value)/100;deck.fxWet.gain.setTargetAtTime(deck.fxMix,ctx.currentTime,.01);});
  wireJog(deck);
  renderControls(deck);
}
function wireRecord() {
  const button=el('record');
  let mediaRecorder=null,recorded=[];
  button.addEventListener('click',async()=>{
    if(mediaRecorder && mediaRecorder.state==='recording') {mediaRecorder.stop();return;}
    if(!window.MediaRecorder) {notice('이 브라우저에서는 녹음 기능을 지원하지 않습니다.');return;}
    try {
      await ctx.resume();
      const options={};
      if(MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) options.mimeType='audio/webm;codecs=opus';
      mediaRecorder=new MediaRecorder(recordDestination.stream,options);
      recorded=[];
      mediaRecorder.addEventListener('dataavailable',e=>{if(e.data.size)recorded.push(e.data);});
      mediaRecorder.addEventListener('stop',()=>{
        button.classList.remove('is-recording');button.innerHTML='<span class="record-dot"></span> REC MIX';
        if(!recorded.length)return;
        const blob=new Blob(recorded,{type:mediaRecorder.mimeType||'audio/webm'});
        const url=URL.createObjectURL(blob);
        const link=document.createElement('a');link.href=url;
        link.download='foldmix-recording-'+new Date().toISOString().replaceAll(':','-')+'.webm';
        document.body.appendChild(link);link.click();link.remove();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
        notice('믹스 녹음 파일을 다운로드했습니다 (WebM).');
      });
      mediaRecorder.start(250);
      button.classList.add('is-recording');button.innerHTML='<span class="record-dot"></span> STOP REC';
      notice('믹스 녹음 중 · 종료하려면 STOP REC 버튼을 누르세요.');
    }catch(error){notice('녹음을 시작하지 못했습니다: '+error.message);}
  });
}
function animate() {
  let previous=0;
  const masterData=new Float32Array(masterAnalyser.fftSize);
  const frame=stamp=>{
    if (stamp-previous>70) {
      previous=stamp;
      Object.values(decks).forEach(deck=>{
        updateTime(deck);drawWave(deck);
        setMeter('vu-'+deck.id,dbToMeter(meterDb(deck.analyser,deck.meterData)));
      });
      const masterDb=meterDb(masterAnalyser,masterData);
      setMeter('master-meter',dbToMeter(masterDb));
      el('master-db').textContent=Number.isFinite(masterDb)?number(masterDb)+' dB':'−∞ dB';
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
// Guided scratch practice. Counts gestures from the real touch controls, not a fake animation.
const lessons=[
 {title:'01 · Baby Scratch',help:'조그휠을 앞으로 밀고, 같은 위치까지 뒤로 당겨 보세요. 음악을 앞뒤로 문지르는 가장 기본적인 연습입니다.',tip:'VINYL ON · 왼쪽 DECK A에서 앞→뒤 방향 전환 4회',goal:4},
 {title:'02 · Forward Scratch',help:'조그를 앞으로 밀어 소리를 내고, 뒤로 돌아올 때 크로스페이더를 B 쪽으로 닫아 보세요.',tip:'앞쪽 스트로크를 3회 연습하세요. 되감는 동안 소리를 닫으면 더 정확합니다.',goal:3},
 {title:'03 · Transformer Scratch',help:'조그를 움직이는 동안 크로스페이더를 A와 B 사이로 빠르게 이동해 소리를 짧게 끊으세요.',tip:'한 손은 조그, 다른 손은 크로스페이더 · 멀티터치 4회',goal:4},
 {title:'04 · Chirp Scratch',help:'앞으로 밀 때 크로스페이더를 열고, 뒤로 당길 때 닫아 짧고 날카로운 소리를 만드세요.',tip:'앞뒤 방향 전환과 페이더 조작을 조합해 4회 연습합니다.',goal:4}
];
const training={active:false,step:0,count:0,lastDirection:0,arc:0,strokes:0,forwardActive:false,xfaderSide:null,lastDirectionChange:0};
function showLesson(){
 const step=lessons[training.step];
 el('lesson-title').textContent=step.title;
 el('lesson-help').textContent=step.help;
 el('lesson-tip').textContent=step.tip;
 el('lesson-number').textContent=(training.step+1)+' / '+lessons.length;
 el('lesson-count').textContent=training.count+' / '+step.goal;
 el('lesson-bar').style.width=(100*Math.min(1,training.count/step.goal))+'%';
 el('lesson-feedback').textContent=training.count>=step.goal?'완료! 다음 단계로 진행할 수 있습니다.':'조그와 크로스페이더를 직접 움직이면 기록됩니다.';
 el('lesson-prev').disabled=training.step===0;
 el('lesson-next').textContent=training.step===lessons.length-1?'처음으로 ↺':'다음 단계 →';
}
function resetLesson(){training.count=0;training.lastDirection=0;training.arc=0;training.forwardActive=false;training.xfaderSide=null;showLesson();}
function addPractice(count=1){
 if(!training.active)return;
 const max=lessons[training.step].goal;
 training.count=Math.min(max,training.count+count);
 showLesson();
}
function noteScratchMovement(id,angle){
 if(!training.active||id!=='a'||Math.abs(angle)<.008)return;
 const sign=Math.sign(angle);
 if(sign!==training.lastDirection){
   if(training.arc>.13){
     if(training.step===0)addPractice();
     else if(training.step===1 && training.lastDirection>0)addPractice();
     else if(training.step===3&&training.xfaderSide!==null)addPractice();
   }
   training.lastDirection=sign;training.arc=0;
 }
 training.arc+=Math.abs(angle);
}
function noteScratchEnd(id){
 if(!training.active||id!=='a')return;
 if(training.step===1&&training.lastDirection>0&&training.arc>.15)addPractice();
 training.lastDirection=0;training.arc=0;
}
function noteCrossfaderMove(value){
 if(!training.active||!(decks?.a?.scratching))return;
 if(training.step!==2&&training.step!==3)return;
 const side=value<.28?'a':value>.72?'b':null;
 if(side&&side!==training.xfaderSide){
   if(training.xfaderSide!==null)addPractice();
   training.xfaderSide=side;
 }
}
function wireTutorial(){
 const panel=el('training');
 const open=()=>{
   training.active=true;panel.hidden=false;
   el('open-tutorial').setAttribute('aria-expanded','true');
   el('lesson-title').scrollIntoView({block:'nearest',behavior:'smooth'});
   resetLesson();
   notice('스크래치 연습실 시작 · DECK A에서 VINYL ON으로 연습하세요.');
 };
 const close=()=>{training.active=false;panel.hidden=true;el('open-tutorial').setAttribute('aria-expanded','false');};
 el('open-tutorial').addEventListener('click',()=>training.active?close():open());
 el('lesson-close').addEventListener('click',close);
 el('lesson-demo').addEventListener('click',()=>{
   const deck=decks.a;
   ++deck.generation;
   deck.setBuffer(generateDemo(122,'a'),'SCRATCH PRACTICE BEAT',122,true);
   deck.scratchVinyl=true;
   el('vinyl-a').setAttribute('aria-pressed','true');el('vinyl-a').textContent='● VINYL ON';
   el('scratch-status-a').textContent='위쪽을 잡고 앞뒤로 스크래치';
   setCrossfader(0);
   notice('연습 비트가 DECK A에 준비되었습니다. PLAY 또는 조그 터치로 시작하세요.');
 });
 el('lesson-prev').addEventListener('click',()=>{training.step=Math.max(0,training.step-1);resetLesson();});
 el('lesson-next').addEventListener('click',()=>{training.step=(training.step+1)%lessons.length;resetLesson();});
 showLesson();
}
initMeters();
wireKnobs();
Object.values(decks).forEach(wireDeck);
setCrossfader(50);
el('crossfader').addEventListener('input',e=>setCrossfader(e.target.value));
el('crossfader-mobile').addEventListener('input',e=>setCrossfader(e.target.value));
document.querySelectorAll('.mobile-tabs button').forEach(button=>button.addEventListener('click',()=>{
  const view = button.dataset.view;
  document.querySelector('.console').dataset.view = view;
  document.querySelectorAll('.mobile-tabs button').forEach(b => b.classList.toggle('selected', b.dataset.view === view));
  if(view!=='mixer')requestAnimationFrame(()=>drawWave(decks[view]));
}));
document.querySelectorAll('[data-demo]').forEach(button=>button.addEventListener('click',()=>{
  const id=button.dataset.demo;
  const deck=decks[id];
  ++deck.generation;
  const bpm=id==='a'?122:126;
  deck.setBuffer(generateDemo(bpm,id),id==='a'?'BLUE CIRCUIT / DEMO':'SUNSET MOTION / DEMO',bpm,true);
  notice('DECK '+id.toUpperCase()+' 내장 테스트 비트 로딩 완료 · PLAY를 누르세요.');
}));
el('stop-all').addEventListener('click',()=>{Object.values(decks).forEach(d=>d.stop());notice('전체 재생을 정지했습니다.');});
el('fullscreen').addEventListener('click',async()=>{
  try {
    if(document.fullscreenElement) await document.exitFullscreen();
    else if(document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else notice('이 브라우저에서는 전체 화면을 지원하지 않습니다.');
  }catch(error){notice('전체 화면을 시작할 수 없습니다: '+error.message);}
});
wireRecord();
wireTutorial();
animate();
