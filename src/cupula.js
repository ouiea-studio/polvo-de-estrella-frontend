// VISTA DOMO (fulldome) — 10 de noviembre de 2026.
// Tecla D (o ?vista=domo en la dirección): este dispositivo dibuja un "dome master" para proyectar en
// el domo: imagen cuadrada con un círculo inscrito en ojo de pez EQUIDISTANTE de 180° (centro = cenit,
// borde = horizonte), negro fuera del círculo. Es un ajuste local (localStorage), no pasa por el
// servidor: cualquier dispositivo puede abrirla, sin audio y sin los controles del director.
//
// TÉCNICA: cubo + shader de ojo de pez. Cada cuadro la escena se dibuja desde el centro de la sala
// en 5 caras de un cubo de 90° (la de abajo no se ve en el hemisferio), cada una en su textura, y un
// shader convierte cada píxel del dome master en una dirección y lee la cara que corresponde. Se eligió en vez de proyectar en el vertex shader porque:
// (1) el vidrio con transmisión, la refracción, los puntos y la postproducción funcionan sin cambios
// (cada cara es un render normal en perspectiva); (2) proyectar vértices en ojo de pez deforma mal los
// triángulos grandes y las líneas, y rompe la pasada de transmisión. Coste: 5 renders por cuadro.
//
// CORRESPONDENCIA CON EL 5.1 (punto de vista del público, en el centro, mirando hacia arriba):
// la posición de cada gema en el plano de la estación pasa a la cúpula: su ángulo es el acimut
// (0° = frente = −Z, +90° = derecha = +X, el mismo criterio que salida.js) y su distancia al centro la
// elevación (centro = cenit = parlante C; borde de la estación = elevación mínima, 15° por defecto).
// Todas a la misma distancia del espectador. Sin espejo: el plano se mira desde arriba y la cúpula
// desde abajo, pero en el dome master (frente abajo) la izquierda del público queda a la IZQUIERDA de
// la imagen: una gema del lado I (x < 0) se ve a la izquierda. (Comprobado leyendo píxeles.)
//
// Orientación de la imagen: ajuste propio (rotación y voltear), independiente de la orientación del
// sonido del panel A; transforma todo el dome master (también la carta de ajuste). Por defecto el
// frente va abajo.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import {
  renderer, scene, composer, controls, params, aplicarPost, ganchos, pasoEscena, ajustarTamanoNormal, RADIO_UNIVERSO,
} from './escena.js';
import { escribiendo } from './hud.js';

const CLAVE = 'polvo.vistaDomo';
const POR_DEFECTO = {
  activa: false,
  resolucion: 2048,   // lado del dome master en píxeles (1024, 2048, 3072 o 4096)
  elevMin: 15,        // grados: elevación del borde de la estación
  tamano: 2.2,        // tamaño aparente de las gemas (× su tamaño normal)
  distancia: 10,      // distancia de las gemas al espectador (unidades de la escena)
  rotacion: 0,        // grados: gira todo el dome master (positivo = sentido horario en la imagen)
  voltear: false,     // espejo horizontal (si el proyector lo invierte)
  anillos: false,     // círculos de elevación (los anillos del radar llevados a la cúpula)
};
function cargar() {
  try { return { ...POR_DEFECTO, ...JSON.parse(localStorage.getItem(CLAVE) || '{}') }; } catch { return { ...POR_DEFECTO }; }
}
export const cfg = cargar();
let postDomo = null; // ajustes de postproducción propios de esta vista (se guardan aparte)
try { postDomo = JSON.parse(localStorage.getItem(CLAVE + '.post') || 'null'); } catch { postDomo = null; }
function guardar() {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(cfg));
    if (postDomo) localStorage.setItem(CLAVE + '.post', JSON.stringify(postDomo));
  } catch { /* sin almacenamiento: se usa igual */ }
}
const RESOLUCIONES = [1024, 2048, 3072, 4096];
const deg = THREE.MathUtils.degToRad;
let activa = false, simulador = false, carta = false;
export const estaActiva = () => activa;

