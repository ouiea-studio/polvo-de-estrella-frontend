// Audio con Tone.js. Cada navegador genera la mezcla completa a partir del estado compartido:
// no se sincroniza audio entre computadores, solo los datos (tempo, escala, patrones, posiciones).
//
// Cadena de cada instrumento: sintetizador → filtro → nivel base → phaser propio → vigilante → parte espacial (salida.js).
// No hay control de volumen: el volumen lo da la distancia al centro; el nivel base equilibra los
// instrumentos entre sí. La parte espacial reparte el sonido según la posición de la pieza: en estéreo
// (paneo y volumen por distancia) o en 5.1 (los 6 canales del domo). De ella salen dos envíos hacia
// efectos compartidos: una reverb larga y un delay en corchea con puntillo sincronizado al tempo.
// FX de cada instrumento: uno solo activo (reverb, delay o phaser) con una "cantidad".
// La salida (dispositivo, canales, limitador y silencio) la maneja salida.js.

import * as Tone from 'tone';
import * as salida from './salida.js';
import { modulados } from './lfo.js';
import { adsr, ligado } from './envolvente.js';
import * as reloj from './reloj.js';
// no-inline: en producción el worklet va como archivo propio
import urlVigilante from './vigilante.worklet.js?url&no-inline';

// --- Escalas: intervalos en semitonos desde la tónica ---
const TONICAS = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const MODOS = {
  jonico: [0, 2, 4, 5, 7, 9, 11], dorico: [0, 2, 3, 5, 7, 9, 10], frigio: [0, 1, 3, 5, 7, 8, 10],
  lidio: [0, 2, 4, 6, 7, 9, 11], mixolidio: [0, 2, 4, 5, 7, 9, 10], eolico: [0, 2, 3, 5, 7, 8, 10],
  locrio: [0, 1, 3, 5, 6, 8, 10], pentatonica_mayor: [0, 2, 4, 7, 9], pentatonica_menor: [0, 3, 5, 7, 10],
};

// Duración de un paso en ticks del Transport. Con 960 ticks por negra caben todas exactas.
const PPQ = 960;
const TICKS = { corchea: 480, semicorchea: 240, tresillo: 320, quintillo: 192 };

// Acorde de la armonía: cuatriada diatónica (grado, tercera, quinta y séptima de la escala global),
// que es la que permite los voicings drop 2 y drop 3.
const ACORDE = [0, 2, 4, 6];
// Voicing: de cerrado (todo dentro de una octava) a amplio (bajo grave y notas repartidas en ~3 octavas).
// El deslizador 0–1 recorre estas cinco disposiciones. Las notas van ordenadas de grave a agudo: [1, 3, 5, 7].
export const VOICINGS = ['cerrado', 'drop 2', 'drop 3', 'drop 2 y 4', 'amplio'];
const DISPOSICION = [
  ([a, b, c, d]) => [a, b, c, d],                 // cerrado
  ([a, b, c, d]) => [c - 12, a, b, d],            // drop 2: baja una octava la segunda más aguda
  ([a, b, c, d]) => [b - 12, a, c, d],            // drop 3: baja la tercera más aguda
  ([a, b, c, d]) => [a - 12, c - 12, b, d],       // drop 2 y 4
  ([a, b, c, d]) => [a - 12, c, b + 12, d + 12],  // amplio: fundamental grave, el resto abierto hacia arriba
];
export const etapaVoicing = (v) => Math.round(Math.min(Math.max(v, 0), 1) * (DISPOSICION.length - 1));

// Filtro pasa bajos de armonía y melodía, un solo deslizador (0 cerrado → 1 abierto):
// el corte baja de forma exponencial de 20 kHz a 150 Hz y la resonancia sube de Q 0,7 a 8.
// La compensación (dB) contrarresta el realce de la resonancia, medido con ponderación K
// en acordes y notas de sierra en distintos registros (offline, 9 de noviembre de 2026).
const corteFiltro = (f) => 150 * (20000 / 150) ** f;
const qFiltro = (f) => 0.7 + 7.3 * (1 - f) ** 2;
const COMPENSACION = [1, -2, -1.2, -0.6, -0.2, 0, 0, 0, 0, 0, 0]; // en f = 0, 0,1 … 1
function compensacionFiltro(f) {
  const x = Math.min(Math.max(f, 0), 1) * 10, i = Math.min(Math.floor(x), 9);
  return COMPENSACION[i] + (COMPENSACION[i + 1] - COMPENSACION[i]) * (x - i);
}

// Nivel base de cada sonido (dB): equilibra los instrumentos entre sí (no hay control de volumen).
// Medido con el motor real, cada uno solo en el centro con su patrón por defecto (9 de noviembre de 2026):
// golpes de percusión respecto del kick (snare −3 dB, hat −10, perc −8, en nivel de golpe) y armonía
// y melodía unos 3–4 dB por debajo del kick en nivel medio.
const NIVEL = { kick: -4, snare: 7, hat: -5, perc: -20, armonia: -17.5, melodia: -13 };
// Envío al subgrave (LFE, solo en 5.1): automático según el instrumento.
const LFE = { kick: 0.6, snare: 0.05, hat: 0, perc: 0, armonia: 0.1, melodia: 0 };
// Phaser: una vuelta completa cada dos compases de 4/4 (barridoPhaser, desde el pulso)

let escala = { tonica: 'D', modo: 'dorico' };
let tempo = 70;
let iniciado = false;
let efectos = null; // { reverb, delay } compartidos por todos los instrumentos
let alPaso = () => {}; // reacción visual: (id, paso, sono, tipo)

const instrumentos = new Map(); // id → datos del instrumento (siempre los últimos)
const posiciones = new Map();   // id → { x, z } de la pieza en el plano
const voces = new Map();        // id → nodos de Tone.js (solo después de iniciar)
const fundidos = new Map();     // id → { hasta: segundos de reloj (performance) } módulos que se disuelven

// Grado de la escala (puede pasar de 6: sube de octava) → nota MIDI.
// Así un patrón se reinterpreta solo cuando cambia la escala: guarda grados, no notas.
function gradoAMidi(grado, octava) {
  const intervalos = MODOS[escala.modo] || MODOS.eolico;
  const n = intervalos.length;
  const vuelta = Math.floor(grado / n);
  return 12 * (octava + 1) + (TONICAS[escala.tonica] ?? 0) + intervalos[((grado % n) + n) % n] + 12 * vuelta;
}
const midiAHz = (m) => entre(440 * 2 ** ((m - 69) / 12), 20, 14000, 440);

