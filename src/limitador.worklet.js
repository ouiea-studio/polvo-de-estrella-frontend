// Limitador enlazado para cualquier número de canales (AudioWorklet).
// Tone.Limiter usa un DynamicsCompressor del navegador, que solo admite 2 canales; en 5.1 hace falta
// uno que vea los 6 a la vez y baje todos por igual (enlazado), para que la imagen no se mueva.
//
// Cómo funciona: mira el pico de todos los canales, calcula cuánto hay que bajar para no pasar del
// umbral y aplica esa ganancia al audio retrasado unos milisegundos (anticipación). Así la ganancia
// ya bajó, suavemente, cuando llega el pico: sin recortes ni clics. Después sube despacio (liberación).
//  · mínimo en una ventana de L+1 muestras  → nunca se pierde un pico
//  · promedio de L muestras sobre ese mínimo → la bajada es una rampa, no un escalón
//  · audio retrasado L muestras             → la rampa termina justo cuando llega el pico

class LimitadorEnlazado extends AudioWorkletProcessor {
  constructor(opciones) {
    super();
    const o = opciones.processorOptions || {};
    this.umbral = 10 ** ((o.umbralDb ?? -1) / 20);
    this.L = Math.max(1, Math.round(sampleRate * (o.anticipacionMs ?? 3) / 1000));
    this.liberacion = Math.exp(-1 / (sampleRate * (o.liberacionMs ?? 120) / 1000));
    this.requerida = new Float32Array(this.L + 1).fill(1); // ganancia necesaria por muestra
    this.posReq = 0;
    this.minimos = new Float32Array(this.L).fill(1);       // historial para el promedio
    this.suma = this.L;
    this.pos = 0;
    this.retardos = [];
    this.g = 1;
    this.peor = 1;   // la mayor reducción desde el último aviso
    this.bloques = 0;
  }

  process(inputs, outputs) {
    const entrada = inputs[0] || [];
    const salida = outputs[0];
    const nc = salida.length;
    const n = salida[0] ? salida[0].length : 128;
    while (this.retardos.length < nc) this.retardos.push(new Float32Array(this.L));
    const req = this.requerida, R = req.length;
    for (let k = 0; k < n; k++) {
      let pico = 0;
      for (let c = 0; c < entrada.length; c++) {
        const v = Math.abs(entrada[c][k]);
        if (v > pico) pico = v;
      }
      req[this.posReq] = pico > this.umbral ? this.umbral / pico : 1;
      this.posReq = (this.posReq + 1) % R;
      let minimo = 1;
      for (let j = 0; j < R; j++) if (req[j] < minimo) minimo = req[j];
      this.suma += minimo - this.minimos[this.pos];
      this.minimos[this.pos] = minimo;
      const objetivo = Math.min(1, this.suma / this.L);
      this.g = objetivo < this.g ? objetivo : objetivo + (this.g - objetivo) * this.liberacion;
      for (let c = 0; c < nc; c++) {
        const r = this.retardos[c];
        const retrasada = r[this.pos];
        r[this.pos] = c < entrada.length ? entrada[c][k] : 0;
        salida[c][k] = retrasada * this.g;
      }
      this.pos = (this.pos + 1) % this.L;
      if (this.g < this.peor) this.peor = this.g;
    }
    // unas 10 veces por segundo avisa la reducción máxima (en dB) para el panel
    if (++this.bloques >= 37) {
      this.port.postMessage(20 * Math.log10(Math.max(this.peor, 1e-6)));
      this.peor = 1;
      this.bloques = 0;
    }
    return true;
  }
}

registerProcessor('limitador-enlazado', LimitadorEnlazado);
