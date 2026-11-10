// Fantasmas: la representación visual de los efectos.
//  · DELAY: cada repetición del eco genera una "gema fantasma", una copia translúcida en el lugar donde
//    estaba la gema, en el instante exacto del eco (lo programa audio.js a tiempo con el audio). Se agranda y se
//    desvanece; cada repetición es más tenue que la anterior según el feedback. La Cantidad da la intensidad.
//  · REVERB: con cada nota, una nube de partículas brillantes con la silueta de la gema, muy gelatinosa:
//    respira (se expande y se contrae), pierde la estructura y se disuelve como bruma durante la cola de
//    la reverb. La Cantidad da su tamaño, su densidad de partículas y su duración.
//  · PHASER: un halo translúcido un poco más grande que la gema, presente mientras el phaser esté activo,
//    muy gelatinoso (ondas, silueta deformada, corrimiento iridiscente) al ritmo del barrido del phaser.
//    La Cantidad da la intensidad de la deformación y la visibilidad. (La órbita la sigue haciendo
//    movimiento.js.)
// Rendimiento: materiales simples (contorno brillante o puntos, mezcla aditiva; nada de vidrio con
// transmisión), la misma geometría de la gema (no se copia), grupos fijos que se reutilizan y límites
// globales: 24 ecos del delay, 12 halos del phaser y 8 nubes de reverb de 900 partículas (7.200 en total).

import * as THREE from 'three';
import { scene, escalaPuntos } from './escena.js';
import { geometriaPolvoDe } from './gemas.js';

const MAX_GEMAS = 24;
const MAX_NUBES = 8;
const MAX_POR_GEMA = { delay: 6, reverb: 2 };
const blanco = new THREE.Color(1, 1, 1);

// =====================================================================
// Gemas fantasma del delay: la malla de la gema con un contorno brillante
// =====================================================================
const vertexContorno = /* glsl */`
  uniform float uEscala;
  varying float vBorde;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position * uEscala, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vBorde = 1.0 - abs(dot(n, normalize(-mv.xyz))); // brilla más en el contorno
    gl_Position = projectionMatrix * mv;
  }`;
const fragmentContorno = /* glsl */`
  uniform vec3 uColor;
  uniform float uBrillo;
  varying float vBorde;
  void main() {
    float a = 0.03 + 0.97 * pow(vBorde, 2.6); // casi vacío por dentro, luz en el contorno
    gl_FragColor = vec4(uColor * a * uBrillo, 1.0);
  }`;