// =====================================================================
// PROTECCIONES (10 de noviembre de 2026): ningún valor fuera de rango, NaN ni infinito llega a un nodo.
// Todo lo que se aplica (también lo ya modulado por el LFO) pasa por entre(); los datos que llegan de
// la red se limpian al entrar (limpiar). Ver también el vigilante de cada módulo, más abajo.
// =====================================================================
function entre(v, min, max, porDefecto) {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : porDefecto;
}
// [mínimo, máximo, por defecto] de cada parámetro numérico, y opciones de los de lista
const RANGOS = {
  pitch: [-12, 12, 0], decay: [0.02, 1.5, 0.3], cantidad: [0, 1, 0], voicing: [0, 1, 0.3], filtro: [0, 1, 0.5],
  envolvente: [0, 1, 0.5], lfoFiltro: [0, 1, 0], lfoEnv: [0, 1, 0], octava: [-1, 1, 0], espacio: [-100, 100, 0],
};
const OPCIONES = {
  sonido: ['kick', 'snare', 'hat', 'perc'], fx: ['reverb', 'delay', 'phaser'],
  lfoFiltroForma: ['seno', 'azar', 'sierra'], lfoEnvForma: ['seno', 'azar', 'sierra'],
};
function limpiar(inst) {
  const p = { ...inst.parametros };
  for (const k in RANGOS) if (k in p) {
    const [a, b, d] = RANGOS[k];
    p[k] = entre(+p[k], a, b, d);
  }
  if ('octava' in p) p.octava = Math.round(p.octava);
  for (const k in OPCIONES) if (k in p && !OPCIONES[k].includes(p[k])) p[k] = OPCIONES[k][0];
  if (inst.tipo === 'percusion' && !OPCIONES.sonido.includes(p.sonido)) p.sonido = 'kick';
  const pasos = Math.round(entre(+inst.pasos, 1, 32, 16));
  const patron = Array.from({ length: pasos }, (_, i) => {
    const v = Array.isArray(inst.patron) ? inst.patron[i] : null;
    if (inst.tipo === 'percusion') return !!v;
    return Number.isInteger(v) && v >= 0 && v <= 6 ? v : null;
  });
  return { ...inst, pasos, patron, subdivision: TICKS[inst.subdivision] ? inst.subdivision : 'semicorchea', parametros: p };
}
// Corte del filtro seguro: entre 30 Hz y el 45 % de la frecuencia de muestreo (nunca 0 ni sobre Nyquist)
let corteMax = 20000;
const corteSeguro = (hz, porDefecto) => entre(hz, 30, corteMax, porDefecto);
// Un mismo sintetizador no puede disparar dos veces en el mismo instante (Tone lanza un error y la
// nota se pierde; pasaba cuando el acento de un choque caía justo en un paso con nota).
function instanteLibre(objeto, time) {
  const t = Math.max(time, (objeto.ultimoDisparo ?? -1) + 0.003);
  objeto.ultimoDisparo = t;
  return t;
}

// Phaser mono propio de cada instrumento: 4 filtros pasa todo cuya frecuencia barre un LFO
// sincronizado al tempo. (Tone.Phaser es estéreo con los lados en contrafase: al sumarlo a mono,
// como hace la parte espacial, el efecto se cancela.) "cantidad" = mezcla: 1 = mitad seco y mitad
// desfasado, que es donde las cancelaciones son más profundas.
// El barrido lo programa el control continuo (modularContinuo) desde el pulso del Transport, que está
// alineado al reloj compartido: así va en fase con el halo del phaser en cualquier dispositivo
// (antes era un Tone.LFO libre, con su propia fase).
const barridoPhaser = (pul) => 300 + 2900 * (0.5 + 0.5 * Math.sin(2 * Math.PI * pul / 8)); // 300–3.200 Hz
function crearPhaser() {
  const entrada = new Tone.Gain(1), seco = new Tone.Gain(1), humedo = new Tone.Gain(0), salidaFx = new Tone.Gain(1);
  const frecuencia = new Tone.Signal({ value: 1000, units: 'frequency' });
  const etapas = Array.from({ length: 4 }, () => new Tone.Filter({ type: 'allpass', frequency: 1000, Q: 0.6 }));
  entrada.connect(seco);
  seco.connect(salidaFx);
  entrada.chain(...etapas, humedo, salidaFx);
  etapas.forEach((f) => frecuencia.connect(f.frequency));
  return {
    entrada, salida: salidaFx, frecuencia, activo: false,
    cantidad(c) {
      this.activo = c > 0;
      for (const g of [humedo.gain, seco.gain]) g.cancelScheduledValues(Tone.immediate());
      humedo.gain.rampTo(c * 0.5, 0.05); seco.gain.rampTo(1 - c * 0.5, 0.05);
    },
    dispose() { [entrada, seco, humedo, salidaFx, frecuencia, ...etapas].forEach((n) => n.dispose()); },
  };
}

// =====================================================================
// Voces
// =====================================================================

// Armonía: grupo propio de 24 voces (sierra). Antes era un Tone.PolySynth de 32 voces que, con la
// Amplitud larga (acordes de hasta 10 s más 4 s de cola), se llenaba y DESCARTABA las notas nuevas en
// silencio: el módulo dejaba de sonar (medido el 10 nov: 114 notas perdidas en 15 s). Ahora, si no hay
// voces libres, se reutiliza la que antes termina (la más vieja): nunca se pierde un acorde nuevo.
// La melodía usa el mismo grupo con 6 voces: con un solo sintetizador, el "soltar" programado de una
// nota cortaba la siguiente si llegaba antes (un acento de choque, un patrón recién editado).
const VOCES_ARMONIA = 24, VOCES_MELODIA = 6;
function crearGrupo(destino, cuantas) {
  const voces = Array.from({ length: cuantas }, () => {
    const s = new Tone.Synth({ oscillator: { type: 'sawtooth' } });
    s.connect(destino);
    return { s, libre: 0, inicio: -1 };
  });
  return {
    voces,
    // frecuencias (Hz) de un acorde (o una sola nota), duración, instante, intensidad y envolvente
    tocar(frecuencias, dur, time, vel, env) {
      const elegibles = voces.filter((v) => v.inicio < time - 0.002).sort((a, b) => a.libre - b.libre);
      frecuencias.forEach((hz, k) => {
        const v = elegibles[k];
        if (!v) return;
        v.s.set({ envelope: env });
        v.s.triggerAttack(hz, time, vel);
        v.s.triggerRelease(time + dur);
        v.inicio = time;
        v.libre = time + dur + env.release;
      });
    },
    ocupadas: (t) => voces.filter((v) => v.libre > t).length,
    dispose() { voces.forEach((v) => v.s.dispose()); },
    connect(n) { voces.forEach((v) => v.s.connect(n)); },
  };
}

// Percusión: cada sonido es un sintetizador distinto; el pitch mueve su frecuencia o su filtro.
function crearPercusion(voz, p) {
  voz.synth?.dispose();
  const factor = 2 ** (p.pitch / 12);
  const env = { attack: 0.001, decay: p.decay, sustain: 0, release: 0.05 };
  if (p.sonido === 'kick') {
    voz.synth = new Tone.MembraneSynth({ pitchDecay: 0.03, octaves: 6, oscillator: { type: 'sine' }, envelope: env });
    voz.filtro.set({ type: 'lowpass', frequency: 18000, Q: 0.5 });
  } else if (p.sonido === 'snare') {
    voz.synth = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: env });
    voz.filtro.set({ type: 'bandpass', frequency: 1800 * factor, Q: 0.8 });
  } else if (p.sonido === 'hat') {
    voz.synth = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: env });
    voz.filtro.set({ type: 'highpass', frequency: 7000 * factor, Q: 0.7 });
  } else {
    voz.synth = new Tone.MetalSynth({ envelope: env, harmonicity: 5.1, modulationIndex: 16, resonance: 3000, octaves: 1.5 });
    voz.filtro.set({ type: 'lowpass', frequency: 18000, Q: 0.5 });
  }
  voz.sonido = p.sonido;
  voz.golpes = []; // los golpes pendientes del sintetizador anterior ya no van a sonar: no se esperan
  voz.synth.connect(voz.filtro);
}

