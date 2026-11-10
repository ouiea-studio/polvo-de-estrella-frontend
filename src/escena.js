// Escena 3D: render, cámara, luces, estrellas y postproducción de los 80.
// Valores y shaders migrados tal cual desde preview/index.html.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { ajustes } from './ajustes.js';

// Mezcla espacial: a esta distancia en X el paneo llega a ±1, y a este radio el volumen llega a 0.
export const RADIO_PANEO = 6;
export const RADIO_UNIVERSO = 12;

// =====================================================================
// PARÁMETROS — los valores por defecto vienen de public/ajustes.json (el único archivo
// de configuración). El panel (tecla H) los modifica en vivo y más adelante la música
// podrá escribir en estos mismos valores.
//
// Vidrio metálico: lo metálico sale del brillo especular teñido, la iridiscencia y el clearcoat
// (no de metalness: por encima de 0.3 Three.js vuelve opaco el vidrio). Lo translúcido sale de
// la transmisión, una rugosidad leve (esmerilado) y el color de atenuación, que tiñe el interior.
//  · entorno: qué reflejan las gemas. 'paleta' = estudio magenta/cian/dorado; 'plata' = estudio neutro.
//  · colorCuerpo y tinteBase: el color del vidrio es colorCuerpo mezclado con el color propio
//    de cada gema (materiales.json); tinteBase 0 = solo colorCuerpo, 1 = solo el color propio.
//  · grosorIrid: grosor de la película iridiscente en nanómetros. Más rango = más viraje de color.
// =====================================================================
export const PRESETS_VIDRIO = ajustes.presetsVidrio;
export const params = {
  general: { ...ajustes.general },
  presetVidrio: ajustes.presetVidrio,
  vidrio: { ...PRESETS_VIDRIO[ajustes.presetVidrio] },
  nubes: structuredClone(ajustes.nubes),
  // Gelatina: ondulación constante de la superficie + rebote elástico (resorte amortiguado)
  gelatina: { ...ajustes.gelatina },
  // estela: 0 = sin estela, cerca de 1 = estela muy larga · rgb: desplazamiento RGB (fracción del ancho) y su pulso
  post: structuredClone(ajustes.post),
};

// --- Render, escena y cámara ---
// antialias desactivado aquí: el suavizado lo hace el compositor de postproducción
export const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(params.general.resolucion);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020208); // espacio casi negro

// La cámara mira desde un poco más arriba que en la vista previa, para poder
// arrastrar las piezas sobre el plano horizontal del universo.
// Vista inicial. En pantallas horizontales (computador): baja y frontal. En pantallas verticales
// (celular) el campo horizontal es muy angosto: la cámara sube y se aleja para que quepa la estación
// (unas ±6,5 unidades de ancho en el centro) y se vea más desde arriba, cómodo para tocar las piezas.
// Proporción de la ventana; si todavía no tiene tamaño (pestaña abierta en segundo plano), 16:9.
const proporcion = () => { const a = window.innerWidth / window.innerHeight; return Number.isFinite(a) && a > 0 ? a : 16 / 9; };
function vistaInicial() {
  const a = proporcion();
  if (a >= 1) return { fov: 40, posicion: new THREE.Vector3(0, 3.2, 11) };
  const fov = 55;
  const d = THREE.MathUtils.clamp(6.5 / (Math.tan(THREE.MathUtils.degToRad(fov / 2)) * a), 11, 34);
  const elevacion = THREE.MathUtils.degToRad(32);
  return { fov, posicion: new THREE.Vector3(0, d * Math.sin(elevacion), d * Math.cos(elevacion)) };
}
const vista0 = vistaInicial();
export const camera = new THREE.PerspectiveCamera(vista0.fov, proporcion(), 0.1, 500);
camera.position.copy(vista0.posicion);

export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 3;
controls.maxDistance = 40;
controls.maxPolarAngle = Math.PI * 0.495; // no bajar del horizonte

