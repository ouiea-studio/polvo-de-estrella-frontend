// Cada parámetro mueve la gema de una forma distinta (sin que la escena se vuelva caótica):
//  · Amplitud (Env) y Golpe → rotación: qué tan rápido arranca el giro con cada nota (el ataque del
//    macro) y cuánto se prolonga después (su release; en la percusión, el golpe).
//  · Filtro → gelatina: abierto = ondulación fina y rápida; cerrado = lenta, amplia y espesa, con un
//    rebote más elástico a medida que sube la resonancia.
//  · Phaser → una órbita pequeña al ritmo del phaser, proporcional a "Cantidad"; la posición resultante
//    también alimenta el paneo y el 5.1. (Reverb y delay ya no mueven la gema: tienen fantasmas, ver
//    fantasmas.js. El giro de "Espacio" lo calcula la física del servidor.)
//  · Voicing → expansión (cerrado = compacta, abierto = más grande).
//  · Tono (percusión) y octava (melodía) → tamaño: más agudo = más pequeña.

import * as THREE from 'three';
import { params } from './escena.js';
import { adsr } from './envolvente.js';

// Tamaño de la gema según sus parámetros. El servidor usa la MISMA fórmula para el radio de choque
// (backend/sala.js, escalaVisual): si cambia aquí, cambiar allá.
export function escalaVisual(inst) {
  const p = inst.parametros;
  if (inst.tipo === 'percusion') return 2 ** (-(p.pitch || 0) / 12 * 0.35); // ±12 semitonos → 1,27 a 0,78
  if (inst.tipo === 'melodia') return [1.2, 1, 0.83][(p.octava || 0) + 1];
  return 0.9 + 0.4 * (p.voicing || 0);                                        // cerrado 0,9 → abierto 1,3
}

const mezcla = THREE.MathUtils.lerp;
// Gelatina propia de la pieza. Percusión: los valores generales (ajustes.json).
export function gelatinaDe(inst) {
  const g = params.gelatina;
  if (inst.tipo === 'percusion') return { ...g, frecuencia: 1 };
  const f = inst.parametros.filtro ?? 0.5;              // 0 cerrado → 1 abierto
  const q = (0.7 + 7.3 * (1 - f) ** 2 - 0.7) / 7.3;     // resonancia normalizada 0–1 (la misma curva que el audio)
  return {
    ondulacion: g.ondulacion * mezcla(2.6, 0.6, f),     // cerrado: amplia
    velocidad: g.velocidad * mezcla(0.45, 2.2, f),      // abierto: rápida
    frecuencia: mezcla(0.6, 1.8, f),                    // abierto: fina
    rigidez: g.rigidez * mezcla(1, 0.45, q),            // más resonancia → más elástica
    amortiguacion: g.amortiguacion * mezcla(1, 0.28, q),
  };
}

// Giro: cada nota suma un impulso; el giro lo alcanza con la constante "ataque" y el impulso se apaga
// con la constante "release" (segundos).
export function tiemposGiro(inst) {
  const p = inst.parametros;
  if (inst.tipo === 'percusion') return { ataque: 0.03, release: 0.12 + (p.decay ?? 0.3) * 1.5, impulso: 1.3 };
  const e = adsr(p.envolvente);
  return { ataque: 0.03 + e.attack * 0.5, release: 0.15 + e.release * 0.6, impulso: 1.1 };
}

// Desplazamiento por FX (x, y, z) en unidades del plano: solo el phaser. pulsos = negras del tempo común.
export function desplazamientoFx(inst, semilla, t, pulsos, out) {
  const p = inst.parametros, A = 0.45 * (p.cantidad ?? 0), s = semilla * 6.283;
  out.set(0, 0, 0);
  if (A <= 0) return out;
  if (p.fx === 'phaser') {
    // una vuelta cada dos compases, como el LFO del phaser
    const a = Math.PI * 2 * pulsos / 8 + s;
    out.set(A * Math.cos(a), 0, A * Math.sin(a));
  }
  return out;
}