function crearVoz(inst) {
  const voz = {
    filtro: new Tone.Filter({ frequency: 18000, type: 'lowpass', rolloff: -12 }),
    volumen: new Tone.Volume(-100),
    phaser: crearPhaser(),
    espacial: salida.crearEspacial(), // paneo, distancia, 5.1 y LFE
    envioReverb: new Tone.Gain(0),
    envioDelay: new Tone.Gain(0),
    envioWash: new Tone.Gain(0), // solo en el final de la obra: a la reverb larga del final
    synth: null, sonido: null, subdivision: null, loop: null,
    esperaHasta: 0, esperaDesde: 0, silencios: 0, // para el vigilante
    id: inst.id,
  };
  voz.filtro.chain(voz.volumen, voz.phaser.entrada);
  // vigilante: limpia NaN e infinitos y mide la salida del módulo (ver "Vigilante")
  voz.vigilante = new AudioWorkletNode(Tone.getContext().rawContext, 'vigilante',
    { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
  voz.vigilante.port.onmessage = ({ data }) => { try { revisarVoz(inst.id, voz, data); } catch { /* el reloj puede estar roto un instante */ } };
  Tone.connect(voz.phaser.salida, voz.vigilante);
  voz.vigilante.connect(voz.espacial.entrada);
  // envíos después del paneo y del volumen por distancia: el eco conserva el lado
  voz.espacial.espacio.connect(voz.envioReverb.input);
  voz.espacial.espacio.connect(voz.envioDelay.input);
  voz.envioReverb.connect(efectos.reverb);
  voz.envioDelay.connect(efectos.delay);
  voz.espacial.espacio.connect(voz.envioWash.input);
  voz.envioWash.connect(efectos.wash);
  // armonía y melodía: sierra; el brillo lo decide solo el filtro (abierto = sin filtrar)
  if (inst.tipo === 'armonia') {
    voz.synth = crearGrupo(voz.filtro, VOCES_ARMONIA);
  } else if (inst.tipo === 'melodia') {
    voz.synth = crearGrupo(voz.filtro, VOCES_MELODIA);
  }
  voz.loop = new Tone.Loop((time) => tocar(inst.id, time), TICKS.semicorchea + 'i').start(0);
  voz.creada = performance.now();
  voces.set(inst.id, voz);
  aplicarVoz(inst.id);
  const pos = posiciones.get(inst.id);
  if (pos) salida.posicionar(voz.espacial, pos.x, pos.z);
  const f = fundidos.get(inst.id); // se estaba disolviendo antes de encender el audio
  if (f && f.seco && lavado) lavarVoz(voz, Math.max(0.05, f.hasta - performance.now() / 1000));
  else if (f) salida.fundirEspacial(voz.espacial, 0, Math.max(0.05, f.hasta - performance.now() / 1000));
}

// Lleva los parámetros del instrumento a sus nodos de Tone.js.
function aplicarVoz(id) {
  const inst = instrumentos.get(id), voz = voces.get(id);
  if (!inst || !voz) return;
  try { aplicarVozSeguro(inst, voz); } catch (e) { fallo(id, voz, e); }
}
function aplicarVozSeguro(inst, voz) {
  const p = inst.parametros;
  if (voz.subdivision !== inst.subdivision) {
    voz.loop.interval = (TICKS[inst.subdivision] || TICKS.semicorchea) + 'i';
    voz.subdivision = inst.subdivision;
  }
  const sonido = inst.tipo === 'percusion' ? p.sonido : inst.tipo;
  // El LFO del filtro programa el corte por su cuenta (modularContinuo): aquí no se toca mientras
  // esté activo; al apagarlo se cancela lo programado y vuelve el valor elegido.
  const lfoFiltro = inst.tipo !== 'percusion' && p.lfoFiltro > 0;
  if (voz.lfoFiltro && !lfoFiltro) {
    const ya = Tone.immediate();
    [voz.filtro.frequency, voz.filtro.Q, voz.volumen.volume].forEach((prm) => prm.cancelScheduledValues(ya));
  }
  // recién activado (o voz recién hecha con el LFO ya activo): se deja el corte y el nivel en su valor
  // base al instante; el control continuo los modula desde ahí (antes la voz nueva quedaba en −100 dB
  // hasta que el control la alcanzara)
  if (lfoFiltro && !voz.lfoFiltro) {
    voz.filtro.frequency.rampTo(corteSeguro(corteFiltro(p.filtro), 1000), 0.03);
    voz.filtro.Q.rampTo(qFiltro(p.filtro), 0.03);
    voz.volumen.volume.rampTo(NIVEL[inst.tipo] + compensacionFiltro(p.filtro), 0.03);
  }
  voz.lfoFiltro = lfoFiltro;
  if (inst.tipo === 'percusion') {
    if (voz.sonido !== p.sonido) crearPercusion(voz, p);
    voz.synth.envelope.decay = p.decay;
    const factor = 2 ** (p.pitch / 12);
    if (p.sonido === 'snare') voz.filtro.frequency.rampTo(corteSeguro(1800 * factor, 1800), 0.05);
    if (p.sonido === 'hat') voz.filtro.frequency.rampTo(corteSeguro(7000 * factor, 7000), 0.05);
    voz.volumen.volume.rampTo(NIVEL[p.sonido], 0.05);
  } else {
    // Amplitud (Env): un solo valor mueve ataque, decay, sustain y release (envolvente.js); se aplica
    // nota a nota (grupo de voces)
    if (!lfoFiltro) {
      voz.filtro.frequency.rampTo(corteSeguro(corteFiltro(p.filtro), 1000), 0.05);
      voz.filtro.Q.rampTo(qFiltro(p.filtro), 0.05);
      voz.volumen.volume.rampTo(NIVEL[inst.tipo] + compensacionFiltro(p.filtro), 0.05);
    }
  }
  // FX: uno solo activo
  const c = p.cantidad ?? 0;
  voz.envioReverb.gain.rampTo(p.fx === 'reverb' ? c : 0, 0.05);
  if (!lavado) voz.envioDelay.gain.rampTo(p.fx === 'delay' ? c : 0, 0.05); // en el final lo maneja el wash
  voz.phaser.cantidad(p.fx === 'phaser' ? c : 0);
  salida.fijarEnvioLFE(voz.espacial, LFE[sonido] ?? 0); // solo se oye en modo 5.1
}

// =====================================================================
// LFO — todas las ondas salen de la posición del Transport (lfo.js): en fase con la música.
//  · Filtro (continuo): un control a 128n (64 por segundo a 120 BPM) programa el corte, la resonancia
//    y la compensación en su tiempo exacto, con rampas lineales entre puntos.
//  · Amplitud (Env) (por nota): se lee el valor modulado en el instante de cada nota. (La percusión no
//    tiene LFO.)
// =====================================================================
const pulsosEn = (time) => Tone.getTransport().getTicksAtTime(time) / PPQ;
let ultimoControl = 0; // performance.now() del último paso del control del LFO (lo revisa el vigilante del reloj)
function modularContinuo(time) {
  ultimoControl = performance.now();
  let pul;
  try { pul = pulsosEn(time); } catch { return; }
  if (!Number.isFinite(pul)) return;
  for (const [id, voz] of voces) {
    const inst = instrumentos.get(id);
    if (!inst) continue;
    if (voz.phaser.activo) {
      try { voz.phaser.frecuencia.linearRampToValueAtTime(barridoPhaser(pul), time); } catch (e) { fallo(id, voz, e); }
    }
    if (!voz.lfoFiltro) continue;
    try {
      const m = modulados(inst, pul);
      // corte en octavas alrededor del elegido (recortado a un rango seguro); resonancia y compensación
      // siguen al corte modulado
      const base = corteFiltro(inst.parametros.filtro);
      const f = entre(m.filtro, 0, 1, inst.parametros.filtro);
      voz.filtro.frequency.linearRampToValueAtTime(corteSeguro(m.corteHz, base), time);
      voz.filtro.Q.linearRampToValueAtTime(entre(qFiltro(f), 0.5, 8, 0.7), time);
      voz.volumen.volume.linearRampToValueAtTime(entre(NIVEL[inst.tipo] + compensacionFiltro(f), -60, 0, NIVEL[inst.tipo]), time);
    } catch (e) { fallo(id, voz, e); }
  }
}
// Parámetros con los que suena una nota en "time" (con los LFO por nota)
function paraNota(inst, time) {
  const m = modulados(inst, pulsosEn(time));
  if ('envolvente' in m) m.envolvente = entre(m.envolvente, 0, 1, inst.parametros.envolvente ?? 0.5);
  return m;
}
// Dispara un golpe de percusión con su tono y golpe
function golpePercusion(voz, p, time, vel = 1) {
  time = instanteLibre(voz, time);
  const d = entre(p.decay, 0.02, 1.5, 0.3);
  voz.synth.envelope.decay = d;
  const factor = 2 ** (entre(p.pitch, -12, 12, 0) / 12);
  // Solo el ataque: con sustain 0 el golpe decae solo. (Con triggerAttackRelease, el "soltar" del golpe
  // anterior —programado en su instante + golpe— cortaba en seco el golpe nuevo si llegaba antes.)
  if (p.sonido === 'kick') voz.synth.triggerAttack(45 * factor, time, vel);
  else if (p.sonido === 'perc') voz.synth.triggerAttack(300 * factor, time, vel);
  else voz.synth.triggerAttack(time, vel);
  (voz.golpes ||= []).push(time);
  statsDe(voz.id).notas++; statsDe(voz.id).ventana.notas++;
}

// Cuántos segundos dura una nota: hasta el siguiente paso con nota (legato), como mucho una vuelta.
// mismo = true: también salta los pasos con el MISMO grado (acorde ligado).
function duracionLegato(inst, paso, segPaso, mismo = false) {
  const valor = inst.patron[paso];
  let n = 1;
  while (n < inst.pasos) {
    const v = inst.patron[(paso + n) % inst.pasos];
    if (v !== null && !(mismo && v === valor)) break;
    n++;
  }
  return n * segPaso * 0.92;
}
// Armonía ligada: si el acorde anterior es el mismo grado, este paso no vuelve a atacarlo (sigue
// creciendo). Si todo el patrón es el mismo acorde, se ataca solo en el primer paso con nota.
function acordeLigadoDesdeAntes(inst, paso) {
  const valor = inst.patron[paso];
  for (let n = 1; n < inst.pasos; n++) {
    const v = inst.patron[(paso - n + inst.pasos) % inst.pasos];
    if (v === null) continue;
    return v === valor;
  }
  return paso !== inst.patron.findIndex((v) => v !== null); // todos iguales: solo el primero ataca
}

// Se llama en cada paso de cada instrumento, con el tiempo exacto de audio.
function tocar(id, time) {
  const inst = instrumentos.get(id), voz = voces.get(id);
  if (!inst || !voz) return;
  voz.ultimoPaso = performance.now(); // su secuenciador sigue vivo
  try { tocarSeguro(id, inst, voz, time); } catch (e) { fallo(id, voz, e); }
}
function tocarSeguro(id, inst, voz, time) {
  if (lavado && time >= lavado.corte) return; // final: desde la mitad ya no hay notas nuevas
  const ticks = TICKS[inst.subdivision] || TICKS.semicorchea;
  // El paso sale de la posición del Transport: todos los instrumentos quedan alineados
  // al mismo pulso aunque tengan distinto número de pasos (polimetría).
  const paso = Math.round(Tone.getTransport().getTicksAtTime(time) / ticks) % inst.pasos;
  if (!Number.isInteger(paso)) return;
  const valor = inst.patron[paso];
  const p = paraNota(inst, time);
  let sono = false;
  if (inst.tipo === 'percusion') {
    if (valor) {
      sono = true;
      golpePercusion(voz, p, time);
    }
  } else if (valor !== null && valor !== undefined) {
    const segPaso = Tone.Ticks(ticks).toSeconds();
    const env = adsr(p.envolvente);
    voz.ultimoGrado = valor; // para los acentos de los choques
    if (inst.tipo === 'armonia') {
      const liga = ligado(p.envolvente);
      if (!(liga > 0.5 && acordeLigadoDesdeAntes(inst, paso))) {
        sono = true;
        // hacia la derecha: el acorde dura hasta el siguiente acorde DISTINTO y se solapa con él
        const dur = Math.min(duracionLegato(inst, paso, segPaso, liga > 0.5) + env.attack * liga, 10);
        // con el LFO de Amplitud, cada acorde toma su forma
        const t = instanteLibre(voz, time);
        voz.synth.tocar(acordeMidi(valor, p).map(midiAHz), dur, t, 0.6, env);
        esperarSonido(voz, t, dur);
      }
    } else {
      sono = true;
      const dur = Math.min(duracionLegato(inst, paso, segPaso), 4);
      const t = instanteLibre(voz, time);
      voz.synth.tocar([midiAHz(gradoAMidi(valor, 4 + (p.octava ?? 0)))], dur, t, 0.8, env);
      esperarSonido(voz, t, dur);
    }
  }
  if (sono) ecos(id, inst, time);
  programarVisual(() => alPaso(id, paso, sono, inst.tipo), time);
}

// Fantasmas (main.js los dibuja): cada nota con REVERB pide un halo que respira; con DELAY, una gema
// fantasma por cada repetición, en el instante exacto de cada eco y más tenue según el feedback.
const FEEDBACK = 0.35, FEEDBACK_FINAL = 0.7; // el del final nunca pasa de 0,7 (no se autooscila)
function ecos(id, inst, time) {
  const p = inst.parametros, c = p.cantidad ?? 0;
  if (lavado) {
    // final: en TODAS las gemas, una nube de reverb y una cadena de ecos del delay que crecen con el
    // wash (la misma curva que los envíos y el feedback, que sube de 0,35 a 0,7)
    const k = Math.min(Math.max((time - lavado.t0) / (lavado.corte - lavado.t0), 0), 1);
    const fuerzaR = 0.45 + 0.55 * k, fb = FEEDBACK + (FEEDBACK_FINAL - FEEDBACK) * k, D = segundosDelay(tempo);
    programarVisual(() => alFantasma(id, 'reverb', fuerzaR, 0), time);
    for (let j = 1, fuerza = (0.5 + 0.5 * k) * fb; j <= 6 && fuerza > 0.03; j++, fuerza *= fb) {
      const f = fuerza;
      programarVisual(() => alFantasma(id, 'delay', f, j), time + j * D);
    }
    return;
  }
  if (c <= 0) return;
  if (p.fx === 'reverb') programarVisual(() => alFantasma(id, 'reverb', c, 0), time);
  else if (p.fx === 'delay') {
    const D = segundosDelay(tempo);
    for (let k = 1, fuerza = c * FEEDBACK; k <= 6 && fuerza > 0.02; k++, fuerza *= FEEDBACK) {
      const f = fuerza;
      programarVisual(() => alFantasma(id, 'delay', f, k), time + k * D);
    }
  }
}
let alFantasma = () => {};

// Reacciones visuales a tiempo con el audio (rebote de la gema, fantasmas). Antes se usaba Tone.Draw,
// que guarda cada una hasta el siguiente cuadro dibujado: con la pestaña oculta o el navegador
// minimizado no se dibuja, la lista crecía sin límite y en unos minutos la página se congelaba
// (encontrado en la prueba de estrés del 10 nov). Ahora: cola propia con tope (1.500) y caducidad
// (lo que lleva más de 0,25 s de atraso se descarta sin dibujar). main.js la atiende en cada cuadro.
const visuales = [];
const MAX_VISUALES = 1500;
function programarVisual(fn, time) {
  visuales.push({ fn, time });
  if (visuales.length > MAX_VISUALES) visuales.splice(0, visuales.length - MAX_VISUALES);
}
export function atenderVisuales() {
  if (!iniciado || !visuales.length) return;
  const ahora = tiempoAudible(); // el instante del audio que está saliendo por el parlante ahora
  let quedan = 0;
  for (let i = 0; i < visuales.length; i++) {
    const v = visuales[i];
    if (v.time > ahora) { visuales[quedan++] = v; continue; }
    if (ahora - v.time < 0.25) { try { v.fn(); } catch (e) { console.error(e); } }
  }
  visuales.length = quedan;
}
export function fijarFantasmas(fn) { alFantasma = fn; }

const acordeMidi = (grado, p) => DISPOSICION[etapaVoicing(p.voicing ?? 0)](ACORDE.map((d) => gradoAMidi(grado + d, 3)).sort((a, b) => a - b));

function quitarVozNodos(id) {
  const voz = voces.get(id);
  if (!voz) return;
  voz.loop.dispose();
  voz.vigilante.port.onmessage = null;
  // se da tiempo a que terminen las colas de las notas antes de desconectar
  salida.quitarEspacial(voz.espacial);
  setTimeout(() => {
    for (const nodo of [voz.synth, voz.filtro, voz.volumen, voz.phaser, voz.envioReverb, voz.envioDelay, voz.envioWash]) {
      try { nodo?.dispose(); } catch { /* ya estaba roto: se descarta igual */ }
    }
    voz.vigilante.port.postMessage('fin');
    voz.vigilante.disconnect();
  }, 300);
  voces.delete(id);
}

// =====================================================================
// VIGILANTE de cada módulo. El worklet (vigilante.worklet.js) limpia la salida del módulo y cada
// ~100 ms manda su pico y cuántas muestras malas (NaN o infinitas) tuvo. Aquí se decide:
//  · muestras malas → la cadena está rota: se reconstruye de inmediato;
//  · silencio (pico < −100 dBFS) en 3 avisos seguidos (~0,3 s) en los que DEBÍA sonar (había una nota
//    en curso) → se reconstruye. La percusión: 3 golpes seguidos sin sonido;
//  · 3 errores de Tone en menos de 2 s (al aplicar parámetros, al tocar o en el LFO) → se reconstruye.
// Reconstruir = soltar sus nodos y crear la cadena nueva con los mismos datos, posición y fundido, sin
// tocar los demás módulos (cada uno tiene su propia cadena; los efectos compartidos no se tocan).
// Se anota en el registro de misión (main.js, fijarAvisoVigilante).
// =====================================================================
const SILENCIO = 1e-5; // −100 dBFS: por debajo, con una nota en curso, cuenta como mudo (un sonido muy apagado pero real, p. ej. el filtro al mínimo con ataque largo, queda por encima)
const estadisticas = new Map(); // id → { notas, reconstrucciones, motivos[], picoMax, avisos, malas }
const statsDe = (id) => {
  if (!estadisticas.has(id)) estadisticas.set(id, { notas: 0, reconstrucciones: 0, motivos: [], picoMax: 0, avisos: 0, malas: 0, silencioMax: 0, errores: 0, ventana: { pico: 0, notas: 0, malas: 0 } });
  return estadisticas.get(id);
};
let alVigilante = () => {};
export function fijarAvisoVigilante(fn) { alVigilante = fn; }

// Una nota empieza en t y dura d: entre t + 30 ms y t + d el módulo debe sonar.
function esperarSonido(voz, t, d) {
  // notas: desde 30 ms después de empezar (el ataque arranca en 0) hasta que se suelta
  if (t > voz.esperaHasta + 0.05) voz.esperaDesde = t + 0.03;
  voz.esperaHasta = Math.max(voz.esperaHasta, t + Math.max(d, 0.03));
  const st = statsDe(voz.id);
  st.notas++; st.ventana.notas++;
}
function revisarVoz(id, voz, { pico, malas, t }) {
  if (voces.get(id) !== voz) return; // ya se reemplazó
  const st = statsDe(id);
  st.avisos++;
  if (pico > st.picoMax) st.picoMax = pico;
  if (pico > st.ventana.pico) st.ventana.pico = pico;
  st.ventana.malas += malas;
  if (malas > 0) { st.malas += malas; return reconstruir(id, 'valores NaN en la salida'); }
  // su secuenciador (Tone.Loop) dejó de llamar: el bucle murió → se reconstruye
  const inst = instrumentos.get(id);
  const paso = Tone.Ticks(TICKS[inst?.subdivision] || TICKS.semicorchea).toSeconds();
  if (Tone.getTransport().state === 'started' && performance.now() - (voz.ultimoPaso ?? voz.creada) > 1500 + 2000 * paso) {
    return reconstruir(id, 'su secuenciador se detuvo');
  }
  if (fundidos.has(id)) { voz.silencios = 0; voz.golpesMudos = 0; voz.golpes = []; return; }
  const mudo = pico < SILENCIO;
  if (inst?.tipo === 'percusion') {
    // cada golpe se juzga con el aviso que contiene sus primeros milisegundos; 2 golpes mudos seguidos
    // (cada uno empieza desde 0 y suena fuerte al instante) = cadena rota
    const golpes = voz.golpes || [];
    let k = 0;
    while (k < golpes.length && golpes[k] <= t - 0.008) {
      if (golpes[k] >= t - 0.1) voz.golpesMudos = mudo ? (voz.golpesMudos || 0) + 1 : 0;
      k++;
    }
    golpes.splice(0, k);
    st.silencioMax = Math.max(st.silencioMax, voz.golpesMudos || 0);
    if (voz.golpesMudos >= 2) { voz.golpesMudos = 0; reconstruir(id, 'silencio cuando debía sonar'); }
    return;
  }
  // notas: solo cuentan los avisos que caen por completo dentro de una nota en curso
  const dentro = t - 0.1 >= voz.esperaDesde && t <= voz.esperaHasta - 0.02;
  if (!mudo) { voz.silencios = 0; return; }
  if (!dentro) return;
  voz.silencios++;
  st.silencioMax = Math.max(st.silencioMax, voz.silencios);
  if (voz.silencios >= 3) reconstruir(id, 'silencio cuando debía sonar'); // ~0,3 s
}
function fallo(id, voz, e) {
  const ahora = performance.now();
  voz.fallos = (voz.fallos || []).filter((t) => ahora - t < 2000);
  voz.fallos.push(ahora);
  statsDe(id).errores = (statsDe(id).errores || 0) + 1;
  if (voz.fallos.length >= 3) reconstruir(id, 'errores de audio (' + String(e?.message || e).slice(0, 60) + ')');
}
function reconstruir(id, motivo) {
  const inst = instrumentos.get(id), vieja = voces.get(id);
  if (!inst || !vieja) return;
  if (performance.now() - (vieja.creada || 0) < 800) return; // recién hecha: se le da un momento
  const st = statsDe(id);
  st.reconstrucciones++;
  st.motivos.push(motivo);
  // para depurar: con qué parámetros estaba
  const p = inst.parametros;
  st.contexto = { motivo, filtro: p.filtro, lfoFiltro: p.lfoFiltro, envolvente: p.envolvente, lfoEnv: p.lfoEnv, octava: p.octava, fx: p.fx, cantidad: p.cantidad, pasos: inst.pasos, subdivision: inst.subdivision, tempo };
  quitarVozNodos(id);
  crearVoz(inst);
  alVigilante(id, inst.tipo, motivo);
}
export const estadoVigilante = () => [...estadisticas].map(([id, s]) => ({ id, tipo: instrumentos.get(id)?.tipo, ...s, motivos: s.motivos.slice(-3), ventana: undefined }));
// Lo medido desde la última llamada (pico, notas y muestras malas por módulo); empieza una ventana nueva.
export function medirVentana() {
  const r = {};
  for (const [id, s] of estadisticas) { r[id] = { ...s.ventana, tipo: instrumentos.get(id)?.tipo, fundido: fundidos.has(id) }; s.ventana = { pico: 0, notas: 0, malas: 0 }; }
  return r;
}
// Solo para la prueba de estrés: estropear a propósito la cadena de un módulo (NaN o silencio)
export function _estropear(id, como) {
  const voz = voces.get(id);
  if (!voz) return;
  if (como === 'nan') { // +∞ y −∞ sumados = NaN, inyectado en la cadena del módulo (antes del vigilante)
    const c = Tone.getContext().rawContext, n = new ConstantSourceNode(c, { offset: 3e38 });
    n.connect(new GainNode(c, { gain: 3e38 })).connect(voz.vigilante);
    n.connect(new GainNode(c, { gain: -3e38 })).connect(voz.vigilante);
    n.start(); setTimeout(() => n.stop(), 400);
  }
  else voz.volumen.disconnect(); // como un nodo que se desconecta: el módulo queda mudo
}

// =====================================================================
// API para main.js
// =====================================================================

export const audioIniciado = () => iniciado;

// Efectos compartidos en el bus maestro. Cada instrumento decide cuánto les envía.
const segundosDelay = (bpm) => (60 / bpm) * 0.75; // corchea con puntillo = 3/4 de negra
function crearEfectos() {
  // reverb larga y espacial; el pasaaltos evita que los graves la emborronen.
  // decay 12 en Tone.js da una cola real de unos 3,5–4 s (cae ~17 dB por segundo, medido):
  // el decay de Tone es el largo de la respuesta al impulso, no el tiempo que se oye la cola.
  const reverb = new Tone.Reverb({ decay: 12, preDelay: 0.03, wet: 1 });
  const corteReverb = new Tone.Filter(180, 'highpass');
  const retornoReverb = new Tone.Gain(0.7);
  reverb.chain(corteReverb, retornoReverb, salida.busEfectos());
  // delay en corchea con puntillo, feedback moderado; el pasabajos oscurece cada repetición
  const delay = new Tone.FeedbackDelay({ delayTime: segundosDelay(tempo), feedback: 0.35, wet: 1, maxDelay: 2 });
  const corteDelay = new Tone.Filter(3500, 'lowpass');
  const retornoDelay = new Tone.Gain(0.55);
  delay.chain(corteDelay, retornoDelay, salida.busEfectos());
  // Reverb larga del FINAL (el "wash"): unos 8 s de cola. Se crea al encender el audio, no en plena
  // función. Respuesta al impulso propia: ruido estéreo (los dos lados distintos) con una caída
  // exponencial que llega a −60 dB a los 8 s, una subida de 20 ms y algo más oscura hacia el final.
  const ctx = Tone.getContext().rawContext, sr = ctx.sampleRate, largo = Math.round(sr * 8.5);
  const ir = ctx.createBuffer(2, largo, sr);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let previo = 0;
    for (let i = 0; i < largo; i++) {
      const t = i / sr, caida = Math.exp(-6.9 * t / 8), subida = Math.min(1, t / 0.02);
      const oscuro = 0.35 + 0.6 * Math.exp(-t / 3); // pasabajos de un polo que se cierra con el tiempo
      previo += oscuro * ((Math.random() * 2 - 1) - previo);
      d[i] = previo * caida * subida;
    }
  }
  let energia = 0;
  for (let c = 0; c < 2; c++) for (const v of ir.getChannelData(c)) energia += v * v;
  const escalaIr = 1 / Math.sqrt(energia / 2); // misma energía que un impulso unidad
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < largo; i++) d[i] *= escalaIr; }
  const wash = new ConvolverNode(ctx, { buffer: ir, disableNormalization: true });
  const corteWash = new Tone.Filter(160, 'highpass');
  const retornoWash = new Tone.Gain(0.6);
  Tone.connect(wash, corteWash);
  corteWash.chain(retornoWash, salida.busEfectos());
  return { reverb, delay, wash, retornos: { reverb: [retornoReverb, 0.7], delay: [retornoDelay, 0.55], wash: [retornoWash, 0.6] } };
}