// --- Entorno de iluminación: da reflejos al vidrio sin mostrarse como fondo ---
// El metal necesita algo que reflejar. Cada entorno es un estudio: una cúpula en degradado
// (para que todas las facetas reflejen algo de color) más franjas luminosas nítidas
// (el contraste es lo que lo hace leer como metal y no como vidrio lechoso).
// Se calculan una sola vez al cargar: no cuestan nada por cuadro.
function crearEntorno(tipo) {
  const estudio = new THREE.Scene();
  const cupula = new THREE.SphereGeometry(20, 64, 32);
  const colores = [];
  const d = new THREE.Vector3(), c = new THREE.Color();
  const pos = cupula.attributes.position;
  const PALETA = { magenta: new THREE.Color('#ff3fa4'), cian: new THREE.Color('#2fe6ff'),
                   dorado: new THREE.Color('#ffc247'), violeta: new THREE.Color('#8c59ff') };
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    if (tipo === 'plata') {
      // cielo claro arriba con bandas oscuras, horizonte oscuro, suelo gris: el clásico estudio
      // de cromo. Las bandas son las que dan el reflejo "líquido" al girar.
      const bandas = 0.3 + 0.7 * THREE.MathUtils.smoothstep(Math.sin(d.y * 22 + d.x * 3), -0.3, 0.3);
      const v = d.y > 0 ? (0.06 + 0.7 * Math.pow(d.y, 0.8)) * bandas : 0.04 + 0.22 * Math.pow(-d.y, 0.7);
      c.setRGB(v * 0.95, v * 0.97, v);
    } else {
      // magenta a la izquierda, cian a la derecha, dorado abajo, violeta arriba y detrás
      c.setRGB(0.02, 0.02, 0.04)
        .add(PALETA.magenta.clone().multiplyScalar(0.5 * Math.pow(Math.max(0, -d.x), 1.5)))
        .add(PALETA.cian.clone().multiplyScalar(0.5 * Math.pow(Math.max(0, d.x), 1.5)))
        .add(PALETA.dorado.clone().multiplyScalar(0.45 * Math.pow(Math.max(0, -d.y), 1.2)))
        .add(PALETA.violeta.clone().multiplyScalar(0.35 * Math.pow(Math.max(0, d.y), 1.2) + 0.15 * Math.max(0, -d.z)));
    }
    colores.push(c.r, c.g, c.b);
  }
  cupula.setAttribute('color', new THREE.Float32BufferAttribute(colores, 3));
  estudio.add(new THREE.Mesh(cupula, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const franja = (fuerza, ancho, alto, p) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(ancho, alto),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(fuerza), side: THREE.DoubleSide })
    );
    m.position.set(...p);
    m.lookAt(0, 0, 0);
    estudio.add(m);
  };
  const f = tipo === 'plata' ? 3.5 : 2.5;
  franja(f, 16, 0.5, [0, 10, 2]);
  franja(f * 0.8, 0.5, 12, [-8, 6, -7]);
  franja(f * 0.8, 0.5, 12, [9, 4, -5]);
  franja(f * 0.6, 10, 0.4, [0, 2, 12]);
  return pmrem.fromScene(estudio, 0.02).texture;
}
const pmrem = new THREE.PMREMGenerator(renderer);
// Las gemas reciben el entorno directamente en su material (envMap): solo así Three.js
// respeta su envMapIntensity ("reflejos del entorno"); con scene.environment lo ignora.
export const entornos = { paleta: crearEntorno('paleta'), plata: crearEntorno('plata') };
scene.environment = entornos.paleta;
scene.environmentIntensity = 0.6;

// --- Luces de colores suaves ---
export const lucesColor = [
  [0xff40c0, [-5, 4, 3]], [0x33d9ff, [5, 3, 3]], [0x8c59ff, [0, 3, -5]], [0xffb359, [0, -4, 1]],
].map(([color, pos]) => {
  const l = new THREE.PointLight(color, params.vidrio.lucesColor, 0, 2);
  l.position.set(...pos);
  scene.add(l);
  return l;
});

