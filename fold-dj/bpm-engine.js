/* FOLD//MIX tempo estimation. Local analysis only; no remote requests.
 * Detects a likely beat interval from onset-envelope autocorrelation.
 * Estimates are heuristic: tempos with half/double-time ambiguity need TAP/manual correction.
 */
(function (root) {
  'use strict';
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const positiveMod = (v, m) => ((v % m) + m) % m;

  function detect(buffer) {
    if (!buffer || !buffer.length || !buffer.sampleRate) return null;
    const fps = 100;
    const hop = Math.max(1, Math.floor(buffer.sampleRate / fps));
    const start = Math.min(Math.round(2.0 * buffer.sampleRate), Math.floor(buffer.length * 0.06));
    const end = Math.min(buffer.length, start + Math.round(95 * buffer.sampleRate));
    const n = Math.floor((end - start) / hop);
    if (n < fps * 8) return null;
    const pcm = buffer.getChannelData(0);
    const onset = new Float32Array(n);
    const lowEnergy = new Float32Array(n);
    const fullEnergy = new Float32Array(n);
    let low = 0;
    const stride = 4;
    const alpha = Math.min(.28, 2 * Math.PI * 190 * stride / buffer.sampleRate);
    for (let i = 0; i < n; i++) {
      const base = start + i * hop;
      let l = 0, e = 0, count = 0;
      for (let j = 0; j < hop; j += stride) {
        const v = pcm[base + j] || 0;
        low += alpha * (v - low);
        l += low * low;
        e += v * v;
        count++;
      }
      lowEnergy[i] = Math.log(1e-7 + l / count);
      fullEnergy[i] = Math.log(1e-7 + e / count);
    }
    let average = 0;
    for (let i = 2; i < n; i++) {
      const kick = Math.max(0, lowEnergy[i] - lowEnergy[i - 2]);
      const full = Math.max(0, fullEnergy[i] - fullEnergy[i - 2]);
      const v = Math.min(4, kick * .7 + full * .3);
      onset[i] = v;
      average += v;
    }
    average /= n;
    if (average < .012) return null;
    // Remove the background fluctuations to retain only rhythmic attacks.
    for (let i = 0; i < n; i++) onset[i] = Math.max(0, onset[i] - average * .55);

    const corr = lag => {
      const gap = Math.round(lag);
      if (gap < 1 || gap >= n / 3) return 0;
      let cross = 0, energy = 0;
      for (let i = 0; i + gap < n; i += 2) {
        cross += onset[i] * onset[i + gap];
        energy += onset[i] * onset[i];
      }
      return energy ? cross / energy : 0;
    };
    let best = null;
    const candidates = [];
    for (let bpm = 70; bpm <= 180; bpm += .25) {
      const lag = 60 * fps / bpm;
      const first = corr(lag);
      const second = corr(lag * 2);
      const third = corr(lag * 4);
      const accent = Math.exp(-Math.pow((bpm - 119) / 70, 2)) * .017;
      const score = first + .48 * second + .12 * third + accent;
      candidates.push(score);
      if (!best || score > best.score) best = { bpm, score, lag };
    }
    const sorted = [...candidates].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    if (!best || best.score < median * 1.11 || best.score < .07) return null;

    // The repeating attack pattern gives a beat-grid phase, not necessarily the first downbeat.
    const interval = 60 * fps / best.bpm;
    let bestPhase = 0, phaseScore = -1;
    const phaseSteps = Math.max(1, Math.round(interval));
    for (let phase = 0; phase < phaseSteps; phase++) {
      let sum = 0, count = 0;
      for (let at = phase; at < n; at += interval) {
        const idx = Math.round(at);
        sum += (onset[idx] || 0) + (onset[idx - 1] || 0) * .3 + (onset[idx + 1] || 0) * .3;
        count++;
      }
      const score = count ? sum / count : 0;
      if (score > phaseScore) { bestPhase = phase; phaseScore = score; }
    }
    const beatPeriod = 60 / best.bpm;
    const phaseTime = (start / buffer.sampleRate + bestPhase / fps) % beatPeriod;
    return {
      bpm: Math.round(best.bpm * 10) / 10,
      offset: positiveMod(phaseTime, beatPeriod),
      confidence: clamp(best.score / (median || .001) - 1, 0, 1),
      note: '추정 BPM: 변박·약한 킥·하프타임 곡은 수동 보정이 필요합니다.'
    };
  }
  const api = { detect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FoldTempoAnalyzer = api;
})(typeof window !== 'undefined' ? window : undefined);
