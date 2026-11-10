// Amplitud (Env): un solo deslizador (0 = corto, 1 = largo) que mueve los cuatro valores del ADSR a la
// vez, con curvas exponenciales (el oído percibe los tiempos así):
//   0 → pluck: ataque ~2 ms, decay ~120 ms, sustain ~0,15, release ~80 ms
//   1 → pad:   ataque ~2 s,  decay ~1,5 s,  sustain ~0,9,  release ~4 s
// En el medio (0,5): ataque ~63 ms, decay ~0,42 s, sustain ~0,5, release ~0,57 s.
// Lo usan audio.js (sonido) y movimiento.js (la rotación de la gema sigue al ataque y al release).

const exp = (a, b, e) => a * (b / a) ** e;
export function adsr(e) {
  const v = Math.min(Math.max(e ?? 0.5, 0), 1);
  return {
    attack: exp(0.002, 2, v),
    decay: exp(0.12, 1.5, v),
    sustain: 0.15 + 0.75 * v ** 0.8, // sube un poco antes: a media carrera ya sostiene
    release: exp(0.08, 4, v),
  };
}

// Armonía: hacia la derecha cada acorde se liga hasta el siguiente (0 = nada, 1 = del todo), para que
// el ataque largo alcance a crecer aunque los pasos sean cortos.
export function ligado(e) {
  const t = Math.min(Math.max(((e ?? 0) - 0.45) / 0.35, 0), 1);
  return t * t * (3 - 2 * t);
}