// --- Luces pequeñas en órbita: generan destellos que recorren los bordes del vidrio ---
export const destellos = [0xffffff, 0xffe2b0, 0xc8f4ff].map((color, i) => {
  const l = new THREE.PointLight(color, params.vidrio.destellos, 0, 2);
  l.userData = { radio: 3.6 + i * 0.7, fase: i * 2.1, vel: 0.22 + i * 0.07, alto: 1.4 - i * 1.3 };
  scene.add(l);
  return l;
});

// --- Campo de estrellas sencillo ---
// Se dibuja como "opaco con mezcla aditiva" para que también se vea a través del vidrio.
const N = 2500;
const posEstrellas = new Float32Array(N * 3);
const colEstrellas = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
  const v = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 80);
  posEstrellas.set([v.x, v.y, v.z], i * 3);
  // unas pocas estrellas muy brillantes: son las que disparan el filtro estrella
  const b = Math.random() < 0.03 ? 5 + Math.random() * 5 : 0.35 + Math.random() * 0.65;
  colEstrellas.set([b * 0.87, b * 0.9, b], i * 3);
}
const geoEstrellas = new THREE.BufferGeometry();
geoEstrellas.setAttribute('position', new THREE.BufferAttribute(posEstrellas, 3));
geoEstrellas.setAttribute('color', new THREE.BufferAttribute(colEstrellas, 3));
export const estrellas = new THREE.Points(
  geoEstrellas,
  new THREE.PointsMaterial({
    size: 0.35, sizeAttenuation: true, vertexColors: true,
    transparent: false, blending: THREE.AdditiveBlending, depthWrite: false,
  })
);
scene.add(estrellas);

// =====================================================================
// REFERENCIA DEL CENTRO — guía tipo radar en el plano donde se mueven las piezas.
// Anillos cada 3 unidades: como el volumen baja en línea recta hasta el borde (12), marcan
// 100 · 75 · 50 · 25 · 0 %. El eje X marca el paneo: llega al extremo en ±6 (marcas I y D).
// Todo se dibuja opaco con mezcla aditiva (como las estrellas) para verse también a través del vidrio.
// =====================================================================
const lineaGuia = (puntos, brillo, cerrada = false) => {
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(0.55, 0.6, 0.85).multiplyScalar(brillo),
    transparent: false, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const geo = new THREE.BufferGeometry().setFromPoints(puntos);
  return cerrada ? new THREE.LineLoop(geo, material) : new THREE.LineSegments(geo, material);
};
const circulo = (r, n = 192) => Array.from({ length: n }, (_, i) => new THREE.Vector3(Math.cos(i / n * Math.PI * 2) * r, 0, Math.sin(i / n * Math.PI * 2) * r));
export const referencia = new THREE.Group();
// anillos: más tenues hacia afuera, como el volumen
for (const r of [3, 6, 9, RADIO_UNIVERSO]) referencia.add(lineaGuia(circulo(r), 0.16 - r * 0.007, true));
// eje del paneo (X) y eje de profundidad (Z), muy tenues; marcas cortas en cada anillo sobre el eje X
const ejes = [
  new THREE.Vector3(-RADIO_UNIVERSO, 0, 0), new THREE.Vector3(RADIO_UNIVERSO, 0, 0),
  new THREE.Vector3(0, 0, -RADIO_UNIVERSO), new THREE.Vector3(0, 0, RADIO_UNIVERSO),
];
const marcas = [];
for (const x of [-9, -6, -3, 3, 6, 9]) {
  const largo = Math.abs(x) === RADIO_PANEO ? 0.45 : 0.2; // el extremo del paneo (±6) se marca más largo
  marcas.push(new THREE.Vector3(x, 0, -largo), new THREE.Vector3(x, 0, largo));
}
referencia.add(lineaGuia(ejes, 0.05), lineaGuia(marcas, 0.14));
// punto luminoso tenue en el centro: un resplandor redondo (degradado radial), no un cuadrado
function texturaResplandor() {
  const lienzo = document.createElement('canvas');
  lienzo.width = lienzo.height = 64;
  const ctx = lienzo.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, '#fff'); g.addColorStop(0.15, 'rgba(255,255,255,.6)'); g.addColorStop(0.5, 'rgba(255,255,255,.08)'); g.addColorStop(1, '#000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(lienzo);
}
const geoCentro = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0)]);
const centro = new THREE.Points(geoCentro, new THREE.PointsMaterial({
  map: texturaResplandor(), color: new THREE.Color(0.7, 0.78, 1).multiplyScalar(0.55), size: 0.7, sizeAttenuation: true,
  transparent: false, blending: THREE.AdditiveBlending, depthWrite: false,
}));
referencia.add(centro);
scene.add(referencia);
// posiciones de las marcas de texto I y D (las dibuja el HUD en main.js)
// van sobre el eje del paneo, hacia adentro del extremo (±6), para que se vean con la cámara frontal
export const MARCAS_PANEO = { I: new THREE.Vector3(-4.5, 0, 0.6), D: new THREE.Vector3(4.5, 0, 0.6) };