// =====================================================================
// FINAL DE LA OBRA: "WASH" DE REVERB Y DELAY (main.js llama iniciarFinal con obra:final)
// Durante el fundido (D s, 20 por defecto), en todos los módulos:
//  · los envíos a la reverb del final y al delay suben hasta un nivel alto en la primera mitad,
//    aunque el módulo tenga otro efecto (su efecto propio, p. ej. el phaser, sigue);
//  · el sonido directo se apaga del todo a lo largo de los D s: quedan las colas;
//  · el feedback del delay sube de 0,35 a 0,7 (nunca más) en la primera mitad;
//  · desde la mitad, los secuenciadores ya no disparan notas nuevas.
// Después se deja sonar las colas COLA_FINAL s y la salida va a silencio total (telón, y los retornos
// de los efectos a 0, así también queda en silencio la grabación). REABRIR lo deshace (reabrirFinal).
// =====================================================================
const COLA_FINAL = 8, ENVIO_WASH = 1, ENVIO_DELAY_FINAL = 0.6;
let lavado = null; // { t0, corte, fin } en tiempo de audio
let relojTelon = null;
function rampaA(param, valor, hasta) {
  const ahora = Tone.now();
  param.cancelScheduledValues(ahora);
  param.setValueAtTime(param.getValueAtTime(ahora), ahora);
  param.linearRampToValueAtTime(valor, Math.max(hasta, ahora + 0.02));
}
function lavarVoz(voz, restante) {
  rampaA(voz.envioWash.gain, ENVIO_WASH, lavado.corte);
  rampaA(voz.envioDelay.gain, ENVIO_DELAY_FINAL, lavado.corte);
  salida.fundirSeco(voz.espacial, 0, restante ?? Math.max(0.05, lavado.fin - Tone.getContext().currentTime));
}
export function iniciarFinal(duracion) {
  if (!iniciado || lavado) return;
  const D = entre(+duracion, 2, 300, 20);
  const t0 = Tone.getContext().currentTime;
  lavado = { t0, corte: t0 + D / 2, fin: t0 + D };
  rampaA(efectos.delay.feedback, FEEDBACK_FINAL, lavado.corte);
  for (const voz of voces.values()) lavarVoz(voz, D);
  clearTimeout(relojTelon);
  relojTelon = setTimeout(() => { // colas sonando COLA_FINAL s → silencio total
    for (const [g] of Object.values(efectos.retornos)) g.gain.rampTo(0, 2);
    salida.fijarTelon(0, 2);
  }, (D + COLA_FINAL) * 1000);
}
export function reabrirFinal() {
  clearTimeout(relojTelon);
  if (!iniciado) return;
  lavado = null;
  rampaA(efectos.delay.feedback, FEEDBACK, Tone.now() + 0.3);
  for (const [g, v] of Object.values(efectos.retornos)) g.gain.rampTo(v, 0.3);
  salida.fijarTelon(1, 0.5);
  for (const [id, voz] of voces) {
    voz.envioWash.gain.rampTo(0, 0.1);
    salida.fundirSeco(voz.espacial, 1, 0.1);
    aplicarVoz(id);
  }
}
export const enFinal = () => !!lavado;

