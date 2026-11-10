// Grabador (AudioWorklet): junta el audio de 8 canales (6 del 5.1 + 2 del binaural) en bloques
// de 8192 muestras (~170 ms a 48 kHz) y los pasa, sin copiarlos, al worker que escribe a disco por un
// MessagePort propio. Así el hilo principal (la animación) nunca toca el audio de la grabación.
// Mensajes: { puerto } al empezar; 'parar' → manda lo que quedó y { fin: true }.

const BLOQUE = 8192;
const CANALES = 8;

class Grabador extends AudioWorkletProcessor {
  constructor() {
    super();
    this.puerto = null;
    this.activo = true;
    this.nuevoBloque();
    this.port.onmessage = (e) => {
      if (e.data && e.data.puerto) this.puerto = e.data.puerto;
      if (e.data === 'parar') {
        this.enviar();
        this.puerto?.postMessage({ fin: true });
        this.activo = false;
      }
    };
  }
  nuevoBloque() {
    this.bloque = Array.from({ length: CANALES }, () => new Float32Array(BLOQUE));
    this.n = 0;
  }
  enviar() {
    if (!this.puerto || this.n === 0) return;
    const canales = this.bloque.map((c) => (this.n === BLOQUE ? c : c.slice(0, this.n)));
    this.puerto.postMessage({ canales }, canales.map((c) => c.buffer));
    this.nuevoBloque();
  }
  process(inputs) {
    if (!this.activo) return false;
    const entrada = inputs[0];
    const largo = entrada[0] ? entrada[0].length : 128;
    let leido = 0;
    while (leido < largo) {
      const cuantos = Math.min(largo - leido, BLOQUE - this.n);
      for (let c = 0; c < CANALES; c++) {
        const origen = entrada[c];
        if (origen) this.bloque[c].set(origen.subarray(leido, leido + cuantos), this.n);
        // sin entrada en ese canal (aún conectándose): queda en silencio (ceros)
      }
      this.n += cuantos;
      leido += cuantos;
      if (this.n === BLOQUE) this.enviar();
    }
    return true;
  }
}

registerProcessor('grabador', Grabador);