// =====================================================================
// PARLANTES DEL DOMO (modo 5.1) — marcas sutiles en el radar: FL, FR, RR y RL sobre el anillo
// exterior (con una línea muy tenue hacia el centro) y el anillo donde termina el paso por el C.
// Acimut 0° = frente (−Z, hacia el fondo), +90° = derecha (+X). Las etiquetas de texto las pone main.js.
// =====================================================================
export const parlantes = new THREE.Group();
parlantes.visible = false;
scene.add(parlantes);
export const POS_PARLANTES = { FL: new THREE.Vector3(), FR: new THREE.Vector3(), RR: new THREE.Vector3(), RL: new THREE.Vector3(), C: new THREE.Vector3(0, 0, 0) };
const lineaDorada = (puntos, brillo, cerrada = false) => {
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(1, 0.76, 0.28).multiplyScalar(brillo),
    transparent: false, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const geo = new THREE.BufferGeometry().setFromPoints(puntos);
  return cerrada ? new THREE.LineLoop(geo, material) : new THREE.LineSegments(geo, material);
};
// acimuts: { FL, FR, RR, RL } en grados ya girados por la orientación · radioCentro: fracción de RADIO_UNIVERSO
export function actualizarParlantes(visible, acimuts, radioCentro) {
  parlantes.visible = visible;
  for (const hijo of [...parlantes.children]) { hijo.geometry.dispose(); hijo.material.dispose(); parlantes.remove(hijo); }
  if (!visible) return;
  const R = RADIO_UNIVERSO, rombo = [], rayos = [];
  for (const id in acimuts) {
    const a = THREE.MathUtils.degToRad(acimuts[id]);
    const dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    const lado = new THREE.Vector3(-dir.z, 0, dir.x);
    const p = dir.clone().multiplyScalar(R);
    POS_PARLANTES[id].copy(dir).multiplyScalar(R + 0.9);
    // rombo pequeño sobre el anillo: el parlante
    const v = [p.clone().addScaledVector(dir, 0.32), p.clone().addScaledVector(lado, 0.32), p.clone().addScaledVector(dir, -0.32), p.clone().addScaledVector(lado, -0.32)];
    rombo.push(v[0], v[1], v[1], v[2], v[2], v[3], v[3], v[0]);
    rayos.push(dir.clone().multiplyScalar(R * Math.max(radioCentro, 0.05)), p.clone().addScaledVector(dir, -0.32));
  }
  parlantes.add(lineaDorada(rombo, 0.42), lineaDorada(rayos, 0.05));
  // anillo del C: dentro de este radio la pieza pasa del cenit al anillo
  if (radioCentro > 0) parlantes.add(lineaDorada(circulo(R * radioCentro, 128), 0.09, true));
}