// =====================================================================
// Posición de una gema en la cúpula
// =====================================================================
const ARRIBA = new THREE.Vector3(0, 1, 0);
const dir = new THREE.Vector3(), tang = new THREE.Vector3(), eje = new THREE.Vector3(), haciaMi = new THREE.Vector3();
// (x, z) del plano → dirección en la cúpula (vector unitario)
export function direccionDe(x, z, out = new THREE.Vector3()) {
  const r = Math.hypot(x, z);
  const d = Math.min(r / RADIO_UNIVERSO, 1);
  const el = deg(90 - d * (90 - cfg.elevMin));
  const hx = r > 1e-6 ? x / r : 0, hz = r > 1e-6 ? z / r : -1;
  return out.set(hx * Math.cos(el), Math.sin(el), hz * Math.cos(el));
}
// La gema mira al público: su eje se inclina hacia el espectador como en la vista normal se inclina
// hacia la cámara (la misma inclinación por tipo).
export function colocarGema(g, x, z, escala) {
  direccionDe(x, z, dir);
  g.grupo.position.copy(dir).multiplyScalar(cfg.distancia);
  haciaMi.copy(dir).negate();
  tang.copy(ARRIBA).addScaledVector(dir, -dir.dot(ARRIBA));
  if (tang.lengthSq() < 1e-6) tang.set(0, 0, -1); else tang.normalize();
  eje.copy(tang).multiplyScalar(Math.cos(g.inclinacion)).addScaledVector(haciaMi, Math.sin(g.inclinacion)).normalize();
  g.grupo.quaternion.setFromUnitVectors(ARRIBA, eje);
  g.grupo.scale.setScalar(escala * cfg.tamano);
}
export function restaurarGema(g) { g.grupo.rotation.set(g.inclinacion, 0, 0); }

// =====================================================================
// Anillos de elevación (opcional): los anillos del radar (radios 3, 6, 9 y 12) llevados a la cúpula
// =====================================================================
const anillos = new THREE.Group();
anillos.visible = false;
scene.add(anillos);
function rehacerAnillos() {
  for (const h of [...anillos.children]) { h.geometry.dispose(); h.material.dispose(); anillos.remove(h); }
  for (const r of [3, 6, 9, RADIO_UNIVERSO]) {
    const puntos = Array.from({ length: 160 }, (_, i) => {
      const a = (i / 160) * Math.PI * 2;
      return direccionDe(Math.sin(a) * r, -Math.cos(a) * r).multiplyScalar(30);
    });
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(0.55, 0.6, 0.85).multiplyScalar(0.16 - r * 0.007), transparent: false, blending: THREE.AdditiveBlending, depthWrite: false });
    anillos.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(puntos), mat));
  }
}

