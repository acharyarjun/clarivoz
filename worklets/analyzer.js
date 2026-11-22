/**
 * Clarivoz live analyzer. RMS, zero-crossing, a cheap 8-band flux, and YIN pitch
 * on a 16 kHz downsample. Posts one frame about every 20 ms.
 */
class ClarivozAnalyzer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.raw = [];
    this.noise = 0.004;
    this.prevBands = null;
    this.samplesSeen = 0;
    this.lastEmit = 0;
  }

  downsample(samples, fromRate) {
    const toRate = 16000;
    if (fromRate <= toRate + 50) return samples;
    const ratio = fromRate / toRate;
    const out = [];
    for (let i = 0; i < samples.length; i += ratio) {
      const start = Math.floor(i);
      const end = Math.min(samples.length, Math.floor(i + ratio));
      let acc = 0;
      let n = 0;
      for (let j = start; j < end; j++) {
        acc += samples[j];
        n++;
      }
      if (n) out.push(acc / n);
    }
    return out;
  }

  yin(samples, sampleRate) {
    const minHz = 70;
    const maxHz = 400;
    const n = samples.length;
    const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
    const tauMax = Math.min(n - 2, Math.floor(sampleRate / minHz));
    if (tauMax <= tauMin) return null;
    const diff = new Float64Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < n - tau; i += 1) {
        const d = samples[i] - samples[i + tau];
        sum += d * d;
      }
      diff[tau] = sum;
    }
    const cm = new Float64Array(tauMax + 1);
    cm[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += diff[tau];
      cm[tau] = running === 0 ? 1 : (diff[tau] * tau) / running;
    }
    let tau = tauMin;
    const threshold = 0.18;
    while (tau <= tauMax) {
      if (cm[tau] < threshold) {
        while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
        const hz = sampleRate / tau;
        return hz >= minHz && hz <= maxHz ? hz : null;
      }
      tau++;
    }
    return null;
  }

  bands(samples) {
    const mags = new Float32Array(8);
    const n = Math.min(256, samples.length);
    if (n < 32) return mags;
    const step = Math.max(1, Math.floor(samples.length / n));
    for (let k = 1; k <= 8; k++) {
      let re = 0;
      let im = 0;
      const w = (2 * Math.PI * k) / n;
      for (let i = 0; i < n; i++) {
        const s = samples[Math.min(samples.length - 1, i * step)];
        re += s * Math.cos(w * i);
        im -= s * Math.sin(w * i);
      }
      mags[k - 1] = Math.sqrt(re * re + im * im) / n;
    }
    return mags;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) this.raw.push(channel[i]);
    this.samplesSeen += channel.length;
    const hop = Math.round(sampleRate * 0.02);
    if (this.raw.length < hop) return true;
    if (this.samplesSeen - this.lastEmit < hop) return true;
    this.lastEmit = this.samplesSeen;

    const windowSamples = Math.round(sampleRate * 0.16);
    if (this.raw.length > windowSamples) this.raw.splice(0, this.raw.length - windowSamples);
    const recent = this.raw.slice(this.raw.length - hop);

    let energy = 0;
    let crosses = 0;
    for (let i = 0; i < recent.length; i++) {
      const s = recent[i];
      energy += s * s;
      if (i > 0 && (recent[i - 1] >= 0) !== (s >= 0)) crosses++;
    }
    const rms = Math.sqrt(energy / recent.length);
    const db = 20 * Math.log10(rms + 1e-8);
    const zcr = crosses / recent.length;

    const down = this.downsample(this.raw, sampleRate);
    const pitch = down.length > 320 ? this.yin(down, 16000) : null;
    const mag = this.bands(down);
    let flux = 0;
    if (this.prevBands) {
      for (let i = 0; i < mag.length; i++) {
        const d = mag[i] - this.prevBands[i];
        if (d > 0) flux += d;
      }
      flux /= mag.length;
    }
    this.prevBands = mag;

    const quiet = rms < this.noise * 2.2;
    if (quiet) this.noise = this.noise * 0.95 + rms * 0.05;
    const voiced = rms > Math.max(0.008, this.noise * 3.4) && zcr > 0.008 && zcr < 0.28 && (pitch !== null || rms > this.noise * 7);

    this.port.postMessage({
      t: (this.samplesSeen / sampleRate) * 1000,
      db,
      rms,
      pitch: voiced ? pitch : pitch && rms > this.noise * 2.5 ? pitch : null,
      voiced,
      zcr,
      flux,
    });
    return true;
  }
}

registerProcessor("clarivoz-analyzer", ClarivozAnalyzer);
