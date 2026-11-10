// Gemas: material de diamante con gelatina y nube interior, y su polvo de estrella.
// Cada tipo (percusión, armonía, melodía) se carga una sola vez como plantilla;
// cada instrumento de la sala es una copia con su propio material, su propia nube, su propia
// gelatina (la mueve el filtro) y su polvo (aparece al disolverse).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { params, scene, lucesColor, destellos, escalaPuntos, entornos, PRESETS_VIDRIO } from './escena.js';

const ASSETS = import.meta.env.BASE_URL + 'assets/';
export const TIPOS = ['percusion', 'armonia', 'melodia'];
export const TALLAS = { percusion: 'Cubo', armonia: 'Trillón', melodia: 'Esfera' };
// Las gemas se inclinan hacia la cámara para que se lea su contorno (cuadrado, triángulo, círculo)
// mientras giran sobre su propio eje.
const INCLINACION = { percusion: 0.5, armonia: 0.85, melodia: 0.7 };

const vidrios = []; // materiales de diamante vivos
const nubes = [];   // materiales de nube vivos
const plantillas = {}; // tipo → { escena, material: datos de materiales.json, nubePos }

// =====================================================================
// VIDRIO iridiscente a partir de materiales.json
// =====================================================================

// Shader de gelatina: se inyecta en el material de vidrio para mover los vértices.
const gelGLSL = /* glsl */`
  uniform float uGelT;    // tiempo propio de la pieza
  uniform float uOnda;    // amplitud de la ondulación constante
  uniform float uFrec;    // finura de la ondulación: alta = ondas finas, baja = amplias y espesas
  uniform float uRebote;  // valor actual del resorte (positivo estira, negativo aplasta)
  // La deformación depende SOLO de la posición del vértice (no de la normal de su cara):
  // así los vértices que comparten una arista se mueven igual y no se abren grietas.
  vec3 gelatina(vec3 p) {
    float d = length(p);
    vec3 dir = p / max(d, 1e-4);
    float punta = d * d * 2.5; // cuánto más se mueve lo que está lejos del centro: exagera las puntas
    vec3 f = p * uFrec;
    float w = sin(f.x * 3.1 + uGelT * 1.3) + sin(f.y * 3.7 - uGelT * 1.1 + 1.3) + sin(f.z * 3.3 + uGelT * 0.9 + 2.1);
    vec3 q = p;
    q += dir * w * 0.333 * uOnda * (0.4 + punta);                 // respiración: las puntas se alargan y encogen
    q += vec3(sin(f.y * 4.0 + uGelT * 1.1), sin(f.z * 4.0 + uGelT * 0.9 + 1.0), sin(f.x * 4.0 + uGelT * 1.3 + 2.0))
         * uOnda * 0.6 * punta;                                    // vaivén lateral: las puntas se mecen
    q += dir * uRebote * (0.25 * sin(d * 9.0 + 1.0) * (0.3 + punta) + 0.3 * punta); // temblor del rebote
    q *= vec3(1.0 - 0.5 * uRebote, 1.0 + uRebote, 1.0 - 0.5 * uRebote);             // estirar y aplastar
    return q;
  }`;
function agregarGelatina(material, gel) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, gel);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + gelGLSL)
      .replace('#include <begin_vertex>', 'vec3 transformed = gelatina(position);');
  };
  material.customProgramCacheKey = () => 'gelatina-facetada';
}