// =====================================================================
// Pasada del domo: 5 caras de un cubo + ojo de pez equidistante
// Cada cara se dibuja en SU PROPIA textura con su propia cámara de 90° (no en un cubemap): en three
// 0.170 la pasada de transmisión del vidrio, al terminar, vuelve a la textura de destino sin recordar
// la cara del cubo y todo caía en la primera cara. El shader elige la cara según la dirección.
// =====================================================================
const CARAS = [ // [hacia dónde mira, vector "arriba" de la cámara]
  [[1, 0, 0], [0, 1, 0]], [[-1, 0, 0], [0, 1, 0]], [[0, 0, 1], [0, 1, 0]], [[0, 0, -1], [0, 1, 0]], [[0, 1, 0], [0, 0, 1]],
]; // +X, −X, +Z, −Z (frente), +Y (cenit); la −Y, hacia el piso, no se ve en el hemisferio
const ojoDePez = new THREE.ShaderMaterial({
  uniforms: {
    uCara: { value: CARAS.map(() => null) }, uRotCara: { value: CARAS.map(() => new THREE.Matrix3()) },
    uRot: { value: 0 }, uVoltear: { value: 1 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uCara[5]; uniform mat3 uRotCara[5]; uniform float uRot; uniform float uVoltear; varying vec2 vUv;
    // dirección del mundo → coordenada en la cara k (cámara de 90°: mira hacia −z en su propio espacio)
    bool enCara(int k, vec3 d, out vec2 uv) {
      vec3 v = uRotCara[k] * d;
      float f = -v.z;
      if (f <= 0.0 || abs(v.x) > f * 1.0001 || abs(v.y) > f * 1.0001) return false;
      uv = vec2(v.x, v.y) / f * 0.5 + 0.5;
      return true;
    }
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      p.x *= uVoltear;
      float c = cos(uRot), s = sin(uRot);
      vec2 q = mat2(c, s, -s, c) * p;            // marco sin rotar: abajo = frente
      float r = length(q);
      if (r > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      float th = r * 1.5707963;                  // equidistante: el radio es el ángulo desde el cenit
      vec2 h = r > 1e-6 ? q / r : vec2(0.0);
      vec3 dir = vec3(sin(th) * h.x, cos(th), sin(th) * h.y); // q.y = −1 → −Z (frente); q.x = −1 → −X (I)
      vec2 uv; vec4 col = vec4(0.0, 0.0, 0.0, 1.0);
      if (enCara(4, dir, uv)) col = texture2D(uCara[4], uv);
      else if (enCara(3, dir, uv)) col = texture2D(uCara[3], uv);
      else if (enCara(2, dir, uv)) col = texture2D(uCara[2], uv);
      else if (enCara(0, dir, uv)) col = texture2D(uCara[0], uv);
      else if (enCara(1, dir, uv)) col = texture2D(uCara[1], uv);
      gl_FragColor = vec4(col.rgb, 1.0);
    }`,
  depthTest: false, depthWrite: false,
});
class PasoDomo extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.quad = new FullScreenQuad(ojoDePez);
    this.cara = 0;
    this.objetivos = [];
    this.camaras = CARAS.map(([mira, arriba], k) => {
      const cam = new THREE.PerspectiveCamera(90, 1, 0.1, 500);
      cam.up.set(...arriba);
      cam.lookAt(...mira);
      cam.updateMatrixWorld(true);
      ojoDePez.uniforms.uRotCara.value[k].setFromMatrix4(cam.matrixWorldInverse);
      return cam;
    });
  }
  fijarCara(lado) {
    if (lado === this.cara) return;
    this.cara = lado;
    this.objetivos.forEach((o) => o.dispose());
    this.objetivos = CARAS.map(() => new THREE.WebGLRenderTarget(lado, lado, { type: THREE.HalfFloatType, generateMipmaps: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping }));
    ojoDePez.uniforms.uCara.value = this.objetivos.map((o) => o.texture);
  }
  render(r, writeBuffer, readBuffer) {
    const antes = r.getRenderTarget();
    this.camaras.forEach((cam, k) => {
      r.setRenderTarget(this.objetivos[k]);
      r.clear();
      r.render(scene, cam);
    });
    r.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.quad.render(r);
    r.setRenderTarget(antes);
  }
  dispose() { this.objetivos.forEach((o) => o.dispose()); this.quad.dispose(); }
}
const pasoDomo = new PasoDomo();

// Al final: negro puro fuera del círculo (la postproducción —bloom, grano— se derrama) y la carta de
// ajuste encima (tecla T), con la misma rotación y espejo que la imagen.
const lienzoCarta = document.createElement('canvas');
lienzoCarta.width = lienzoCarta.height = 2048;
const texCarta = new THREE.CanvasTexture(lienzoCarta);
const mascara = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, tCarta: { value: texCarta }, uCarta: { value: 0 }, uRot: { value: 0 }, uVoltear: { value: 1 }, uPx: { value: 1 / 2048 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform sampler2D tCarta; uniform float uCarta; uniform float uRot; uniform float uVoltear; uniform float uPx;
    varying vec2 vUv;
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float borde = 1.0 - smoothstep(1.0 - 3.0 * uPx, 1.0, length(p));
      vec3 c = texture2D(tDiffuse, vUv).rgb * borde;
      if (uCarta > 0.5) {
        p.x *= uVoltear;
        float co = cos(uRot), si = sin(uRot);
        vec2 q = mat2(co, si, -si, co) * p;
        vec4 k = texture2D(tCarta, q * 0.5 + 0.5);
        c = mix(c, k.rgb, k.a);
      }
      gl_FragColor = vec4(c, 1.0);
    }`,
});
mascara.uniforms.tCarta.value = texCarta; // ShaderPass copia las texturas: se usa la original (la que se actualiza)
mascara.enabled = false;
composer.addPass(mascara);

// =====================================================================
// Carta de ajuste (tecla T): círculos de elevación cada 15°, acimut cada 30°, FRENTE / ATRÁS /
// IZQUIERDA / DERECHA y los parlantes (FL, FR, RL, RR a su acimut físico, C en el cenit).
// Se dibuja en el marco sin rotar (abajo = frente); la pasada final le aplica la rotación y el espejo.
// =====================================================================
let angulosParlantes = { FL: -45, FR: 45, RL: -135, RR: 135 };
export function fijarParlantes(angulos) { angulosParlantes = { ...angulos }; if (carta) dibujarCarta(); }
// acimut (grados) y elevación (grados) → píxel del lienzo de la carta
function aLienzo(az, el, L) {
  const r = (90 - el) / 90, a = deg(az);
  const x = r * Math.sin(a), y = -r * Math.cos(a); // marco sin rotar: y = −1 es el frente (abajo)
  return [(x + 1) / 2 * L, (1 - (y + 1) / 2) * L];
}
function dibujarCarta() {
  const L = lienzoCarta.width, c = lienzoCarta.getContext('2d'), m = L / 2;
  c.clearRect(0, 0, L, L);
  c.lineWidth = L / 900;
  for (let el = 0; el < 90; el += 15) {
    c.strokeStyle = el === 0 ? 'rgba(255,194,71,.95)' : 'rgba(223,230,255,.6)';
    c.beginPath(); c.arc(m, m, (90 - el) / 90 * m * 0.999, 0, Math.PI * 2); c.stroke();
    if (el > 0) { c.fillStyle = 'rgba(223,230,255,.75)'; c.font = `${L / 70}px "IBM Plex Mono", monospace`; const [x, y] = aLienzo(15, el, L); c.fillText(el + '°', x + 4, y - 4); }
  }
  // elevación mínima de la estación (borde del plano), en cian
  c.setLineDash([L / 120, L / 160]); c.strokeStyle = 'rgba(47,230,255,.8)';
  c.beginPath(); c.arc(m, m, (90 - cfg.elevMin) / 90 * m, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
  for (let az = 0; az < 360; az += 30) {
    const [x0, y0] = aLienzo(az, 75, L), [x1, y1] = aLienzo(az, 0, L);
    c.strokeStyle = az % 90 === 0 ? 'rgba(223,230,255,.75)' : 'rgba(223,230,255,.4)';
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.fillStyle = 'rgba(223,230,255,.6)'; c.font = `${L / 80}px "IBM Plex Mono", monospace`;
    const [tx, ty] = aLienzo(az, 3, L); c.textAlign = 'center'; c.fillText(az + '°', tx, ty);
  }
  // cruz del cenit
  c.strokeStyle = 'rgba(255,63,164,.9)'; c.beginPath(); c.moveTo(m - L / 60, m); c.lineTo(m + L / 60, m); c.moveTo(m, m - L / 60); c.lineTo(m, m + L / 60); c.stroke();
  c.font = `600 ${L / 38}px "Michroma", "Helvetica Neue", Arial, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const [txt, az] of [['FRENTE', 0], ['DERECHA', 90], ['ATRÁS', 180], ['IZQUIERDA', 270]]) {
    // los laterales, más adentro: el texto es ancho
    const [x, y] = aLienzo(az, az % 180 ? 40 : 26, L);
    c.fillStyle = az === 0 ? 'rgba(255,194,71,1)' : 'rgba(223,230,255,.95)'; c.fillText(txt, x, y);
  }
  // parlantes del domo
  const parlante = (id, x, y) => {
    c.fillStyle = 'rgba(255,194,71,.95)'; c.beginPath(); c.arc(x, y, L / 90, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#020208'; c.font = `600 ${L / 110}px "IBM Plex Mono", monospace`; c.fillText(id, x, y);
  };
  for (const id of ['FL', 'FR', 'RL', 'RR']) { const [x, y] = aLienzo(angulosParlantes[id], 8, L); parlante(id, x, y); }
  parlante('C', m + L / 30, m - L / 30);
  // datos (dentro del círculo, cerca del cenit)
  c.fillStyle = 'rgba(223,230,255,.85)'; c.font = `${L / 70}px "IBM Plex Mono", monospace`;
  c.fillText(`DOME MASTER ${cfg.resolucion} px · ${fps} FPS · elev. mín. ${cfg.elevMin}°`, m, m + L / 12);
  c.fillText(`rotación ${cfg.rotacion}° · ${cfg.voltear ? 'volteado' : 'sin voltear'} · T: cerrar carta`, m, m + L / 12 + L / 50);
  texCarta.needsUpdate = true;
}

// =====================================================================
// Simulador (Shift+D): el dome master proyectado dentro de una semiesfera, visto desde una silla
// =====================================================================
const escenaSim = new THREE.Scene();
const camSim = new THREE.PerspectiveCamera(95, 1, 0.1, 100);
camSim.position.set(0, 1.3, 3.2); // una silla detrás del centro, un poco elevada (radio de la cúpula: 10)
const vistaSim = { yaw: 0, pitch: deg(38) };
const materialSim = new THREE.ShaderMaterial({
  uniforms: { tMaster: { value: null } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vec3 d = normalize(position);
      float th = acos(clamp(d.y, -1.0, 1.0));     // ángulo desde el cenit
      float r = th / 1.5707963;
      vec2 h = length(d.xz) > 1e-6 ? normalize(d.xz) : vec2(0.0);
      vUv = h * r * 0.5 + 0.5;                    // la misma convención del ojo de pez (frente = abajo)
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`uniform sampler2D tMaster; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tMaster, vUv).rgb, 1.0); }`,
  side: THREE.BackSide, depthWrite: false,
});
escenaSim.add(new THREE.Mesh(new THREE.SphereGeometry(10, 128, 64, 0, Math.PI * 2, 0, Math.PI / 2), materialSim));
// piso de la sala (oscuro) y un aro en el horizonte para orientarse
const piso = new THREE.Mesh(new THREE.CircleGeometry(10, 64), new THREE.MeshBasicMaterial({ color: 0x050508 }));
piso.rotation.x = -Math.PI / 2; piso.position.y = -0.4; escenaSim.add(piso);
function apuntarSim() {
  const d = new THREE.Vector3(Math.sin(vistaSim.yaw) * Math.cos(vistaSim.pitch), Math.sin(vistaSim.pitch), -Math.cos(vistaSim.yaw) * Math.cos(vistaSim.pitch));
  camSim.lookAt(camSim.position.clone().add(d));
}
apuntarSim();
let arrastre = null;
renderer.domElement.addEventListener('pointerdown', (e) => { if (simulador) { arrastre = { x: e.clientX, y: e.clientY, yaw: vistaSim.yaw, pitch: vistaSim.pitch }; e.stopImmediatePropagation(); } }, true);
window.addEventListener('pointermove', (e) => {
  if (!simulador || !arrastre) return;
  vistaSim.yaw = arrastre.yaw - (e.clientX - arrastre.x) * 0.005;
  vistaSim.pitch = THREE.MathUtils.clamp(arrastre.pitch + (e.clientY - arrastre.y) * 0.005, deg(-10), deg(89));
  apuntarSim();
});
window.addEventListener('pointerup', () => { arrastre = null; });

// =====================================================================
// Tamaños, render y FPS
// =====================================================================
let fps = 0, cuadros = 0, desde = performance.now();
const ladoCara = () => Math.min(4096, Math.round(cfg.resolucion * 0.55 / 8) * 8); // ~0,55 × lado: nitidez pareja con el dome master
function ajustar() {
  const R = cfg.resolucion;
  composer.setPixelRatio(1);
  composer.setSize(R, R);
  pasoDomo.fijarCara(ladoCara());
  mascara.uniforms.uPx.value = 1 / R;
  if (simulador) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    camSim.aspect = window.innerWidth / Math.max(window.innerHeight, 1);
    camSim.updateProjectionMatrix();
    Object.assign(renderer.domElement.style, { width: '', height: '' });
  } else {
    renderer.setPixelRatio(1);
    renderer.setSize(R, R, false);
    const lado = Math.min(window.innerWidth, window.innerHeight);
    Object.assign(renderer.domElement.style, { width: lado + 'px', height: lado + 'px' });
  }
}
function render(dt) {
  composer.renderToScreen = !simulador;
  composer.render(dt);
  if (simulador) {
    materialSim.uniforms.tMaster.value = composer.readBuffer.texture;
    renderer.setRenderTarget(null);
    renderer.render(escenaSim, camSim);
  }
  cuadros++;
  const t = performance.now();
  if (t - desde >= 1000) {
    fps = Math.round(cuadros * 1000 / (t - desde)); cuadros = 0; desde = t;
    estado.fps = fps;
    if (carta) dibujarCarta();
  }
}
export const estado = { fps: 0 };
function aplicarOrientacion() {
  for (const u of [ojoDePez.uniforms, mascara.uniforms]) { u.uRot.value = deg(cfg.rotacion); u.uVoltear.value = cfg.voltear ? -1 : 1; }
  anillos.visible = activa && cfg.anillos;
  if (activa && cfg.anillos) rehacerAnillos();
  if (carta) dibujarCarta();
}

// Postproducción propia de la vista domo (viñeta apagada por defecto): se intercambia con la normal.
function copiarEn(destino, origen) {
  for (const k in origen) {
    if (origen[k] && typeof origen[k] === 'object') { destino[k] ||= {}; copiarEn(destino[k], origen[k]); } else destino[k] = origen[k];
  }
}
let postNormal = null;

// =====================================================================
// Encender y apagar
// =====================================================================
let avisar = () => {};
export function iniciar(opciones) {
  avisar = opciones.alCambiar || avisar;
  const pedida = new URLSearchParams(location.search).get('vista') === 'domo';
  if (pedida || cfg.activa) fijar(true);
}
export function fijar(si, conSimulador = false) {
  if (si === activa && conSimulador === simulador) return;
  const antes = activa;
  activa = si;
  simulador = si && conSimulador;
  cfg.activa = si;
  if (si && !antes) {
    postNormal = structuredClone(params.post);
    // por defecto: la de la vista normal sin viñeta y con mucha menos aberración cromática (crece
    // hacia el borde: en el domo el borde es el horizonte y se separaban mucho los colores)
    copiarEn(params.post, postDomo || { ...structuredClone(params.post), vineta: 0, aberracion: 0.3 });
    controls.enabled = false;
    composer.passes[0] = pasoDomo;
    mascara.enabled = true;
    ganchos.render = render;
    ganchos.ajustar = ajustar;
    ganchos.escalaPuntos = () => pasoDomo.cara / 2; // cámara de 90° en caras de "cara" píxeles
  } else if (!si && antes) {
    postDomo = structuredClone(params.post);
    copiarEn(params.post, postNormal);
    controls.enabled = true;
    composer.passes[0] = pasoEscena;
    mascara.enabled = false;
    composer.renderToScreen = true;
    ganchos.render = ganchos.ajustar = ganchos.escalaPuntos = null;
    carta = false;
    mascara.uniforms.uCarta.value = 0;
    Object.assign(renderer.domElement.style, { width: '', height: '' });
  }
  document.body.dataset.vista = !si ? 'normal' : simulador ? 'simulador' : 'domo';
  aplicarPost();
  if (si) ajustar(); else ajustarTamanoNormal();
  aplicarOrientacion();
  guardar();
  avisar(si);
}
export function alternarCarta() {
  if (!activa) return;
  carta = !carta;
  mascara.uniforms.uCarta.value = carta ? 1 : 0;
  if (carta) dibujarCarta();
}
// guarda la postproducción de esta vista cuando se edita con el panel V
setInterval(() => { if (activa) { postDomo = structuredClone(params.post); guardar(); } }, 2000);

window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat || escribiendo(ev.target)) return;
  const k = ev.key.toLowerCase();
  if (k === 'd') {
    if (ev.shiftKey) fijar(true, !(activa && simulador)); // Shift+D: entra o sale del simulador
    else fijar(!activa);                                   // D: vista normal ↔ vista domo
  }
  else if (k === 't' && activa) alternarCarta();
});
window.addEventListener('resize', () => { if (activa) ajustar(); });

// Panel V: carpeta "Vista domo"
export function agregarAlPanel(gui) {
  const g = gui.addFolder('Vista domo (D · T carta · Shift+D simulador)');
  const cambio = () => { if (activa) { ajustar(); aplicarOrientacion(); } guardar(); };
  g.add(cfg, 'resolucion', RESOLUCIONES).name('resolución (px)').onChange((v) => { cfg.resolucion = +v; cambio(); });
  g.add(estado, 'fps').name('FPS').listen().disable();
  g.add(cfg, 'elevMin', 0, 45, 1).name('elevación mínima (°)').onChange(cambio);
  g.add(cfg, 'tamano', 0.5, 5, 0.05).name('tamaño aparente').onChange(cambio);
  g.add(cfg, 'rotacion', -180, 180, 1).name('rotación (°, + horario)').onChange(cambio);
  g.add(cfg, 'voltear').name('voltear horizontal').onChange(cambio);
  g.add(cfg, 'anillos').name('círculos de elevación').onChange(cambio);
  g.add({ carta: alternarCarta }, 'carta').name('carta de ajuste (T)');
  g.add({ sim: () => fijar(true, !simulador) }, 'sim').name('simulador (Shift+D)');
  g.close();
  return g;
}
// Para medir: dibuja n cuadros seguidos a una resolución y devuelve los ms por cuadro (fuerza a la
// GPU a terminar leyendo un píxel). Sirve aunque la pestaña no esté dibujando.
export function medir(resolucion = cfg.resolucion, n = 30) {
  const previa = cfg.resolucion;
  if (!activa) return null;
  cfg.resolucion = resolucion; ajustar();
  const gl = renderer.getContext(), px = new Uint8Array(4);
  render(0.016);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) render(0.016);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const ms = (performance.now() - t0) / n;
  cfg.resolucion = previa; ajustar();
  return { resolucion, msPorCuadro: +ms.toFixed(1), fps: +(1000 / ms).toFixed(1) };
}
// Para pruebas: dibuja un cuadro ya mismo (los píxeles se pueden leer en la misma tarea)
export function dibujarUnCuadro() { if (activa) render(0.016); }
