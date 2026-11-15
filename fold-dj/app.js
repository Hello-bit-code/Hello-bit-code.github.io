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
    this.cue = 0;
    this.hot = [null, null, null, null];
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
    this.channelGain = ctx.createGain(); this.channelGain.gain.value = .86;
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512;
    this.crossGain = ctx.createGain(); this.crossGain.gain.value = Math.SQRT1_2;
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.filter);
    this.filter.connect(this.trimGain);
    this.trimGain.connect(this.channelGain);
    this.channelGain.connect(this.analyser);
    this.analyser.connect(this.crossGain);
    this.crossGain.connect(compressor);
    this.meterData = new Float32Array(this.analyser.fftSize);
  }
  get position() {
    if (!this.buffer) return 0;
    let value = this.playing ? this.offset + (ctx.currentTime - this.startedAt) * this.rate : this.offset;
    if (this.loopBeats > 0 && value >= this.loopOut) {
      const len = this.loopOut - this.loopIn;
      if (len > .01) value = this.loopIn + ((value - this.loopIn) % len);
    } else if (this.demoRepeat && this.loopBeats === 0) {
      value %= this.buffer.duration;
    }
    return clamp(value, 0, this.buffer.duration);
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
    const next = clamp(Number(percent) || 0, -12, 12);
    if (this.playing) {
      this.offset = this.position;
      this.startedAt = ctx.currentTime;
    }
    this.tempo = next;
    this.rate = 1 + next / 100;
    if (this.source) this.source.playbackRate.setValueAtTime(this.rate, ctx.currentTime);
    el('pitch-' + this.id).value = String(next);
    renderControls(this);
  }
  cueAction() {
    if (!this.buffer) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cue);
      notice('DECK ' + this.id.toUpperCase() + ' CUE 지점으로 이동');
    } else {
      this.cue = this.position;
      notice('DECK ' + this.id.toUpperCase() + ' CUE 저장: ' + timeLabel(this.cue));
    }
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
    this.pause();
    this.stopSource();
    this.buffer = audioBuffer;
    this.offset = 0;
    this.bpm = bpm;
    this.demoRepeat = Boolean(repeat);
    this.cue = 0;
    this.hot = [null, null, null, null];
    this.loopBeats = 0;
    this.loopIn = 0;
    this.loopOut = 0;
    this.peaks = computePeaks(audioBuffer);
    el('track-' + this.id).textContent = title;
    el('bpm-' + this.id).value = String(bpm);
    this.setPitch(0);
    renderControls(this);
    drawWave(this);
  }
}
const decks = {a:new Deck('a'), b:new Deck('b')};
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
  el('jog-state-' + id).textContent = !deck.buffer ? 'READY' : played ? 'PLAY' : 'CUE';
  el('pitch-display-' + id).textContent = (deck.tempo > 0 ? '+' : '') + number(deck.tempo) + '%';
  el('pitch-value-' + id).textContent = (deck.tempo > 0 ? '+' : '') + number(deck.tempo) + '%';
  el('loop-indicator-' + id).textContent = deck.loopBeats ? 'LOOP ' + deck.loopBeats + ' BEATS' : deck.demoRepeat ? 'DEMO REPEAT' : 'LOOP OFF';
  document.querySelectorAll('[data-loop][data-deck="' + id + '"]').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.loop) > 0 && Number(button.dataset.loop) === deck.loopBeats);
  });
  document.querySelectorAll('.hotpad[data-deck="' + id + '"]').forEach(button => {
    const index = Number(button.dataset.pad);
    button.classList.toggle('is-set', deck.hot[index] !== null);
    button.title = deck.hot[index] === null ? '탭: HOT CUE 위치 저장' : '탭: 이동 / 길게 누르기: 삭제';
  });
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
  p.fillStyle = '#091621'; p.fillRect(0,0,w,h);
  p.strokeStyle = '#1b3340'; p.lineWidth = 1;
  for (let i = 0; i < 17; i++) { const x = Math.floor(i * w / 16) + .5; p.beginPath(); p.moveTo(x,0);p.lineTo(x,h);p.stroke(); }
  p.beginPath(); p.moveTo(0,h/2+.5);p.lineTo(w,h/2+.5);p.stroke();
  if (!deck.buffer) {
    p.fillStyle = '#4d6677'; p.font = 'bold 11px system-ui'; p.textAlign = 'center';
    p.fillText('LOAD TRACK   /   TAP DEMO', w/2, h/2+4);
    return;
  }
  const peaks = deck.peaks;
  const progress = deck.position / deck.buffer.duration;
  for (let i = 0; i < peaks.length; i++) {
    const x = i * w / peaks.length;
    const height = Math.max(2, peaks[i] * h * .44);
    const done = (i / peaks.length) <= progress;
    p.fillStyle = deck.id === 'a' ? (done ? '#5ccefe' : '#265e82') : (done ? '#ff9c53' : '#83502c');
    p.fillRect(x, h / 2 - height, Math.max(.8, w/peaks.length-.3), height*2);
  }
  if (deck.loopBeats) {
    const x = deck.loopIn / deck.buffer.duration * w;
    const end = deck.loopOut / deck.buffer.duration * w;
    p.fillStyle = '#e8b46824'; p.fillRect(x,0,end-x,h);
    p.strokeStyle = '#e7c37b'; p.beginPath();p.moveTo(x,0);p.lineTo(x,h);p.moveTo(end,0);p.lineTo(end,h);p.stroke();
  }
  for (let i = 0; i < deck.hot.length; i++) {
    const cue = deck.hot[i];
    if (cue === null) continue;
    const x = cue / deck.buffer.duration * w;
    p.fillStyle = '#ff6594'; p.fillRect(x,0,2,14);
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
      drag = {y:e.clientY, value};
    });
    face.addEventListener('pointermove', e => {
      if (!drag) return;
      set(drag.value + (drag.y - e.clientY) * (high-low) / 160);
    });
    const done = () => {drag=null;};
    face.addEventListener('pointerup',done);
    face.addEventListener('pointercancel',done);
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
  const jog = el('jog-'+deck.id);
  let motion = null;
  const angle = event => {
    const r = jog.getBoundingClientRect();
    return Math.atan2(event.clientY-r.top-r.height/2,event.clientX-r.left-r.width/2);
  };
  jog.addEventListener('pointerdown', e => {
    if (!deck.buffer || (e.pointerType==='mouse' && e.button!==0)) return;
    e.preventDefault();
    jog.setPointerCapture(e.pointerId);
    motion = {old:angle(e),wasPlaying:deck.playing};
    if (deck.playing) deck.pause();
  });
  jog.addEventListener('pointermove', e => {
    if (!motion || !deck.buffer) return;
    const next = angle(e);
    let delta = next-motion.old;
    if (delta>Math.PI) delta-=Math.PI*2;
    if (delta<-Math.PI) delta+=Math.PI*2;
    deck.seek(deck.position + delta/(Math.PI*2)*3.5);
    motion.old=next;
  });
  const finish = () => {
    if (!motion) return;
    const wasPlaying=motion.wasPlaying;
    motion=null;
    if (wasPlaying) void deck.play();
  };
  jog.addEventListener('pointerup',finish);
  jog.addEventListener('pointercancel',finish);
  jog.addEventListener('keydown', e => {
    if (e.key==='ArrowLeft'||e.key==='ArrowRight') {
      e.preventDefault();deck.seek(deck.position+(e.key==='ArrowRight'?1:-1));
    }
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
      notice('DECK '+id.toUpperCase()+' 로딩 완료 · BPM은 실제 곡에 맞게 수동 입력하세요.');
    } catch(error) {
      notice('음원 파일을 열 수 없습니다. MP3/WAV 등 지원 형식을 사용하세요: '+error.message);
    } finally { input.value=''; }
  });
  el('play-'+id).addEventListener('click',()=>void deck.toggle());
  el('cue-'+id).addEventListener('click',()=>deck.cueAction());
  el('bpm-'+id).addEventListener('change',e=>{
    deck.bpm=clamp(Math.round(Number(e.target.value)||120),50,220);
    e.target.value=String(deck.bpm);
    if(deck.loopBeats) deck.setLoop(0);
    notice('DECK '+id.toUpperCase()+' 기본 BPM을 '+deck.bpm+'으로 설정했습니다.');
  });
  el('pitch-'+id).addEventListener('input',e=>deck.setPitch(e.target.value));
  el('pitch-reset-'+id).addEventListener('click',()=>deck.setPitch(0));
  el('level-'+id).addEventListener('input',e=>deck.channelGain.gain.setTargetAtTime(Number(e.target.value)/100,ctx.currentTime,.012));
  el('sync-'+id).addEventListener('click',()=>{
    if(!deck.buffer) return;
    const other=decks[id==='a'?'b':'a'];
    if(!other.buffer) {notice('BPM MATCH: 양쪽 데크에 모두 음원을 불러오세요.');return;}
    const target=other.bpm*other.rate;
    const pct=(target/deck.bpm-1)*100;
    if(pct < -12 || pct > 12) {
      notice('BPM MATCH 범위를 초과했습니다. 두 곡의 BPM을 확인하세요 (±12%).');return;
    }
    deck.setPitch(pct);
    notice('DECK '+id.toUpperCase()+' BPM을 '+number(target)+'에 맞췄습니다. 박자 위상은 자동 정렬되지 않습니다.');
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
  document.querySelectorAll('.hotpad[data-deck="'+id+'"]').forEach(button=>{
    const index=Number(button.dataset.pad);
    let pressTimer=null,held=false;
    button.addEventListener('pointerdown',()=>{held=false;pressTimer=setTimeout(()=>{held=true;deck.clearHot(index);},650);});
    const cancel=()=>{if(pressTimer!==null){clearTimeout(pressTimer);pressTimer=null;}};
    button.addEventListener('pointerup',cancel);
    button.addEventListener('pointercancel',cancel);
    button.addEventListener('pointerleave',cancel);
    button.addEventListener('click',()=>{if(!held)deck.hotAction(index);held=false;});
    button.addEventListener('contextmenu',e=>{e.preventDefault();cancel();held=true;deck.clearHot(index);});
  });
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
initMeters();
wireKnobs();
Object.values(decks).forEach(wireDeck);
setCrossfader(50);
el('crossfader').addEventListener('input',e=>setCrossfader(e.target.value));
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
animate();