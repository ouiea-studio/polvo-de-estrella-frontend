// Parámetros de la dirección (URL), leídos una sola vez al cargar la página.
// Sirven para abrir Polvo de Estrella como FUENTE DE VIDEO (Resolume, TouchDesigner, OBS…) sin
// teclado ni ratón. Se pueden combinar: ?vista=domo&interfaz=0&rol=espectador
//  · vista=domo       → arranca en la vista fulldome (la misma de la tecla D). Ver cupula.js.
//  · interfaz=0       → arranca con toda la interfaz oculta (el estado "Nada" de la tecla H).
//  · rol=espectador   → solo mira: recibe el estado de la obra y el reloj compartido, no cuenta como
//                       tripulante, no crea módulos y nunca enciende el audio. El lienzo es un
//                       cuadrado (1:1) que llena la ventana (escena.js y cupula.js).
// Sin parámetros, la app funciona exactamente igual que antes.
//
// Dirección propia /domo (p. ej. https://polvo-de-estrella.onrender.com/domo): equivale a los tres
// juntos, sin escribir parámetros (para TouchDesigner y el proyector del domo). Cada uno se puede
// desactivar a mano: /domo?vista=normal, /domo?interfaz=1, /domo?rol=tripulante.
// Al compilar, vite.config.js copia la página en dist/domo/index.html para que Render la sirva.

const q = new URLSearchParams(location.search);
export const RUTA_DOMO = /^\/domo(\/(index\.html)?)?$/.test(location.pathname);

export const VISTA_DOMO = q.has('vista') ? q.get('vista') === 'domo' : RUTA_DOMO;
export const SIN_INTERFAZ = q.has('interfaz') ? q.get('interfaz') === '0' : RUTA_DOMO;
export const ESPECTADOR = q.has('rol') ? q.get('rol') === 'espectador' : RUTA_DOMO;

if (ESPECTADOR) document.body.dataset.rol = 'espectador';
// Con la interfaz oculta desde la dirección (o como espectador) tampoco se ve el cursor mientras la
// interfaz esté en "Nada" (estilo.css). Si alguien pulsa H, el cursor vuelve con la interfaz.
if (SIN_INTERFAZ || ESPECTADOR) document.body.dataset.sinCursor = '1';
