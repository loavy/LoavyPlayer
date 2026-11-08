import { audioPreferences, EQ_FREQUENCIES } from "./audioPreferences";

/** One processing graph for decoded tracks and local media fallback. Room streams stay direct. */
class AudioGraph {
  private context: AudioContext | null = null;
  private input: GainNode | null = null;
  private headroom: GainNode | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private responseFilters: BiquadFilterNode[] = [];
  private attached = new WeakSet<HTMLMediaElement>();
  private volume = .82;

  constructor() { audioPreferences.subscribe(() => this.applyEqualizer()); }
  ensure() {
    if (this.context && this.input) return { context: this.context, input: this.input };
    const context = new AudioContext({ latencyHint: "playback" });
    const input = context.createGain();
    const headroom = context.createGain();
    input.connect(headroom);
    let node: AudioNode = headroom;
    this.filters = EQ_FREQUENCIES.map((frequency) => {
      const filter = context.createBiquadFilter(); filter.type = "peaking"; filter.frequency.value = Math.min(frequency, context.sampleRate * .45); filter.Q.value = 1.1; node.connect(filter); node = filter; return filter;
    });
    this.responseFilters = this.filters.map((filter) => { const response = context.createBiquadFilter(); response.type = filter.type; response.frequency.value = filter.frequency.value; response.Q.value = filter.Q.value; return response; });
    const master = context.createGain(); master.gain.value = this.volume; node.connect(master);
    const analyser = context.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = .82;
    master.connect(analyser); analyser.connect(context.destination);
    this.context = context; this.input = input; this.headroom = headroom; this.master = master; this.analyser = analyser;
    this.applyEqualizer();
    return { context, input };
  }
  async resume() { const graph = this.ensure(); if (graph.context.state === "suspended") await graph.context.resume(); return graph; }
  attach(media: HTMLMediaElement) { if (!this.attached.has(media)) { const { context, input } = this.ensure(); context.createMediaElementSource(media).connect(input); this.attached.add(media); } }
  setVolume(volume: number) { this.volume = volume; if (this.context && this.master) this.master.gain.setTargetAtTime(volume, this.context.currentTime, .015); }
  getAnalyser() { return this.analyser; }
  private applyEqualizer() {
    if (!this.context || !this.headroom) return;
    const settings = audioPreferences.get();
    const gains = settings.eqEnabled ? settings.bands : EQ_FREQUENCIES.map(() => 0);
    const now = this.context.currentTime;
    this.filters.forEach((filter, index) => filter.gain.setTargetAtTime(gains[index] || 0, now, .025));
    // Measure the combined response: neighbouring boosts can add beyond any single slider.
    const frequencies = Float32Array.from({ length: 128 }, (_, index) => 20 * (Math.min(20000, this.context!.sampleRate * .45) / 20) ** (index / 127));
    const magnitude = new Float32Array(128), phase = new Float32Array(128), combined = new Float32Array(128).fill(1);
    this.responseFilters.forEach((filter, index) => { filter.gain.value = gains[index] || 0; filter.getFrequencyResponse(frequencies, magnitude, phase); magnitude.forEach((gain, bin) => { combined[bin] *= gain; }); });
    const peak = Math.max(1, ...combined);
    const reserve = settings.crossfade > 0 ? Math.SQRT1_2 : 1;
    this.headroom.gain.setTargetAtTime(reserve / peak, now, .025);
  }
}
export const audioGraph = new AudioGraph();