// Primer clic del usuario: los navegadores exigen un gesto para encender el audio.
// El AudioContext lo crea salida.js (48 kHz, salida elegida, canales discretos) y Tone.js lo usa.
let encendiendo = null;
export function iniciarAudio() {
  encendiendo ||= encender();
  return encendiendo;
}
async function encender() {
  salida.contexto();
  await Tone.start();
  await salida.prepararSalida(); // dispositivo, canales, limitador enlazado y medidores
  const ctx = Tone.getContext().rawContext;
  await ctx.audioWorklet.addModule(urlVigilante);
  corteMax = Math.min(20000, ctx.sampleRate * 0.45);
  const transport = Tone.getTransport();
  transport.PPQ = PPQ;
  transport.bpm.value = tempo;
  efectos = crearEfectos();
  await efectos.reverb.ready; // la reverb calcula su respuesta al impulso al crearse
  iniciado = true;
  for (const id of instrumentos.keys()) crearVoz(instrumentos.get(id));
  controlLfo = new Tone.Loop(modularContinuo, '128n').start(0); // control de los LFO continuos
  transport.start('+0.1');
  setInterval(vigilarReloj, 500);
  setTimeout(alinearTransporte, 300);
  setInterval(alinearTransporte, 1000);
}

// Vigilante del reloj: si el control de los LFO dejó de correr, se rehace; si la posición del reloj
// dejó de avanzar o no es un número, se reinicia el reloj (los módulos siguen con sus datos).
let controlLfo = null, ultimosTicks = -1, quietoDesde = 0;
function vigilarReloj() {
  const tr = Tone.getTransport();
  if (tr.state !== 'started') return;
  const ahora = performance.now();
  let ticks;
  try { ticks = tr.ticks; } catch { ticks = NaN; }
  if (!Number.isFinite(ticks) || ticks === ultimosTicks) {
    quietoDesde ||= ahora;
    if (ahora - quietoDesde > 1000) {
      quietoDesde = 0;
      tr.stop();
      tr.bpm.cancelScheduledValues(0);
      tr.bpm.value = tempo;
      tr.start('+0.05');
      alVigilante(null, null, 'el reloj de la música se detuvo y se reinició');
    }
  } else quietoDesde = 0;
  ultimosTicks = ticks;
  if (ahora - ultimoControl > 1000 && controlLfo) {
    controlLfo.dispose();
    controlLfo = new Tone.Loop(modularContinuo, '128n').start(tr.ticks + 'i');
    ultimoControl = ahora;
    estadisticasReloj.controlRehecho++;
    alVigilante(null, null, 'el control de los LFO se detuvo y se rehízo');
  }
}
const estadisticasReloj = { controlRehecho: 0 };
export const estadoReloj = () => ({ ...estadisticasReloj });