function crearVidrio(m, gel) {
  const mat = new THREE.MeshPhysicalMaterial({
    // caras planas: la normal se calcula por cara en pantalla, así las facetas siguen nítidas al deformarse
    flatShading: true,
  });
  // De materiales.json se conserva el color propio de cada gema y su grosor de película
  // (420, 520 y 620 nm), que se usa para desfasar un poco la iridiscencia entre tipos.
  mat.userData.colorPropio = new THREE.Color().setRGB(...m.color, THREE.LinearSRGBColorSpace);
  mat.userData.desfaseIrid = m.iridescenceThicknessRange[1] / 520;
  agregarGelatina(mat, gel);
  aplicarVidrioA(mat);
  vidrios.push(mat);
  return mat;
}
function aplicarVidrioA(mat) {
  const v = params.vidrio;
  mat.envMap = entornos[v.entorno] || entornos.paleta;
  mat.color.set(v.colorCuerpo).lerp(mat.userData.colorPropio, v.tinteBase);
  mat.metalness = Math.min(v.metalicidad, 0.3); // más de 0.3 vuelve opaco el vidrio
  mat.roughness = v.rugosidad;
  mat.transmission = v.transmision;
  mat.specularIntensity = v.especular;
  mat.specularColor.set(v.colorEspecular);
  mat.iridescence = v.iridiscencia;
  mat.iridescenceIOR = v.iorIridiscencia;
  mat.iridescenceThicknessRange = [v.grosorIridMin, v.grosorIridMax * mat.userData.desfaseIrid];
  mat.clearcoat = v.clearcoat;
  mat.clearcoatRoughness = v.rugosidadClearcoat;
  mat.attenuationColor.set(v.colorAtenuacion);
  mat.attenuationDistance = v.distanciaAtenuacion;
  mat.envMapIntensity = v.reflejosEntorno;
  mat.ior = v.ior;
  mat.thickness = v.grosor;
  mat.dispersion = v.dispersion;
}
// Guarda los valores actuales del vidrio como el preset elegido en public/ajustes.json, y lo
// deja como material inicial (solo con `npm run dev`: lo hace el pequeño plugin de
// vite.config.js). Si no se puede, copia los valores al portapapeles.
export async function guardarMaterial() {
  const preset = params.presetVidrio;
  const valores = { ...params.vidrio };
  PRESETS_VIDRIO[preset] = { ...valores }; // volver a elegir el preset en el panel da lo guardado
  try {
    const r = await fetch('/__guardar-material', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preset, valores }),
    });
    if (r.ok) return 'archivo';
  } catch { /* sin servidor de desarrollo: se usa el portapapeles */ }
  await navigator.clipboard.writeText(JSON.stringify({ presetVidrio: preset, [preset]: valores }, null, 2));
  return 'portapapeles';
}

export function aplicarVidrio() {
  for (const mat of vidrios) aplicarVidrioA(mat);
  lucesColor.forEach((l) => (l.intensity = params.vidrio.lucesColor));
  destellos.forEach((l) => (l.intensity = params.vidrio.destellos));
}

// =====================================================================
// NUBE INTERIOR — partículas suaves con un shader que las hace fluir.
// Truco clave: el material NO es "transparent" (así Three.js lo dibuja en la
// pasada que el vidrio usa para refractar) pero sí usa mezcla aditiva.
// Por eso la nube se ve a través del vidrio y además se refracta.
// =====================================================================
const PARTICULAS = 1100;