// =====================================================================
// RECENTRAR — vuelve la cámara a la vista frontal inicial con una transición suave
// =====================================================================
const OBJETIVO_INICIAL = new THREE.Vector3(0, 0, 0);
let transicion = null; // { desde, hasta, objetivoDesde, t }
export function recentrar() {
  transicion = { desde: camera.position.clone(), hasta: vistaInicial().posicion, objetivoDesde: controls.target.clone(), t: 0 };
  controls.enabled = false;
  controls.enableDamping = false; // sin la inercia de la órbita anterior, que empujaría la cámara
}
function avanzarTransicion(dt) {
  if (!transicion) return;
  transicion.t = Math.min(transicion.t + dt / 1.1, 1); // 1,1 s
  const k = transicion.t < 0.5 ? 4 * transicion.t ** 3 : 1 - (-2 * transicion.t + 2) ** 3 / 2; // suavizado de entrada y salida
  camera.position.lerpVectors(transicion.desde, transicion.hasta, k);
  controls.target.lerpVectors(transicion.objetivoDesde, OBJETIVO_INICIAL, k);
  if (transicion.t >= 1) { transicion = null; controls.enabled = true; controls.enableDamping = true; }
}

// Enganches para la vista domo (cupula.js): si están puestos, reemplazan el dibujo del cuadro, el
// ajuste de tamaño y la escala de las partículas (en la vista domo se dibuja en las caras de un cubo).
export const ganchos = { render: null, ajustar: null, escalaPuntos: null };