// Grupo fijo de mallas reutilizables. Como la nube y el polvo, el material NO es "transparent" pero
// usa mezcla aditiva: así se ve también a través del vidrio de las gemas.
const gemasF = [];
function lugarGema() {
  let l = gemasF.find((x) => !x.activo);
  if (!l && gemasF.length < MAX_GEMAS) {
    const material = new THREE.ShaderMaterial({
      vertexShader: vertexContorno, fragmentShader: fragmentContorno,
      uniforms: { uEscala: { value: 1 }, uBrillo: { value: 0 }, uColor: { value: new THREE.Color() } },
      transparent: false, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const malla = new THREE.Mesh(undefined, material);
    Object.assign(malla, { matrixAutoUpdate: false, frustumCulled: false, visible: false });
    scene.add(malla);
    l = { malla, material, activo: false, edad: 0, vida: 1 };
    gemasF.push(l);
  }
  // sin lugar libre: se reutiliza el eco más viejo
  return l || gemasF.reduce((a, b) => (!a || a.edad / a.vida < b.edad / b.vida ? b : a), null);
}
function usarGema(l, tipo, gema, color) {
  if (!gema.malla.geometry.attributes.normal) gema.malla.geometry.computeVertexNormals();
  Object.assign(l, { activo: true, tipo, gema, edad: 0 });
  l.malla.geometry = gema.malla.geometry;
  l.material.uniforms.uColor.value.set(color).lerp(blanco, 0.45);
  l.malla.visible = true;
}
function soltarGema(l) { l.activo = false; l.malla.visible = false; l.gema = null; }

// =====================================================================
// Nubes de la reverb: los puntos de la superficie de la gema, muy gelatinosos
// =====================================================================
const vertexNube = /* glsl */`
  attribute vec3 aAzar;
  attribute float aSemilla;
  uniform float uT;        // avance 0–1 de su vida
  uniform float uEdad;     // segundos
  uniform float uTam;      // tamaño (Cantidad)
  uniform float uDensidad; // fracción de partículas visibles (Cantidad)
  uniform float uEscala;
  varying float vBrillo;
  varying float vTono;
  void main() {
    vec3 p = position;
    float t = uT;
    // respira: se expande y se contrae, y además se abre poco a poco
    float respira = 1.0 + uTam * (0.12 + 0.55 * t) + 0.09 * sin(uEdad * 4.2 + aSemilla * 2.0) * (1.0 - t);
    p *= respira;
    // gelatina muy blanda: ondas lentas que deforman la silueta y la van deshaciendo
    float blando = 0.06 + 0.55 * pow(t, 1.1);
    vec3 q = p * 2.3 + aAzar * 1.7;
    p += blando * vec3(sin(q.y + uEdad * 1.3), sin(q.z * 1.2 - uEdad * 1.1), sin(q.x * 0.9 + uEdad * 0.9));
    p += aAzar * t * t * 0.9;                       // al final se dispersa como bruma
    float visible = step(aSemilla, uDensidad);
    vBrillo = visible * smoothstep(0.0, 0.08, t) * pow(1.0 - t, 1.6);
    vTono = aSemilla;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = visible * (0.03 + 0.05 * t) * (0.5 + aSemilla) * uEscala / -mv.z; // la bruma engorda
    gl_Position = projectionMatrix * mv;
  }`;
const fragmentNube = /* glsl */`
  uniform vec3 uColor;
  uniform float uBrillo;
  varying float vBrillo;
  varying float vTono;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, r);
    vec3 col = mix(uColor, vec3(1.0), 0.35 + 0.4 * vTono);
    gl_FragColor = vec4(col * a * a * vBrillo * uBrillo, 1.0);
  }`;
const nubes = [];
function lugarNube(geo) {
  let l = nubes.find((x) => !x.activo);
  if (!l && nubes.length < MAX_NUBES && geo) {
    const material = new THREE.ShaderMaterial({
      vertexShader: vertexNube, fragmentShader: fragmentNube,
      uniforms: {
        uT: { value: 0 }, uEdad: { value: 0 }, uTam: { value: 1 }, uDensidad: { value: 1 },
        uEscala: { value: escalaPuntos() }, uBrillo: { value: 1 }, uColor: { value: new THREE.Color() },
      },
      transparent: false, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const puntos = new THREE.Points(geo, material);
    Object.assign(puntos, { matrixAutoUpdate: false, frustumCulled: false, visible: false });
    scene.add(puntos);
    l = { puntos, material, activo: false, edad: 0, vida: 1 };
    nubes.push(l);
  }
  return l || (nubes.length ? nubes.reduce((a, b) => (a.edad / a.vida > b.edad / b.vida ? a : b)) : null);
}

// =====================================================================
// API
// =====================================================================
// tipo: 'delay' | 'reverb' · gema: la de gemas.js · tipoGema: percusion/armonia/melodia
// fuerza: 0–1 (delay: Cantidad × feedback^k; reverb: Cantidad)
export function lanzar(tipo, gema, color, fuerza, tipoGema) {
  if (tipo === 'reverb') {
    const geo = geometriaPolvoDe(tipoGema);
    const suyas = nubes.filter((l) => l.activo && l.gema === gema);
    const l = suyas.length >= MAX_POR_GEMA.reverb ? suyas.reduce((a, b) => (a.edad > b.edad ? a : b)) : lugarNube(geo);
    if (!l || !geo) return;
    if (l.puntos.geometry !== geo) l.puntos.geometry = geo;
    // la Cantidad da el tamaño, la densidad de partículas y la duración (de ~2 a ~4,5 s)
    Object.assign(l, { activo: true, gema, edad: 0, vida: 2 + 2.5 * fuerza });
    const u = l.material.uniforms;
    u.uTam.value = 0.4 + 0.9 * fuerza;
    u.uDensidad.value = 0.3 + 0.7 * fuerza;
    u.uBrillo.value = 0.55 + 0.6 * fuerza;
    u.uColor.value.set(color);
    l.puntos.visible = true;
    return;
  }
  const suyos = gemasF.filter((l) => l.activo && l.gema === gema && l.tipo === 'delay');
  const l = suyos.length >= MAX_POR_GEMA.delay ? suyos.reduce((a, b) => (a.edad > b.edad ? a : b)) : lugarGema();
  if (!l) return;
  usarGema(l, 'delay', gema, color);
  Object.assign(l, { fuerza, vida: 0.7 });
  l.malla.matrix.copy(gema.malla.matrixWorld); // queda donde estaba la gema al sonar el eco
  l.malla.matrixWorldNeedsUpdate = true;
}

// PHASER: un halo, una copia translúcida de la gema un poco más grande, presente mientras el phaser
// esté activo. Muy gelatinoso, como una alucinación: ondas que recorren la superficie, la silueta se
// deforma de forma orgánica (y se tuerce) y el color se corre un poco hacia el iridiscente. El ritmo
// sigue el barrido del phaser (una vuelta cada 2 compases = 8 negras): las ondas van en múltiplos
// enteros de esa fase y se abren más cuando el barrido está arriba. Cantidad: intensidad de la
// deformación y visibilidad del halo. Se llama en cada cuadro por cada pieza (cantidad 0 = sin halo).
const vertexHalo = /* glsl */`
  uniform float uEscala;   // tamaño respecto de la gema
  uniform float uDef;      // intensidad de la deformación (Cantidad)
  uniform float uFase;     // fase del barrido del phaser (radianes)
  uniform float uBarrido;  // 0 cerrado → 1 abierto
  uniform float uT;        // tiempo (s), para la parte orgánica lenta
  varying float vBorde;
  varying float vOnda;
  void main() {
    vec3 p = position;
    float r = length(p) + 1e-4;
    vec3 dir = p / r;
    // ondas que recorren la superficie (a partir de la posición, no de la normal de la cara:
    // las aristas no se abren), en múltiplos de la fase del barrido
    float w1 = sin(dot(dir, vec3(0.8, 0.5, 0.33)) * 5.0 - uFase * 2.0 + uT * 0.7);
    float w2 = sin(dot(dir, vec3(-0.42, 0.88, 0.2)) * 7.0 + uFase * 3.0 - uT * 0.5);
    float w3 = sin(p.y * 6.0 - uFase * 4.0 + sin(p.x * 3.0 + uT));
    float onda = 0.5 * w1 + 0.3 * w2 + 0.2 * w3;
    // distorsión orgánica, grande y lenta, de la silueta
    float org = sin(p.x * 2.1 + uT * 0.9) * sin(p.z * 1.7 - uT * 0.6) * sin(p.y * 2.4 + uFase);
    float amp = uDef * (0.35 + 0.65 * uBarrido);
    p = dir * r * (uEscala + amp * (0.24 * onda + 0.34 * org));
    // torsión de gelatina alrededor del eje vertical
    float giro = amp * 0.55 * sin(p.y * 2.5 + uFase);
    float c = cos(giro), s = sin(giro);
    p.xz = mat2(c, -s, s, c) * p.xz;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vBorde = 1.0 - abs(dot(n, normalize(-mv.xyz)));
    vOnda = onda;
    gl_Position = projectionMatrix * mv;
  }`;
const fragmentHalo = /* glsl */`
  uniform vec3 uColor;
  uniform float uBrillo;
  uniform float uFase;
  uniform float uT;
  varying float vBorde;
  varying float vOnda;
  vec3 iris(float h) { return 0.5 + 0.5 * cos(6.2832 * (h + vec3(0.0, 0.33, 0.67))); }
  void main() {
    float a = 0.05 + 0.95 * pow(vBorde, 2.2);                     // translúcido, luz en el contorno
    float h = 0.6 * vBorde + 0.25 * vOnda + 0.08 * uFase + 0.03 * uT; // corrimiento iridiscente
    vec3 col = mix(uColor, iris(h), 0.32) * (0.75 + 0.35 * vOnda);  // bandas de luz que recorren
    gl_FragColor = vec4(col * a * uBrillo, 1.0);
  }`;
const MAX_HALOS = 12;
const halos = [];
const haloDe = new Map(); // gema → halo
let reloj = 0;
function lugarHalo() {
  let l = halos.find((x) => !x.activo);
  if (!l && halos.length < MAX_HALOS) {
    const material = new THREE.ShaderMaterial({
      vertexShader: vertexHalo, fragmentShader: fragmentHalo,
      uniforms: {
        uEscala: { value: 1.18 }, uDef: { value: 0 }, uFase: { value: 0 }, uBarrido: { value: 0 }, uT: { value: 0 },
        uBrillo: { value: 0 }, uColor: { value: new THREE.Color() },
      },
      transparent: false, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const malla = new THREE.Mesh(undefined, material);
    Object.assign(malla, { matrixAutoUpdate: false, frustumCulled: false, visible: false });
    scene.add(malla);
    l = { malla, material, activo: false, nivel: 0, objetivo: 0 };
    halos.push(l);
  }
  return l || null;
}
function soltarHalo(l) { l.activo = false; l.malla.visible = false; haloDe.delete(l.gema); l.gema = null; }

export function phaser(gema, color, cantidad, pulsos) {
  let l = haloDe.get(gema);
  if (!(cantidad > 0.02)) { if (l) l.objetivo = 0; return; } // se apaga con un fundido
  if (!l) {
    l = lugarHalo();
    if (!l) return; // límite global alcanzado
    if (!gema.malla.geometry.attributes.normal) gema.malla.geometry.computeVertexNormals();
    Object.assign(l, { activo: true, gema, nivel: 0 });
    l.malla.geometry = gema.malla.geometry;
    l.malla.visible = true;
    haloDe.set(gema, l);
  }
  l.objetivo = cantidad;
  l.visto = true;
  const fase = 2 * Math.PI * pulsos / 8;           // la misma vuelta que el LFO del phaser
  const barrido = 0.5 + 0.5 * Math.sin(fase);       // 0 cerrado → 1 abierto
  const u = l.material.uniforms;
  u.uColor.value.set(color).lerp(blanco, 0.3);
  u.uFase.value = fase;
  u.uBarrido.value = barrido;
  u.uEscala.value = 1.14 + 0.08 * barrido;          // un poco más grande que la gema, respira con el barrido
  l.malla.matrix.copy(gema.malla.matrixWorld);       // rodea a la gema (también en su órbita)
  l.malla.matrixWorldNeedsUpdate = true;
}

// Cada cuadro: los ecos crecen y se desvanecen; las nubes respiran y se disuelven; los fantasmas del
// phaser que nadie pidió en este cuadro (la pieza se fue o cambió de efecto) se sueltan.
export function animarFantasmas(dt) {
  for (const l of gemasF) {
    if (!l.activo) continue;
    if (!l.gema?.grupo.parent) { soltarGema(l); continue; } // la gema ya no está en la escena
    l.edad += dt;
    const t = l.edad / l.vida;
    if (t >= 1) { soltarGema(l); continue; }
    l.material.uniforms.uEscala.value = 1 + 0.55 * (1 - (1 - t) ** 2); // se agranda (rápido al principio)
    l.material.uniforms.uBrillo.value = 0.9 * l.fuerza * (1 - t) ** 2;  // y se desvanece
  }
  // halos del phaser: aparecen y se apagan con un fundido (~0,3 s); si nadie lo pidió en este cuadro
  // (la pieza se fue, se disuelve o cambió de efecto) se apaga
  reloj += dt;
  for (const l of halos) {
    if (!l.activo) continue;
    if (!l.gema?.grupo.parent) { soltarHalo(l); continue; }
    if (!l.visto) l.objetivo = 0;
    l.visto = false;
    l.nivel += (l.objetivo - l.nivel) * Math.min(1, dt * 4);
    if (l.objetivo === 0 && l.nivel < 0.01) { soltarHalo(l); continue; }
    const u = l.material.uniforms, c = l.nivel;
    u.uT.value = reloj;
    u.uDef.value = 0.2 + 0.8 * c;          // Cantidad → intensidad de la deformación
    u.uBrillo.value = 0.75 * c ** 0.8;     // y visibilidad del halo (0,1 → 0,12 · 1 → 0,75)
  }
  const e = escalaPuntos();
  for (const l of nubes) {
    if (!l.activo) continue;
    l.edad += dt;
    const t = l.edad / l.vida;
    if (t >= 1 || !l.gema.grupo.parent) { l.activo = false; l.puntos.visible = false; continue; }
    l.puntos.matrix.copy(l.gema.malla.matrixWorld); // la nube acompaña a la gema
    l.puntos.matrixWorldNeedsUpdate = true;
    const u = l.material.uniforms;
    u.uT.value = t; u.uEdad.value = l.edad; u.uEscala.value = e;
  }
}

export const visibles = () => ({
  gemas: gemasF.filter((l) => l.activo).length,
  halos: halos.filter((l) => l.activo).length,
  nubes: nubes.filter((l) => l.activo).length,
  particulas: nubes.filter((l) => l.activo).length * 900,
});