// Silencio personal: solo afecta lo que escucha esta persona.
export const silenciar = salida.silenciar;
export const silenciado = salida.silenciado;

export function fijarReaccion(fn) { alPaso = fn; }

// Tempo: cambio INSTANTÁNEO del reloj, y solo si cambió. (Antes era bpm.rampTo cada vez que se
// refrescaba la telemetría, aunque el tempo fuera el mismo: Tone calcula mal la posición durante rampas
// encadenadas del reloj (NaN) y entonces no podía programar la siguiente repetición de un bucle, que
// moría para siempre: el módulo dejaba de sonar o el LFO del filtro se quedaba quieto. Encontrado en la
// prueba de estrés del 10 nov: "Cannot read properties of undefined (reading 'time')" en Clock._loop.)
export function fijarTempo(bpm) {
  bpm = entre(+bpm, 40, 240, tempo);
  if (bpm === tempo && iniciado && Tone.getTransport().bpm.value === bpm) return;
  tempo = bpm;
  if (!iniciado) return;
  const tr = Tone.getTransport();
  tr.bpm.cancelScheduledValues(Tone.now());
  tr.bpm.setValueAtTime(bpm, Tone.now());
  efectos.delay.delayTime.rampTo(segundosDelay(bpm), 0.15); // el delay sigue al tempo
  alinearTransporte(); // y la posición vuelve a coincidir con el pulso del servidor
}