const nubeVertex = /* glsl */`
  attribute float aSemilla;
  uniform float uT;        // tiempo propio de la nube (ya multiplicado por su velocidad)
  uniform float uDensidad; // 0 = casi vacía, 1 = llena
  uniform float uTamano;
  uniform float uEscala;
  uniform float uRebote;   // el mismo resorte de la gelatina, para que la nube se estire con el vidrio
  varying float vAlpha;
  varying float vTono;
  void main() {
    vec3 p = position;
    // deriva lenta: cada partícula flota un poco alrededor de su sitio
    vec3 q = p * 3.0 + aSemilla * 6.2831;
    p += 0.035 * vec3(
      sin(q.y + uT * 0.7) + sin(q.z * 1.7 - uT * 0.4),
      sin(q.z + uT * 0.6) + sin(q.x * 1.3 + uT * 0.5),
      sin(q.x + uT * 0.8) + sin(q.y * 1.5 - uT * 0.3));
    // jirones: un campo ondulante decide dónde hay nube y dónde hay vacío
    vec3 n = p * 4.5;
    float d = sin(n.x + uT * 0.5 + 1.7 * sin(n.y * 1.3 - uT * 0.3))
            + sin(n.y * 1.1 - uT * 0.4 + 1.7 * sin(n.z * 1.2 + uT * 0.2))
            + sin(n.z * 0.9 + uT * 0.3 + 1.7 * sin(n.x * 1.4 - uT * 0.25));
    d = d / 6.0 + 0.5;
    vAlpha = smoothstep(0.35, 0.8, d + (uDensidad - 0.5) * 0.7) * uDensidad * 2.0;
    vTono = d * 0.9 + length(p) * 0.6 + aSemilla * 0.12 + uT * 0.04;
    p *= vec3(1.0 - 0.5 * uRebote, 1.0 + uRebote, 1.0 - 0.5 * uRebote);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uTamano * (0.6 + aSemilla * 0.8) * uEscala / -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const nubeFragment = /* glsl */`
  uniform vec3 uColor;
  uniform float uIrid;
  uniform float uBrillo;
  varying float vAlpha;
  varying float vTono;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, r);
    a *= a;
    // paleta iridiscente que recorre el arcoíris según la posición y el tiempo
    vec3 arco = 0.5 + 0.5 * cos(6.2831 * (vTono + vec3(0.0, 0.33, 0.67)));
    vec3 col = mix(uColor, arco, uIrid);
    gl_FragColor = vec4(col * a * vAlpha * uBrillo, 1.0);
  }`;

// Puntos repartidos DENTRO de la forma (se calcula una vez por tipo). Se prueba cada punto
// candidato lanzando un rayo: si cruza la superficie un número impar de veces, está adentro.
const rayoInterior = new THREE.Raycaster();
const DIRECCION_PRUEBA = new THREE.Vector3(0.577, 0.211, 0.789).normalize();
const materialPrueba = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
function geometriaNube(malla) {
  const pos = new Float32Array(PARTICULAS * 3);
  const semillas = new Float32Array(PARTICULAS);
  const p = new THREE.Vector3(), mundo = new THREE.Vector3();
  malla.geometry.computeBoundingBox();
  const caja = malla.geometry.boundingBox;
  const tam = caja.getSize(new THREE.Vector3()), centro = caja.getCenter(new THREE.Vector3());
  malla.updateWorldMatrix(true, false);
  const materialOriginal = malla.material;
  malla.material = materialPrueba;
  let n = 0;
  for (let intento = 0; n < PARTICULAS && intento < PARTICULAS * 25; intento++) {
    p.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiply(tam).multiplyScalar(0.94).add(centro);
    rayoInterior.set(mundo.copy(p).applyMatrix4(malla.matrixWorld), DIRECCION_PRUEBA);
    if (rayoInterior.intersectObject(malla, false).length % 2 === 1) { pos.set([p.x, p.y, p.z], n * 3); n++; }
  }
  malla.material = materialOriginal;
  if (n === 0) { // respaldo: puntos de la superficie llevados hacia el centro
    const sampler = new MeshSurfaceSampler(malla).build();
    for (; n < PARTICULAS; n++) { sampler.sample(p); p.multiplyScalar(0.6 * Math.cbrt(Math.random())); pos.set([p.x, p.y, p.z], n * 3); }
  }
  for (let i = n; i < PARTICULAS; i++) { // si faltaron, se repiten puntos ya aceptados
    const j = Math.floor(Math.random() * n);
    pos.set([pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]], i * 3);
  }
  for (let i = 0; i < PARTICULAS; i++) semillas[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSemilla', new THREE.BufferAttribute(semillas, 1));
  return geo;
}

function crearNube(geo, tipo, color, gel) {
  const n = params.nubes;
  const material = new THREE.ShaderMaterial({
    vertexShader: nubeVertex,
    fragmentShader: nubeFragment,
    uniforms: {
      uT: { value: Math.random() * 100 },
      uDensidad: { value: n[tipo].densidad },
      uTamano: { value: n.tamano },
      uEscala: { value: escalaPuntos() },
      uColor: { value: new THREE.Color(color) },
      uIrid: { value: n.iridiscencia },
      uBrillo: { value: n.brillo },
      uRebote: gel.uRebote,
    },
    transparent: false, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  material.userData.tipo = tipo;
  nubes.push(material);
  return { puntos: new THREE.Points(geo, material), material };
}
export function aplicarNubes() {
  const n = params.nubes;
  for (const m of nubes) {
    const u = m.uniforms;
    u.uDensidad.value = n[m.userData.tipo].densidad;
    u.uTamano.value = n.tamano;
    u.uIrid.value = n.iridiscencia;
    u.uBrillo.value = n.brillo;
  }
}
export function actualizarEscalaNubes() {
  const e = escalaPuntos();
  for (const m of nubes) m.uniforms.uEscala.value = e;
  for (const m of polvos) m.uniforms.uEscala.value = e;
}

// =====================================================================
// POLVO DE ESTRELLA — partículas brillantes sobre la superficie de la gema que, al disolverse,
// se dispersan en remolino hacia afuera y hacia arriba, titilando. Como la nube, el material no es
// "transparent" pero usa mezcla aditiva, para verse también a través del vidrio de otras gemas.
// =====================================================================
const GRANOS = 900;
function geometriaPolvo(malla) {
  const sampler = new MeshSurfaceSampler(malla).build();
  const pos = new Float32Array(GRANOS * 3), azar = new Float32Array(GRANOS * 3), semillas = new Float32Array(GRANOS);
  const p = new THREE.Vector3();
  for (let i = 0; i < GRANOS; i++) {
    sampler.sample(p);
    pos.set([p.x, p.y, p.z], i * 3);
    azar.set([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1], i * 3);
    semillas[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aAzar', new THREE.BufferAttribute(azar, 3));
  geo.setAttribute('aSemilla', new THREE.BufferAttribute(semillas, 1));
  return geo;
}
const polvoVertex = /* glsl */`
  attribute vec3 aAzar;
  attribute float aSemilla;
  uniform float uP;       // avance de la disolución (0 a 1)
  uniform float uT;       // tiempo
  uniform float uFlotar;  // 1 = el polvo se queda flotando (final de la obra)
  uniform float uTamano;
  uniform float uEscala;
  varying float vBrillo;
  varying float vTono;
  void main() {
    float e = 1.0 - pow(1.0 - uP, 2.2);                    // sale rápido y se frena
    vec3 dir = normalize(position + aAzar * 0.6);
    vec3 p = position + dir * e * (0.25 + 1.35 * aSemilla); // se dispersa hacia afuera, cerca de su lugar
    float ang = e * (1.5 + 2.0 * aAzar.x);                  // remolino alrededor del eje vertical
    float c = cos(ang), s = sin(ang);
    p.xz = mat2(c, -s, s, c) * p.xz;
    p.y += e * (0.5 + aAzar.y) * 0.5;                       // sube un poco
    p += 0.15 * e * vec3(sin(uT * 0.5 + aSemilla * 40.0), sin(uT * 0.37 + aSemilla * 23.0), cos(uT * 0.43 + aSemilla * 31.0));
    float aparece = smoothstep(0.0, 0.06, uP);
    float apaga = mix(1.0 - smoothstep(0.55, 1.0, uP), 0.5, uFlotar);
    float chispa = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(uT * (3.0 + 7.0 * aSemilla) + aSemilla * 60.0), 3.0);
    vBrillo = aparece * apaga * chispa;
    vTono = aSemilla;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uTamano * (0.4 + 1.2 * aSemilla * aSemilla) * uEscala / -mv.z; // casi todos finos, algunos más grandes
    gl_Position = projectionMatrix * mv;
  }`;
const polvoFragment = /* glsl */`
  uniform vec3 uColor;
  uniform float uBrillo;
  varying float vBrillo;
  varying float vTono;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, r);
    a *= a;
    // polvo dorado y blanco, teñido apenas con el color del tripulante
    vec3 col = mix(vec3(1.0, 0.86, 0.55), vec3(1.0), vTono);
    col = mix(col, uColor, 0.3);
    gl_FragColor = vec4(col * a * vBrillo * uBrillo * 0.9, 1.0);
  }`;
function crearPolvo(geo, color) {
  const material = new THREE.ShaderMaterial({
    vertexShader: polvoVertex, fragmentShader: polvoFragment,
    uniforms: {
      uP: { value: 0 }, uT: { value: Math.random() * 100 }, uFlotar: { value: 0 }, uBrillo: { value: 1 },
      uTamano: { value: 0.028 }, uEscala: { value: escalaPuntos() }, uColor: { value: new THREE.Color(color) },
    },
    transparent: false, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const puntos = new THREE.Points(geo, material);
  puntos.visible = false;
  puntos.frustumCulled = false;
  polvos.push(material);
  return { puntos, material };
}
const polvos = [];

// =====================================================================
// Plantillas y gemas
// =====================================================================

// Puntos sobre la superficie de cada tipo de gema (los usa también el fantasma de la reverb)
export const geometriaPolvoDe = (tipo) => plantillas[tipo]?.polvoGeo;

export async function cargarPlantillas() {
  const datos = await (await fetch(ASSETS + 'materiales.json')).json();
  const loader = new GLTFLoader();
  await Promise.all(TIPOS.map(async (tipo) => {
    const gltf = await loader.loadAsync(ASSETS + tipo + '.glb');
    let malla = null;
    gltf.scene.traverse((o) => { if (o.isMesh) malla = o; });
    plantillas[tipo] = { escena: gltf.scene, material: datos.materiales[tipo], nubeGeo: geometriaNube(malla), polvoGeo: geometriaPolvo(malla) };
  }));
}

// Crea una gema en la escena. Devuelve todo lo que la animación necesita para moverla.
export function crearGema(tipo, color) {
  const plantilla = plantillas[tipo];
  const gel = { uGelT: { value: Math.random() * 50 }, uOnda: { value: 0 }, uFrec: { value: 1 }, uRebote: { value: 0 } };
  const vidrio = crearVidrio(plantilla.material, gel);
  const giro = plantilla.escena.clone(true); // comparte la geometría con la plantilla
  let malla = null;
  giro.traverse((o) => { if (o.isMesh) { o.material = vidrio; malla = o; } });
  const nube = crearNube(plantilla.nubeGeo, tipo, color, gel);
  malla.add(nube.puntos);
  // grupo = posición e inclinación fija; giro = la pieza rotando sobre su eje vertical
  const grupo = new THREE.Group();
  grupo.rotation.x = INCLINACION[tipo];
  grupo.add(giro);
  // polvo de estrella: oculto hasta que la gema se disuelve
  const polvo = crearPolvo(plantilla.polvoGeo, color);
  giro.add(polvo.puntos);
  scene.add(grupo);
  return { grupo, giro, malla, gel, vidrio, nube: nube.material, polvo, resorte: { x: 0, v: 0 }, disuelta: 0 };
}

export function destruirGema(gema) {
  scene.remove(gema.grupo);
  gema.vidrio.dispose();
  gema.nube.dispose();
  if (gema.polvo.puntos.parent === gema.giro) { // si quedó flotando (final), se libera al apagarse
    gema.polvo.material.dispose();
    polvos.splice(polvos.indexOf(gema.polvo.material), 1);
  }
  vidrios.splice(vidrios.indexOf(gema.vidrio), 1);
  nubes.splice(nubes.indexOf(gema.nube), 1);
}

export function colorearGema(gema, color) {
  gema.nube.uniforms.uColor.value.set(color);
  gema.polvo.material.uniforms.uColor.value.set(color);
}

// Gelatina, nube y polvo de una gema en cada cuadro.
// gel (opcional): { ondulacion, velocidad, frecuencia, rigidez, amortiguacion } propios de la pieza
// (el filtro los cambia); sin él se usan los valores generales de ajustes.json.
export function animarGema(gema, tipo, dt, gel = null) {
  const gp = gel || { ...params.gelatina, frecuencia: 1 };
  // cada nube avanza con su propia velocidad; se apaga mientras la gema se disuelve
  gema.nube.uniforms.uT.value += dt * params.nubes[tipo].velocidad;
  gema.nube.uniforms.uBrillo.value = params.nubes.brillo * (1 - gema.disuelta);
  // gelatina: ondulación constante + resorte amortiguado (en pasos pequeños para que sea estable)
  gema.gel.uGelT.value += dt * gp.velocidad;
  gema.gel.uOnda.value = gp.ondulacion;
  gema.gel.uFrec.value = gp.frecuencia;
  const r = gema.resorte;
  for (let i = 0; i < 4; i++) {
    r.v += (-gp.rigidez * r.x - gp.amortiguacion * r.v) * (dt / 4);
    r.x += r.v * (dt / 4);
  }
  r.x = THREE.MathUtils.clamp(r.x, -0.6, 0.6);
  gema.gel.uRebote.value = r.x;
  gema.polvo.material.uniforms.uT.value += dt;
}

// Disolución en polvo de estrella: p = 0 gema entera, 1 solo polvo disperso.
// La gema se encoge (sale rápido y se frena) mientras su polvo se abre en remolino.
export function disolverGema(gema, p) {
  gema.disuelta = p;
  const e = THREE.MathUtils.smoothstep(p, 0, 0.75);
  gema.malla.scale.setScalar(Math.max(1 - e, 0.0001));
  gema.malla.visible = e < 0.999;
  gema.polvo.material.uniforms.uP.value = p;
  gema.polvo.puntos.visible = p > 0.001 || gema.polvo.material.uniforms.uFlotar.value > 0;
}

// Final de la obra: el polvo de la gema queda flotando en la escena aunque la gema se elimine.
const polvoSuelto = []; // { material, puntos, apagando }
export function soltarPolvo(gema) {
  const { puntos, material } = gema.polvo;
  material.uniforms.uFlotar.value = 1;
  scene.attach(puntos); // conserva su posición en el mundo
  polvoSuelto.push({ puntos, material, apagando: false });
}
// Al reabrir la estación, el polvo flotante se apaga y desaparece.
export function apagarPolvoSuelto() { polvoSuelto.forEach((p) => (p.apagando = true)); }
export function animarPolvoSuelto(dt) {
  for (const p of [...polvoSuelto]) {
    const u = p.material.uniforms;
    u.uT.value += dt;
    if (!p.apagando) continue;
    u.uBrillo.value = Math.max(0, u.uBrillo.value - dt / 3);
    if (u.uBrillo.value <= 0) {
      scene.remove(p.puntos);
      p.material.dispose();
      polvos.splice(polvos.indexOf(p.material), 1);
      polvoSuelto.splice(polvoSuelto.indexOf(p), 1);
    }
  }
}

// Dispara el rebote elástico de una gema.
export function golpearGema(gema, fuerza = 1) {
  gema.resorte.v -= 6 * fuerza * params.gelatina.rebote;
}
