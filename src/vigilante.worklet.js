// Vigilante de un módulo (AudioWorklet), al final de su cadena (después del phaser, antes de la parte
// espacial). Hace dos cosas con cada muestra:
//  1. LIMPIA: un valor NaN o infinito se cambia por 0 (y el valor desmedido se recorta a ±8). Así un
//     módulo roto nunca contamina la reverb, el delay, el limitador ni la grabación, que son de todos.
//  2. MIDE: cada ~100 ms avisa al hilo principal el pico de ese tramo y cuántas muestras malas hubo.
//     audio.js decide con eso si el módulo hay que reconstruirlo (NaN, o silencio cuando debería sonar).

class Vigilante extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pico = 0;
    this.malas = 0;
    this.bloques = 0;
    this.porAviso = Math.max(1, Math.round(sampleRate * 0.1 / 128)); // bloques de 128 muestras en ~100 ms
    this.vivo = true;
    this.port.onmessage = (e) => { if (e.data === 'fin') this.vivo = false; };
  }

  process(inputs, outputs) {
    const entrada = inputs[0], salida = outputs[0];
    for (let c = 0; c < salida.length; c++) {
      const i = entrada[c], o = salida[c];
      if (!i) { o.fill(0); continue; }
      for (let k = 0; k < o.length; k++) {
        let v = i[k];
        if (v !== v || v === Infinity || v === -Infinity) { v = 0; this.malas++; }
        else if (v > 8) v = 8;
        else if (v < -8) v = -8;
        const a = v < 0 ? -v : v;
        if (a > this.pico) this.pico = a;
        o[k] = v;
      }
    }
    if (++this.bloques >= this.porAviso) {
      this.port.postMessage({ pico: this.pico, malas: this.malas, t: currentTime });
      this.pico = 0; this.malas = 0; this.bloques = 0;
    }
    return this.vivo;
  }
}

registerProcessor('vigilante', Vigilante);
