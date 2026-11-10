// LFO junto a un parámetro: Filtro y Amplitud (Env) en armonía y melodía. La percusión no tiene LFO
// (el de Golpe se quitó el 10 de noviembre).
// Cada uno tiene una forma (seno, ruido sample & hold, diente de sierra) y un solo valor 0–1:
// 0 = apagado; hacia la derecha aumentan a la vez la profundidad y la velocidad, sincronizada al
// tempo: de unos 4 compases por ciclo (muy lento y sutil) hasta una corchea por ciclo (rápido y profundo).
// Todos corren sobre el mismo reloj (la posición del Transport, en negras): suenan en fase con la
// música y cualquier dispositivo calcula el mismo valor (también el ruido: azar fijo por módulo y ciclo).
//  · Filtro: modula el corte de forma continua, en OCTAVAS alrededor del corte elegido (audio.js lo
//    programa en el tiempo exacto). Bajo: ±0,75 oct en 4 compases; medio: ±2 oct ("wah"); máximo: ±3 oct
//    a una corchea. La resonancia y la compensación siguen al corte modulado.
//  · Amplitud (Env): modula el valor en cada nota (cada nota toma una forma distinta); a fondo recorre
//    todo el rango (de casi pluck a casi pad).
// (10 nov: antes la profundidad era ±0,5 × valor en la escala del deslizador: casi inaudible en valores
//  bajos y medios, gastaba la mitad del recorrido por encima de 5 kHz y a fondo se recortaba en los límites.)

// Velocidades posibles (negras por ciclo): 4 compases, 2 compases, 1 compás, blanca, negra, corchea
export const CICLOS = [16, 8, 4, 2, 1, 0.5];
export const NOMBRES_CICLO = ['4 compases', '2 compases', '1 compás', 'blanca', 'negra', 'corchea'];
export const cicloDe = (a) => CICLOS[Math.min(CICLOS.length - 1, Math.round(Math.max(a, 0) * (CICLOS.length - 1)))];
export const nombreCiclo = (a) => NOMBRES_CICLO[CICLOS.indexOf(cicloDe(a))];
// Profundidad según el valor del deslizador (0–1): curva que crece rápido al principio para que ya se
// oiga en valores bajos. Filtro en octavas; Amplitud en fracción de su recorrido.
export const octavasFiltro = (a) => 3 * Math.max(a, 0) ** 0.6;       // 0,1 → 0,75 · 0,5 → 2 · 1 → 3
export const alcance = (a) => Math.min(1, 1.15 * Math.max(a, 0) ** 0.6); // a fondo: todo el recorrido

function azar(a, b) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const semillas = new Map();
function semillaDe(id) {
  if (!semillas.has(id)) { let h = 7; for (const c of String(id)) h = Math.imul(h, 31) + c.charCodeAt(0) | 0; semillas.set(id, h); }
  return semillas.get(id);
}

// Forma de la onda entre −1 y 1, a la velocidad que corresponde al valor a del deslizador. 0 si apagado.
export function onda(forma, a, pulsos, semilla) {
  if (!(a > 0)) return 0;
  const f = pulsos / cicloDe(a);
  if (forma === 'sierra') return 2 * (f - Math.floor(f)) - 1;               // sube y cae de golpe
  if (forma === 'azar') return 2 * azar(Math.floor(f), semilla) - 1;        // un valor nuevo por ciclo
  return Math.sin(2 * Math.PI * f);                                          // seno
}

const entre = (v, min, max) => Math.min(max, Math.max(min, v));
// Valor actual de la forma de un LFO (−1 a 1, sin profundidad): para el punto que late en el editor.
export function forma(inst, cual, pulsos) {
  const p = inst.parametros, s = semillaDe(inst.id);
  const [a, f, k] = cual === 'filtro' ? [p.lfoFiltro, p.lfoFiltroForma, 1] : [p.lfoEnv, p.lfoEnvForma, 2];
  return onda(f, a, pulsos, s + k);
}

// Filtro 0–1 (escala del deslizador) ↔ corte en Hz (la misma curva que audio.js)
const corte = (f) => 150 * (20000 / 150) ** f;
const normal = (hz) => Math.log(hz / 150) / Math.log(20000 / 150);

// Parámetros con la modulación aplicada en un momento dado (copia; no toca el original).
// filtro queda en la escala 0–1 (puede bajar de 0 hasta ~60 Hz: el LFO cierra más que el deslizador);
// corteHz = corte modulado en Hz.
export function modulados(inst, pulsos) {
  const p = inst.parametros, s = semillaDe(inst.id), r = { ...p };
  if (inst.tipo === 'percusion') return r; // sin LFO
  if (p.lfoFiltro > 0) {
    const v = onda(p.lfoFiltroForma, p.lfoFiltro, pulsos, s + 1); // la profundidad va en octavas
    const hz = entre(corte(p.filtro) * 2 ** (v * octavasFiltro(p.lfoFiltro)), 60, 20000);
    r.corteHz = hz;
    r.filtro = normal(hz);
  }
  if (p.lfoEnv > 0) {
    const v = onda(p.lfoEnvForma, p.lfoEnv, pulsos, s + 2) * alcance(p.lfoEnv);
    r.envolvente = entre((p.envolvente ?? 0.5) + v, 0, 1);
  }
  return r;
}