// =====================================================================
// ALINEACIÓN CON EL RELOJ COMPARTIDO (reloj.js). Lo que importa es lo que SE OYE: con
// getOutputTimestamp el navegador dice qué instante del audio está saliendo por el parlante ahora
// (incluye la latencia de salida). Para un instante C del audio un poco en el futuro: se calcula a
// qué hora del servidor se va a oír, qué pulso corresponde a esa hora (el ancla del servidor) y se
// compara con el pulso del Transport en C. Si difieren más de 3 ms, se corrige la posición del
// Transport en C (y se reinician sus bucles para que sigan en la cuadrícula, como hace Tone al mover
// la posición). Se revisa cada segundo y en cada cambio de tempo o de ancla.
// =====================================================================
function tiempoAudible(ctx = Tone.getContext().rawContext) {
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.contextTime > 0 && ts.performanceTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
}
// instante del audio (s) → hora del servidor (ms) en que se oye
function horaServidorDe(C) {
  const ctx = Tone.getContext().rawContext;
  const ts = ctx.getOutputTimestamp?.();
  const local = ts && ts.contextTime > 0 && ts.performanceTime > 0
    ? ts.performanceTime + (C - ts.contextTime) * 1000
    : performance.now() + (C - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
  return performance.timeOrigin + local + (reloj.ahoraServidor() - (performance.timeOrigin + performance.now()));
}
const estadoAlineacion = { correcciones: 0, ultimoErrorMs: null };
function alinearTransporte() {
  if (!iniciado || !reloj.sincronizado()) return;
  const tr = Tone.getTransport();
  if (tr.state !== 'started' || !tr._clock?.setTicksAtTime) return;
  const b = reloj.bpm();
  if (b && Math.abs(tr.bpm.getValueAtTime(Tone.now()) - b) > 1e-6) { tempo = b; tr.bpm.cancelScheduledValues(Tone.now()); tr.bpm.setValueAtTime(b, Tone.now()); }
  const C = Tone.now() + 0.05;
  const objetivo = reloj.pulsosServidor(horaServidorDe(C)) * PPQ;
  const actual = tr.getTicksAtTime(C);
  if (!Number.isFinite(objetivo) || !Number.isFinite(actual)) return;
  const errorMs = (actual - objetivo) / PPQ * 60000 / (b || tempo);
  estadoAlineacion.ultimoErrorMs = +errorMs.toFixed(2);
  if (Math.abs(errorMs) <= 3) return;
  tr.emit('stop', C);
  tr._clock.setTicksAtTime(Math.max(objetivo, 0), C);
  tr.emit('start', C, tr._clock.getSecondsAtTime(C)); // los bucles (Tone.Loop) se reprograman desde ahí
  estadoAlineacion.correcciones++;
}
reloj.alCambiar(() => alinearTransporte());
// Para comparar dispositivos: a qué hora del servidor (ms) se oye el pulso número n (en negras).
export function horaDelPulso(n) {
  const tr = Tone.getTransport();
  if (!iniciado || !tr._clock) return null;
  const C = tr._clock._tickSource.getTimeOfTick(n * PPQ);
  return horaServidorDe(C);
}
export const diagnosticoAlineacion = () => ({ ...estadoAlineacion, reloj: reloj.diagnostico() });

export function fijarEscala(nueva) {
  escala = { tonica: nueva?.tonica in TONICAS ? nueva.tonica : 'C', modo: nueva?.modo in MODOS ? nueva.modo : 'eolico' };
}

// Agrega o actualiza un instrumento (siempre con sus datos completos).
export function ponerInstrumento(inst) {
  const nuevo = !instrumentos.has(inst.id);
  inst = limpiar(inst); // nada fuera de rango, NaN ni infinito
  instrumentos.set(inst.id, inst);
  if (!iniciado) return;
  if (nuevo) crearVoz(inst);
  else aplicarVoz(inst.id);
}

export function quitarInstrumento(id) {
  instrumentos.delete(id);
  estadisticas.delete(id);
  posiciones.delete(id);
  fundidos.delete(id);
  quitarVozNodos(id);
}

// Disolución: el sonido se apaga en "segundos"; al revivir vuelve en "segundos".
export function fundir(id, segundos, motivo) {
  const seco = motivo === 'final' && !!lavado; // en el final se apaga solo el directo (wash)
  fundidos.set(id, { hasta: performance.now() / 1000 + segundos, seco });
  const voz = voces.get(id);
  if (!voz) return;
  if (seco) lavarVoz(voz, segundos);
  else salida.fundirEspacial(voz.espacial, 0, segundos);
}
export function revivir(id, segundos = 1) {
  fundidos.delete(id);
  const voz = voces.get(id);
  if (voz) salida.fundirEspacial(voz.espacial, 1, segundos);
}

// Acento de un choque: el instrumento toca una nota propia en la siguiente subdivisión de su
// secuenciador (así cae a tiempo con la música). fuerza 0–1 = intensidad.
export function acento(id, fuerza) {
  const inst = instrumentos.get(id), voz = voces.get(id);
  if (!inst || !voz || fundidos.has(id)) return;
  try { acentoSeguro(inst, voz, entre(fuerza, 0, 1, 0.5)); } catch (e) { fallo(id, voz, e); }
}
function acentoSeguro(inst, voz, fuerza) {
  if (lavado) return;
  const tr = Tone.getTransport();
  const time = tr.nextSubdivision((TICKS[inst.subdivision] || TICKS.semicorchea) + 'i');
  const p = paraNota(inst, time);
  const vel = 0.35 + 0.55 * fuerza;
  if (inst.tipo === 'percusion') {
    golpePercusion(voz, p, time, vel);
  } else if (inst.tipo === 'armonia') {
    // una sola nota del acorde que esté sonando (o del primero del patrón)
    const grado = voz.ultimoGrado ?? inst.patron.find((g) => g !== null) ?? 0;
    const notas = acordeMidi(grado, p);
    const env = adsr(p.envolvente);
    voz.synth.tocar([midiAHz(notas[Math.floor(Math.random() * notas.length)])], 0.5 + env.release * 0.3, instanteLibre(voz, time), vel * 0.8, env);
  } else {
    const grados = inst.patron.filter((g) => g !== null);
    const grado = grados.length ? grados[Math.floor(Math.random() * grados.length)] : 0;
    voz.synth.tocar([midiAHz(gradoAMidi(grado, 4 + (p.octava ?? 0)))], 0.25, instanteLibre(voz, time), vel, adsr(p.envolvente));
  }
}

// Pulso común (negras desde el inicio): sincroniza los movimientos de los FX con el tempo.
// La parte visual usa el pulso del servidor en este instante (el mismo en todos los dispositivos, y el
// que se oye, porque el Transport está alineado a lo que sale por el parlante).
export function pulsos() {
  const p = reloj.pulsosServidor();
  if (p !== null && reloj.sincronizado()) return p;
  if (iniciado) return Tone.getTransport().ticks / PPQ;
  return performance.now() / 1000 * tempo / 60;
}

// Posición de la pieza en el plano → mezcla (estéreo o 5.1, según el modo de este computador).
export function posicionar(id, x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return; // una posición rota no llega a la mezcla
  posiciones.set(id, { x, z });
  const voz = voces.get(id);
  if (voz) salida.posicionar(voz.espacial, x, z);
}

// Solo para depurar desde la consola y para la prueba de estrés: nodos internos.
export const depuracion = () => ({ voces, instrumentos, Tone, efectos });