// Tamaño en píxeles de una unidad a distancia 1: lo usan las nubes de partículas.
export function escalaPuntos() {
  if (ganchos.escalaPuntos) return ganchos.escalaPuntos();
  const h = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  return h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

// =====================================================================
// POSTPRODUCCIÓN — look de fotografía de los 80
// Orden: escena → bloom → filtro estrella → revelado (tono) → obturación lenta → lente y película
// (la estela va después del revelado para que se apague parejo, y antes del grano para no arrastrarlo)
// =====================================================================
const vsPantalla = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Filtro estrella: toma solo los brillos fuertes y los estira en dos ejes (cuatro puntas).
// Trabaja a un cuarto de resolución, así que cuesta muy poco.
class FiltroEstrella extends Pass {
  constructor() {
    super();
    const opt = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.rtBrillos = new THREE.WebGLRenderTarget(1, 1, opt);
    this.rtRayos = new THREE.WebGLRenderTarget(1, 1, opt);
    this.matBrillos = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uUmbral: { value: 1.0 } },
      vertexShader: vsPantalla,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uUmbral; varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv + uTexel * vec2( 1.0,  1.0)).rgb
                 + texture2D(tDiffuse, vUv + uTexel * vec2(-1.0,  1.0)).rgb
                 + texture2D(tDiffuse, vUv + uTexel * vec2( 1.0, -1.0)).rgb
                 + texture2D(tDiffuse, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
          c *= 0.25;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          gl_FragColor = vec4(min(c * max(l - uUmbral, 0.0) / max(l, 1e-4), vec3(20.0)), 1.0);
        }`,
    });
    this.matRayos = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uLargo: { value: 2.0 }, uAngulo: { value: 0.0 } },
      vertexShader: vsPantalla,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uLargo; uniform float uAngulo; varying vec2 vUv;
        void main() {
          vec2 d1 = vec2(cos(uAngulo), sin(uAngulo));
          vec2 d2 = vec2(-d1.y, d1.x);
          vec3 suma = vec3(0.0);
          float w = 1.0;
          for (int i = 1; i <= 24; i++) {
            w *= 0.9;
            vec2 o1 = d1 * uTexel * uLargo * float(i);
            vec2 o2 = d2 * uTexel * uLargo * float(i);
            suma += w * (texture2D(tDiffuse, vUv + o1).rgb + texture2D(tDiffuse, vUv - o1).rgb
                       + texture2D(tDiffuse, vUv + o2).rgb + texture2D(tDiffuse, vUv - o2).rgb);
          }
          gl_FragColor = vec4(suma * 0.07, 1.0);
        }`,
    });
    this.matMezcla = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tRayos: { value: null }, uIntensidad: { value: 0.5 } },
      vertexShader: vsPantalla,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse; uniform sampler2D tRayos; uniform float uIntensidad; varying vec2 vUv;
        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          gl_FragColor = vec4(base.rgb + texture2D(tRayos, vUv).rgb * uIntensidad, base.a);
        }`,
    });
    this.quad = new FullScreenQuad(this.matBrillos);
  }
  setSize(w, h) {
    const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
    this.rtBrillos.setSize(qw, qh);
    this.rtRayos.setSize(qw, qh);
    this.matBrillos.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.matRayos.uniforms.uTexel.value.set(1 / qw, 1 / qh);
  }
  render(renderer, writeBuffer, readBuffer) {
    this.matBrillos.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.matBrillos;
    renderer.setRenderTarget(this.rtBrillos);
    this.quad.render(renderer);

    this.matRayos.uniforms.tDiffuse.value = this.rtBrillos.texture;
    this.quad.material = this.matRayos;
    renderer.setRenderTarget(this.rtRayos);
    this.quad.render(renderer);

    this.matMezcla.uniforms.tDiffuse.value = readBuffer.texture;
    this.matMezcla.uniforms.tRayos.value = this.rtRayos.texture;
    this.quad.material = this.matMezcla;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

// Lente y película: aberración cromática en los bordes, gradación de color, viñeta y grano.
const LentePelicula = {
  uniforms: {
    tDiffuse: { value: null }, uTiempo: { value: 0 },
    uAberracion: { value: 1 }, uGradacion: { value: 0.5 }, uVineta: { value: 0.5 }, uGrano: { value: 0.06 },
    uRGB: { value: 0 },
  },
  vertexShader: vsPantalla,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTiempo;
    uniform float uAberracion; uniform float uGradacion; uniform float uVineta; uniform float uGrano; uniform float uRGB;
    varying vec2 vUv;
    float azar(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      // aberración cromática: los canales se separan solo hacia los bordes
      vec2 desp = c * r2 * uAberracion * 0.03;
      desp.x += uRGB; // desplazamiento RGB: toda la imagen, en horizontal
      vec3 col = vec3(texture2D(tDiffuse, vUv + desp).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - desp).b);
      // gradación: sombras magenta, medios cian, luces doradas
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 sombras = vec3(1.18, 0.74, 1.14), medios = vec3(0.80, 1.08, 1.12), luces = vec3(1.14, 1.0, 0.72);
      vec3 tinte = mix(mix(sombras, medios, smoothstep(0.0, 0.45, l)), luces, smoothstep(0.45, 1.0, l));
      vec3 grad = col * tinte + vec3(0.030, 0.006, 0.040) * (1.0 - l); // negros un poco lavados
      col = mix(col, grad, uGradacion);
      // viñeta
      col *= mix(1.0, smoothstep(0.85, 0.15, sqrt(r2)), uVineta);
      // grano de película (más visible en las sombras)
      float g = azar(gl_FragCoord.xy + fract(uTiempo) * 97.0) - 0.5;
      col += g * uGrano * (1.0 - 0.5 * l);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const tam = renderer.getDrawingBufferSize(new THREE.Vector2());
export const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(tam.x, tam.y, { type: THREE.HalfFloatType, samples: 4 })
);
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.45, 0.65, 0.85);
const estrella = new FiltroEstrella();
const lente = new ShaderPass(LentePelicula);
// Guarda: con reflejos metálicos muy intensos algún píxel puede salir infinito o inválido (NaN);
// el bloom lo esparce como un cuadrado de color y la estela lo mantiene vivo. Esta pasada
// barata limita el brillo y descarta esos píxeles antes de los efectos.
const limitar = new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: vsPantalla,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c.rgb))) c.rgb = vec3(0.0);
      gl_FragColor = vec4(min(c.rgb, vec3(40.0)), c.a);
    }`,
});
export const pasoEscena = new RenderPass(scene, camera); // la vista domo lo reemplaza por el suyo
composer.addPass(pasoEscena);
composer.addPass(limitar);
composer.addPass(bloom);
composer.addPass(estrella);
composer.addPass(new OutputPass()); // revelado: tone mapping + conversión a color de pantalla
const estela = new AfterimagePass(params.post.estela); // obturación lenta: mezcla cada cuadro con los anteriores
composer.addPass(estela);
composer.addPass(lente);

