// RELOJ COMPARTIDO (10 de noviembre de 2026). El servidor es la referencia del pulso: guarda un ancla
// { t0, pulsos0, bpm } (en el instante t0 de SU reloj el pulso iba en pulsos0 negras y avanza a bpm).
// Este módulo mide el desfase entre el reloj de este navegador y el del servidor con varios
// intercambios de ida y vuelta (la respuesta llega a mitad del viaje: desfase = hora del servidor −
// (envío + ida y vuelta / 2)), se queda con los de menor ida y vuelta y usa la MEDIANA. Así:
//  · ahoraServidor(): la hora del servidor en este instante;
//  · pulsosServidor(ms): en qué negra va la música en ese instante del servidor.
// audio.js alinea el Transport de Tone a esto (compensando también la latencia de salida del audio)
// y la parte visual usa los mismos pulsos: todos los dispositivos quedan en fase.

const ahoraLocal = () => performance.timeOrigin + performance.now();
let desfase = 0;           // ms: servidor − local
let medido = false;
let ancla = null;          // { t0, pulsos0, bpm }
const muestras = [];       // { ida y vuelta, desfase }
const oyentes = new Set();

export const sincronizado = () => medido && !!ancla;
export const ahoraServidor = () => ahoraLocal() + desfase;
export function fijarAncla(a) {
  if (!a || !Number.isFinite(a.t0) || !Number.isFinite(a.pulsos0) || !(a.bpm > 0)) return;
  ancla = { t0: a.t0, pulsos0: a.pulsos0, bpm: a.bpm };
  oyentes.forEach((fn) => fn());
}
export const alCambiar = (fn) => oyentes.add(fn);
export function pulsosServidor(ms = ahoraServidor()) {
  return ancla ? ancla.pulsos0 + (ms - ancla.t0) / 60000 * ancla.bpm : null;
}
export const bpm = () => ancla?.bpm ?? null;
// Hora local (ms, performance.timeOrigin + performance.now()) que corresponde a una hora del servidor
export const aLocal = (msServidor) => msServidor - desfase;

function recalcular() {
  if (!muestras.length) return;
  // los intercambios más rápidos son los más precisos: el tercio con menor ida y vuelta (al menos 3)
  const mejores = [...muestras].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(3, Math.ceil(muestras.length / 3)));
  const d = mejores.map((m) => m.desfase).sort((a, b) => a - b);
  desfase = d.length % 2 ? d[(d.length - 1) / 2] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2;
  medido = true;
  oyentes.forEach((fn) => fn());
}

// pedir(evento) → promesa con la respuesta del servidor (socket.emit con ack)
async function medir(pedir, veces) {
  for (let i = 0; i < veces; i++) {
    const t0 = ahoraLocal();
    const r = await pedir('reloj:hora');
    const t1 = ahoraLocal();
    if (!r?.ok || !Number.isFinite(r.t)) continue;
    muestras.push({ rtt: t1 - t0, desfase: r.t - (t0 + (t1 - t0) / 2) });
    if (muestras.length > 40) muestras.shift();
    if (r.reloj) fijarAncla(r.reloj);
  }
  recalcular();
}

let reloj = null;
// Al conectar: 9 intercambios seguidos; después 3 cada 15 s (la deriva entre relojes es lenta).
export async function sincronizar(pedir) {
  muestras.length = 0;
  await medir(pedir, 9);
  clearInterval(reloj);
  reloj = setInterval(() => medir(pedir, 3), 15000);
}

export const diagnostico = () => {
  const mejores = [...muestras].sort((a, b) => a.rtt - b.rtt);
  return { desfaseMs: +desfase.toFixed(2), muestras: muestras.length, idaYVueltaMinMs: +(mejores[0]?.rtt ?? NaN).toFixed(2), ancla };
};