// Pulso del desplazamiento RGB: sube de golpe y vuelve suavemente a su nivel base.
let pulsoRGBValor = 0;
// Cada pulso fija un nivel (no se suma): con percusión rápida el efecto late en vez de quedarse fijo.
export function pulsoRGB(fuerza = 1) { pulsoRGBValor = Math.max(pulsoRGBValor, Math.min(fuerza, 1.5)); }

export function aplicarPost() {
  const p = params.post;
  bloom.strength = p.bloom.intensidad;
  bloom.radius = p.bloom.radio;
  bloom.threshold = p.bloom.umbral;
  bloom.enabled = p.bloom.intensidad > 0;
  estrella.matMezcla.uniforms.uIntensidad.value = p.estrella.intensidad;
  estrella.matRayos.uniforms.uLargo.value = p.estrella.largo;
  estrella.matRayos.uniforms.uAngulo.value = THREE.MathUtils.degToRad(p.estrella.angulo);
  estrella.matBrillos.uniforms.uUmbral.value = p.estrella.umbral;
  estrella.enabled = p.estrella.intensidad > 0;
  lente.uniforms.uGrano.value = p.grano;
  lente.uniforms.uVineta.value = p.vineta;
  lente.uniforms.uAberracion.value = p.aberracion;
  lente.uniforms.uGradacion.value = p.gradacion;
  estela.uniforms['damp'].value = p.estela;
  estela.enabled = p.estela > 0;
}
aplicarPost();

export function ajustarTamanoEscena() {
  if (ganchos.ajustar) return ganchos.ajustar();
  ajustarTamanoNormal();
}
export function ajustarTamanoNormal() {
  renderer.setPixelRatio(params.general.resolucion);
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setPixelRatio(params.general.resolucion);
  composer.setSize(window.innerWidth, window.innerHeight);
  const vertical = camera.aspect < 1;
  camera.aspect = proporcion();
  camera.fov = vistaInicial().fov;
  camera.updateProjectionMatrix();
  if (!Number.isFinite(camera.position.x + camera.position.y + camera.position.z)) {
    camera.position.copy(vistaInicial().posicion); // por si quedó inválida (ventana sin tamaño al abrir)
    controls.target.set(0, 0, 0);
  }
  if (vertical !== camera.aspect < 1) recentrar(); // al girar el celular, vuelve a la vista que corresponde
}

// Avanza todo lo que no depende de las piezas (destellos, estrellas, película) y dibuja el cuadro.
export function dibujar(dt, tiempo) {
  // los destellos orbitan despacio alrededor de las formas
  for (const l of destellos) {
    const u = l.userData, a = u.fase + tiempo * u.vel;
    l.position.set(Math.cos(a) * u.radio, u.alto + Math.sin(a * 1.7) * 1.2, Math.sin(a) * u.radio);
  }
  estrellas.rotation.y += dt * 0.004;
  lente.uniforms.uTiempo.value = tiempo;
  // desplazamiento RGB: nivel base + pulso que se apaga en la duración indicada
  const rgb = params.post.rgb;
  pulsoRGBValor *= Math.exp(-dt * 4 / rgb.duracion);
  lente.uniforms.uRGB.value = rgb.base + rgb.pulso * pulsoRGBValor;
  avanzarTransicion(dt);
  if (ganchos.render) { ganchos.render(dt); return; }
  controls.update();
  composer.render(dt);
}
