/****************************************************************
 *  ARSAN MOTORS · Órdenes de servicio — Backend v26 (Netlify)
 *  v26: liga del cliente (/o/<llave>) con autorización en línea. Ver "v26 · LIGA DEL CLIENTE".
 *  v27: precios — catálogo oficial (sólo dirección lo edita), solicitudes de precio e historial
 *       de lo cotizado. Ver "v27 · PRECIOS".
 *
 *  Reemplaza al Apps Script como backend de la app. Habla EXACTAMENTE
 *  el mismo idioma que el Apps Script de v23 (mismas acciones, mismas
 *  respuestas), así la app casi no cambió por dentro.
 *
 *  Dónde vive cada cosa (Netlify Blobs):
 *    store "ordenes"  → idx (resumen de todas las órdenes), o/<id> (orden
 *                       completa), borradas/<id>, usuarios, ses/<token>,
 *                       tok/<token>, bit/<fecha>_<n> (bitácora), clientes,
 *                       componentes, cobranza_gs, config,
 *                       catalogo, catalogo_sol, precios_hist (v27)
 *    store "medios"   → fotos y firmas (una por llave, binario)
 *
 *  Google se queda como PUENTE (no frena la app):
 *    · Respaldo de fotos en Drive y espejo en Sheets: el Apps Script viene
 *      cada 10 min por los cambios (acción "cambios") y los copia.
 *    · Machote del cotizador GS: la app se lo pide directo al Apps Script.
 *
 *  Variables de entorno en Netlify:
 *    PIN_EDICION     clave para modificar órdenes cerradas y borrar (obligatoria)
 *    PUENTE_SECRETO  la misma frase que va en el Apps Script (obligatoria)
 *    PUENTE_URL      URL /exec del Apps Script (para el machote)
 *    WA_TALLER       (v26, opcional) WhatsApp del taller, 10 dígitos: el cliente le contesta ahí
 *    WA_ARREZ        (v26, opcional) WhatsApp de Servicio Arrez (si no, usa WA_TALLER)
 *    CLAVE           clave de la app (por omisión "arsan")
 ****************************************************************/
import { getStore } from "@netlify/blobs";

const BACKEND_VERSION = "2026-10-23-v27.2";
const ETAPAS_ORDEN = ["cita", "recepcion", "cotizado", "aprobado", "finalizado", "entregado"];
const CANDADO_DESDE = "aprobado";
const HORAS_SESION = 12;
const MIN_PERMISO = 20;
const TZ = "America/Mexico_City";
const MAX_MEDIA = 4 * 1024 * 1024; // 4 MB por foto (las de la app pesan ~100 KB)

/* ------------------------- utilidades ------------------------- */
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
const env = (k, d = "") => {
  try { const v = Netlify.env.get(k); return v == null || v === "" ? d : v; } catch { return d; }
};
const S = () => getStore({ name: "ordenes", consistency: "strong" });
const M = () => getStore({ name: "medios", consistency: "strong" });
const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nz = (x) => { const n = Number(x); return isNaN(n) ? 0 : n; };

async function sha256hex(txt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(txt)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const esHash = (v) => /^[0-9a-f]{64}$/.test(String(v || ""));
function fechaHora(ts = now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}` };
}
// 'YYYY-MM-DD' → ms a medianoche de CDMX
function isoMs(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(String(iso))) return 0;
  const t = Date.parse(String(iso).slice(0, 10) + "T00:00:00-06:00");
  return isNaN(t) ? 0 : t;
}

async function getJSON(store, key) {
  try { return await store.get(key, { type: "json" }); } catch { return null; }
}
// Escritura condicional: dos equipos guardando al mismo tiempo no se pisan
async function mutate(store, key, init, fn) {
  for (let i = 0; i < 15; i++) {
    const r = await store.getWithMetadata(key, { type: "json" });
    const doc = r && r.data ? r.data : init();
    const out = await fn(doc);
    if (out === undefined) return undefined;
    const w = await store.setJSON(key, doc, r ? { onlyIfMatch: r.etag } : { onlyIfNew: true });
    if (w && w.modified) return out;
    await sleep(60 + Math.random() * 200);
  }
  throw new Error("El sistema está guardando otra orden en este momento. Intenta de nuevo en unos segundos.");
}

/* -------- fotos: la app manda URL absolutas, aquí se guardan relativas -------- */
const REL = /^\/api\/m\/[A-Za-z0-9_-]+$/;
const ABS = /^https?:\/\/[^/]+(\/api\/m\/[A-Za-z0-9_-]+)$/;
function deepMap(x, f) {
  if (typeof x === "string") return f(x);
  if (Array.isArray(x)) return x.map((y) => deepMap(y, f));
  if (x && typeof x === "object") { const o = {}; for (const k in x) o[k] = deepMap(x[k], f); return o; }
  return x;
}
const normIn = (o) => deepMap(o, (s) => { const m = ABS.exec(s); return m ? m[1] : s; });
const absOut = (o, origin) => deepMap(o, (s) => (REL.test(s) ? origin + s : s));
const esUrl = (s) => typeof s === "string" && (REL.test(s) || s.indexOf("http") === 0);

async function guardarMedio(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(String(dataUrl || ""));
  if (!m) return "";
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  if (!bytes.length || bytes.length > MAX_MEDIA) return "";
  const key = "u_" + (await sha256hex(m[2])).slice(0, 40);
  const st = M();
  const ya = await st.getMetadata(key).catch(() => null);
  if (!ya) await st.set(key, bytes.buffer, { metadata: { type: m[1], creado: now() } });
  return "/api/m/" + key;
}
async function listaMedios(arr) {
  const out = [];
  for (const x of arr || []) {
    let u = "";
    if (esUrl(x)) u = x;
    else if (typeof x === "string" && x.indexOf("data:") === 0) u = await guardarMedio(x);
    if (u) out.push(u);
  }
  return out;
}
async function firma(sig, prev) {
  if (typeof sig === "string" && sig.indexOf("data:") === 0) return (await guardarMedio(sig)) || prev || "";
  if (esUrl(sig)) return sig;
  return prev || "";
}

/* ------------------------- sesiones ------------------------- */
async function sesionValida(token) {
  if (!token) return { ok: false };
  const st = S();
  const d = await getJSON(st, "ses/" + token);
  if (!d || d.exp < now()) return { ok: false };
  if (d.exp - now() < (HORAS_SESION / 2) * 3600e3) { d.exp = now() + HORAS_SESION * 3600e3; await st.setJSON("ses/" + token, d); }
  return { ok: true, usuario: d.u, nombre: d.n, rol: d.r };
}
const usuarioTxt = (ses) => (ses && ses.ok ? `${ses.nombre} (${ses.usuario})` : "—");

async function login(usuario, password) {
  usuario = String(usuario || "").trim().toLowerCase();
  password = String(password || "");
  if (!usuario || !password) return { ok: false, error: "Escribe usuario y contraseña" };
  const st = S();
  const doc = await getJSON(st, "usuarios");
  const lista = (doc && doc.lista) || [];
  if (!lista.length) return { ok: false, error: "No hay usuarios dados de alta todavía. Corre la migración de usuarios." };
  const u = lista.find((x) => String(x.usuario || "").trim().toLowerCase() === usuario);
  if (!u) return { ok: false, error: "Usuario o contraseña incorrectos" };
  if (String(u.activo || "si").trim().toLowerCase() === "no") return { ok: false, error: "Este usuario está desactivado" };
  const g = String(u.password || "");
  const ok = esHash(g) ? (await sha256hex(password)) === g : password === g;
  if (!ok) return { ok: false, error: "Usuario o contraseña incorrectos" };
  const token = uuid();
  await st.setJSON("ses/" + token, { u: usuario, n: String(u.nombre || usuario), r: String(u.rol || ""), exp: now() + HORAS_SESION * 3600e3 });
  await logBitacora({ que: "INICIO DE SESIÓN", antes: "Usuario: " + usuario });
  return { ok: true, sesion: token, nombre: String(u.nombre || usuario), rol: String(u.rol || ""), horas: HORAS_SESION };
}

/* ------------------------- bitácora ------------------------- */
async function logBitacora(e) {
  const t = now();
  const fh = fechaHora(t);
  const row = { fecha: fh.fecha, hora: fh.hora, folio: "", evento: "", placas: "", sucursal: "", etapa: "", que: "", antes: "", despues: "", ...e };
  row.antes = String(row.antes || "").slice(0, 4000);
  row.despues = String(row.despues || "").slice(0, 4000);
  try { await S().setJSON(`bit/${String(t).padStart(15, "0")}_${Math.random().toString(36).slice(2, 8)}`, row); } catch {}
}
const ctxOrden = (o) => ({ folio: o.folio || "", evento: o.evento || "", placas: (o.vehiculo && o.vehiculo.placas) || "", sucursal: o.sucursal || "" });

/* ------------------- candado de edición (igual que v23) ------------------- */
function estaBloqueada(estatus) {
  const i = ETAPAS_ORDEN.indexOf(String(estatus || "")), c = ETAPAS_ORDEN.indexOf(CANDADO_DESDE);
  return i >= 0 && c >= 0 && i >= c;
}
async function autorizar(pin) {
  const PIN = env("PIN_EDICION");
  if (!PIN) return { ok: false, error: "No hay clave configurada (variable PIN_EDICION en Netlify)" };
  if (String(pin || "") !== String(PIN)) return { ok: false, error: "Clave incorrecta" };
  const token = uuid();
  await S().setJSON("tok/" + token, { exp: now() + MIN_PERMISO * 60e3 });
  return { ok: true, token, mins: MIN_PERMISO };
}
async function tokenValido(token) {
  if (!token) return false;
  const d = await getJSON(S(), "tok/" + token);
  return !!(d && d.exp > now());
}
const cnt = (x) => (Array.isArray(x) ? x.length : x || 0);
function snapProtegido(o, prevEstatus) {
  o = o || {};
  const c = o.cliente || {}, v = o.vehiculo || {}, s = o.servicio || {}, di = o.diagnostico || {}, co = o.cotizacion || {};
  const fi = o.finalizado || {}, k = o.costos || {}, ec = o.entregaCheck || {};
  const items = (co.items || []).map((it) => [it.concepto || "", it.componente || "", nz(it.cantidad), nz(it.precio)].join("|")).join("~");
  const out = {
    "datos del cliente": [c.nombre || "", c.tel || "", c.correo || ""].join("|"),
    "datos del vehículo": [v.marca || "", v.modelo || "", v.anio || "", v.placas || "", v.vin || "", v.km || ""].join("|"),
    "servicio solicitado": [s.motivo || "", s.asesor || ""].join("|"),
    "folio / evento / fecha": [o.folio || "", o.evento || "", o.fecha || ""].join("|"),
    "diagnóstico": String(di.texto || ""),
    "partidas de la cotización": items,
    "total de la cotización": String(co.total != null && co.total !== "" ? v26r2(co.total) : ""), // v26.3: al centavo (las órdenes viejas traen fracciones)
    "evidencia de recepción": String(cnt(o.fotos)),
    "evidencia de diagnóstico": String(cnt(di.fotos)),
  };
  if (prevEstatus === "finalizado" || prevEstatus === "entregado") {
    out["costo del servicio"] = [k.refacciones || "", k.manoObra || "", k.otros || "", k.proveedor || ""].join("|");
    out["evidencia de trabajo finalizado"] = [String(cnt(fi.fotos)), fi.notas || ""].join("|");
  }
  if (prevEstatus === "entregado") out["checklist de entrega"] = JSON.stringify(ec.items || {});
  return out;
}
function diffProtegido(prev, o) {
  const pe = String((prev && prev.estatus) || "");
  const a = snapProtegido(prev, pe), b = snapProtegido(o, pe), out = [];
  for (const k in a) if (String(a[k]) !== String(b[k])) out.push(k);
  const ia = ETAPAS_ORDEN.indexOf(pe), ib = ETAPAS_ORDEN.indexOf(String(o.estatus || ""));
  if (ia >= 0 && ib >= 0 && ib < ia) out.push("etapa (retroceso a " + o.estatus + ")");
  return out;
}

/* ------------------- multipuntos y entrega (reglas en el backend) ------------------- */
const MP_VIGENCIA = "30 días o 1,000 km";
const MP_UMBRALES = {
  balata: { verde: 7, amarillo: 3, incl: false },
  llanta: { verde: 4, amarillo: 2, incl: false },
  bateria: { verde: 12.6, amarillo: 12.2, incl: true },
};
function colorPorMedicion(tipo, medicion, manual) {
  const u = MP_UMBRALES[tipo];
  if (!u || medicion === "" || medicion == null) return manual || "";
  const n = Number(String(medicion).replace(",", "."));
  if (isNaN(n)) return manual || "";
  if (u.incl ? n >= u.verde : n > u.verde) return "verde";
  if (n >= u.amarillo) return "amarillo";
  return "rojo";
}
function evaluarMultipuntos(puntos) {
  const out = [], c = { verde: 0, amarillo: 0, rojo: 0, na: 0, sin: 0 };
  for (const p0 of puntos || []) {
    const p = { ...(p0 || {}) };
    p.estatus = colorPorMedicion(p.tipo, p.medicion, p.estatus) || "";
    if (p.estatus in c && p.estatus !== "sin") c[p.estatus]++; else c.sin++;
    out.push(p);
  }
  return { ok: true, puntos: out, conteo: c, vigencia: MP_VIGENCIA,
    urgente: out.filter((p) => p.estatus === "rojo"), foco: out.filter((p) => p.estatus === "amarillo") };
}
function evaluarEntrega(ec) {
  const items = (ec && ec.items) || {}, c = { ok: 0, atencion: 0, sin: 0, faltanNota: 0 };
  for (const k in items) {
    const it = items[k] || {};
    if (it.e === "ok") c.ok++;
    else if (it.e === "atencion") { c.atencion++; if (!String(it.n || "").trim()) c.faltanNota++; }
    else c.sin++;
  }
  return c;
}

/* ------------------------- resumen para la lista ------------------------- */
function ingreso(o) {
  const co = o.cotizacion || {};
  return co.subtotal != null && co.subtotal !== "" ? nz(co.subtotal) : co.iva ? nz(co.total) / 1.16 : nz(co.total);
}
function etapaDesdeDerivada(o) {
  const di = o.diagnostico || {}, ap = o.aprobacion || {}, fi = o.finalizado || {}, sal = o.salida || {};
  const m = { cita: o.fecha, recepcion: o.fecha, cotizado: di.fecha || o.fecha, aprobado: ap.fecha || di.fecha || o.fecha,
    finalizado: fi.fecha || ap.fecha || o.fecha, entregado: sal.fecha || fi.fecha || o.fecha };
  return isoMs(m[o.estatus || "recepcion"]) || o.createdAt || 0;
}
function resumen(o) {
  const c = o.cliente || {}, v = o.vehiculo || {}, fl = o.flotilla || {}, co = o.cotizacion || {}, ct = o.costos || {};
  const pg = o.pago || {}, en = o.encuesta || {}, s = o.servicio || {}, di = o.diagnostico || {}, ap = o.aprobacion || {};
  const fi = o.finalizado || {}, sal = o.salida || {};
  return {
    id: o.id, folio: o.folio || "", fecha: o.fecha || "", hora: o.hora || "", sucursal: o.sucursal || "", evento: o.evento || "",
    estatus: o.estatus || "recepcion", cliente: c.nombre || "", tel: c.tel || "", flotilla: fl.nombre || "", eco: fl.eco || "",
    marca: v.marca || "", modelo: v.modelo || "", anio: v.anio || "", placas: v.placas || "", vin: v.vin || "",
    total: nz(co.total), calif: nz(en.calificacion), sub: Math.round(ingreso(o) * 100) / 100,
    costo: nz(ct.refacciones) + nz(ct.manoObra) + nz(ct.otros),
    pagoEstado: pg.estado || "", cobrado: nz(pg.cobrado), saldo: nz(pg.saldo), vence: pg.fechaCompromiso || "",
    driveUrl: o.driveUrl || "", createdAt: o.createdAt || 0,
    asesor: s.asesor || "", tecnico: (o.multipuntos && o.multipuntos.tecnico) || "", motivo: String(s.motivo || "").slice(0, 140),
    fDx: di.fecha || "", fAp: ap.fecha || "", fFin: fi.fecha || "", fSal: sal.fecha || "",
    km: v.km || "", dx: String(di.texto || "").slice(0, 160),
    etapaDesde: o._etapaDesde || etapaDesdeDerivada(o), _u: o._u || 0, prueba: !!o._prueba,
    // v25: fotos del taller
    rev: o._rev || 0, color: v.color || "", fotosRec: fotosDeSeccion(o, "recepcion").length || nz(o.fotos), v25: !!o._v25, tf: o._tf || 0,
    // v26: liga del cliente
    ac: resumenAut(o), cl: !!(o.cli && o.cli.tok), cv: nz((o.cli || {}).visto),
    sol: (o.solicitudesFotos || []).filter((s) => s.estado === "pendiente" || s.estado === "recibida")
      .map((s) => ({ id: s.id, sec: s.sec, para: s.para || "", paraNombre: s.paraNombre || "", estado: s.estado, nota: String(s.nota || "").slice(0, 160),
        ts: s.ts || 0, tsSubida: s.tsSubida || 0, subioNombre: s.subioNombre || "", n: (s.fotos || []).length, origen: s.origen || "admin" })),
  };
}

/* =====================================================================
   v25 · FOTOS DEL TALLER
   Administración (en oficinas) pide fotos de una orden; el técnico (en el
   taller) las toma y las sube. El técnico NO ve cliente, diagnóstico,
   cotización ni pagos: con rol "tecnico" sólo puede usar las acciones tec*.
   Las fotos del técnico entran a la sección que pidió administración:
     recepcion   → evidencia de recepción     (o.fotosUrls)
     diagnostico → evidencia del diagnóstico  (o.diagnostico.fotosUrls)
     evidencias  → evidencia del trabajo      (o.finalizado.fotosUrls)
   o._tecFotos guarda qué fotos subió el taller, para que un teléfono de
   oficina que todavía no las ha visto no las borre al guardar la orden.
   ===================================================================== */
const SECCIONES = { recepcion: "Recepción", diagnostico: "Diagnóstico", evidencias: "Evidencias del trabajo" };
const SEC_MEDIA = { recepcion: "reception", diagnostico: "diagnostico", evidencias: "finalizado" };
const ROLES_TECNICO = ["tecnico", "técnico", "tecnicos", "técnicos", "mecanico", "mecánico", "taller"];
const esTecnico = (rol) => ROLES_TECNICO.includes(String(rol || "").trim().toLowerCase());
const ETAPAS_TALLER = ["recepcion", "cotizado", "aprobado", "finalizado"];
const ETAPAS_AVANCE = ["cotizado", "aprobado", "finalizado", "entregado"];
const ETAPAS_BLOQUEO = ["cotizado", "aprobado", "finalizado"]; // entregar sin servicio (salida directa) sí se permite
const MAX_TEC_FOTOS = 24;

// Lista de URLs guardadas de una sección (formato del servidor)
function fotosDeSeccion(o, sec) {
  if (!o) return [];
  const a = sec === "recepcion" ? o.fotosUrls : sec === "diagnostico" ? (o.diagnostico || {}).fotosUrls : (o.finalizado || {}).fotosUrls;
  return Array.isArray(a) ? a : [];
}
function ponerFotosSeccion(o, sec, lista) {
  if (sec === "recepcion") { o.fotosUrls = lista; o.fotos = lista.length; return; }
  const k = sec === "diagnostico" ? "diagnostico" : "finalizado";
  o[k] = o[k] || {};
  o[k].fotosUrls = lista; o[k].fotos = lista.length;
}
// Lista de la sección tal como la manda la app (fotos: data:/URL/'local')
function arrCliente(o, sec) {
  if (sec === "recepcion") return o.fotos;
  const k = sec === "diagnostico" ? "diagnostico" : "finalizado";
  return o[k] ? o[k].fotos : undefined;
}
function ponerArrCliente(o, sec, arr) {
  if (sec === "recepcion") { o.fotos = arr; return; }
  const k = sec === "diagnostico" ? "diagnostico" : "finalizado";
  o[k] = o[k] || {};
  o[k].fotos = arr;
}
// Fotos que subió el taller y que este teléfono todavía no ha visto → se agregan a lo que manda
function mezclarFotosTaller(o, prev) {
  const tf = (prev && prev._tecFotos) || {};
  const vistos = (o && o._tecFotos) || {};
  for (const sec in SECCIONES) {
    const nuevas = (tf[sec] || []).filter((u) => (vistos[sec] || []).indexOf(u) < 0);
    if (!nuevas.length) continue;
    const arr = arrCliente(o, sec);
    if (!Array.isArray(arr)) { ponerArrCliente(o, sec, fotosDeSeccion(prev, sec).slice()); continue; }
    for (const u of nuevas) if (arr.indexOf(u) < 0) arr.push(u);
  }
}
const nuevoId = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sinFotosRecepcion = (o) => !fotosDeSeccion(o, "recepcion").length && !nz(o.fotos);

async function actualizarIdx(o) {
  await mutate(S(), "idx", idxInit, async (idx) => { if (!idx.o[o.id]) return undefined; idx.o[o.id] = resumen(o); return true; });
}
// Lee-modifica-escribe una orden sin pisar a otro equipo que guarde al mismo tiempo
async function mutarOrden(id, fn) {
  const st = S();
  for (let i = 0; i < 15; i++) {
    const r = await st.getWithMetadata("o/" + id, { type: "json" });
    if (!r || !r.data) return { ok: false, error: "Orden no encontrada" };
    const res = await fn(r.data);
    if (!res || res.ok === false) return res || { ok: false, error: "Sin cambios" };
    const w = await st.setJSON("o/" + id, r.data, { onlyIfMatch: r.etag });
    if (w && w.modified) { await actualizarIdx(r.data); return { ...res, orden: r.data }; }
    await sleep(60 + Math.random() * 200);
  }
  throw new Error("La orden se está guardando en otro equipo. Intenta de nuevo en unos segundos.");
}

/* ---- Administración: pedir, revisar, cerrar ---- */
async function pedirFotos(b, ses) {
  const sec = String(b.sec || "");
  if (!SECCIONES[sec]) return { ok: false, error: "Sección inválida" };
  const sol = {
    id: nuevoId(), sec, para: String(b.para || "").trim().toLowerCase(), paraNombre: String(b.paraNombre || "").slice(0, 80),
    nota: String(b.nota || "").slice(0, 500), pidio: ses.usuario, pidioNombre: ses.nombre, ts: now(), estado: "pendiente",
    fotos: [], origen: "admin", rondas: 1,
  };
  const r = await mutarOrden(b.id, (o) => {
    if (o.estatus === "entregado") return { ok: false, error: "La orden ya se entregó" };
    o.solicitudesFotos = o.solicitudesFotos || [];
    o.solicitudesFotos.push(sol);
    return { ok: true };
  });
  if (!r.ok) return r;
  await logBitacora({ ...ctxOrden(r.orden), etapa: r.orden.estatus || "", que: "SOLICITUD DE FOTOS AL TALLER",
    antes: `${SECCIONES[sec]} · para: ${sol.paraNombre || "cualquier técnico"} · pidió: ${usuarioTxt(ses)}`, despues: sol.nota });
  return { ok: true, solicitud: sol };
}
async function cambiarSolicitud(b, ses) {
  const acc = String(b.accion || "");
  if (["cerrar", "repetir", "cancelar"].indexOf(acc) < 0) return { ok: false, error: "Acción inválida" };
  let sol = null;
  const r = await mutarOrden(b.id, (o) => {
    sol = (o.solicitudesFotos || []).find((s) => s.id === b.sol);
    if (!sol) return { ok: false, error: "Solicitud no encontrada" };
    if (acc === "cerrar") { sol.estado = "cerrada"; sol.tsCierre = now(); sol.cerro = ses.nombre; }
    if (acc === "cancelar") { sol.estado = "cancelada"; sol.tsCierre = now(); sol.cerro = ses.nombre; }
    if (acc === "repetir") {
      sol.estado = "pendiente"; sol.rondas = (sol.rondas || 1) + 1; sol.ts = now();
      sol.historial = (sol.historial || []).concat([{ nota: sol.nota, fotos: (sol.fotos || []).length, subio: sol.subioNombre || "", ts: sol.tsSubida || 0 }]);
      if (b.nota != null && String(b.nota).trim()) sol.nota = String(b.nota).slice(0, 500);
      sol.tsSubida = 0;
    }
    return { ok: true };
  });
  if (!r.ok) return r;
  await logBitacora({ ...ctxOrden(r.orden), etapa: r.orden.estatus || "", que: "SOLICITUD DE FOTOS · " + acc.toUpperCase(),
    antes: `${SECCIONES[sol.sec] || sol.sec} · ${usuarioTxt(ses)}`, despues: acc === "repetir" ? sol.nota : "" });
  return { ok: true, solicitud: sol };
}
async function listaSolicitudes() {
  const idx = (await getJSON(S(), "idx")) || idxInit();
  const out = [];
  for (const r of Object.values(idx.o)) for (const s of r.sol || [])
    out.push({ ...s, orden: r.id, folio: r.folio, placas: r.placas, marca: r.marca, modelo: r.modelo, estatus: r.estatus, sucursal: r.sucursal });
  const aut = Object.values(idx.o).filter((r) => r.ac).map((r) => ({ ...r.ac, orden: r.id, folio: r.folio, placas: r.placas, marca: r.marca, modelo: r.modelo, cliente: r.cliente }))
    .sort((a, b) => b.ts - a.ts);
  return { ok: true, solicitudes: out.sort((a, b) => (b.tsSubida || b.ts) - (a.tsSubida || a.ts)), autorizaciones: aut };
}
async function listaTecnicos() {
  const u = await getJSON(S(), "usuarios");
  return { ok: true, tecnicos: ((u && u.lista) || []).filter((x) => esTecnico(x.rol) && String(x.activo || "si").toLowerCase() !== "no")
    .map((x) => ({ usuario: x.usuario, nombre: x.nombre || x.usuario })) };
}

/* ---- Técnico: sólo ve lo mínimo ---- */
const unidadTec = (r) => ({ id: r.id, folio: r.folio, placas: r.placas, marca: r.marca, modelo: r.modelo, anio: r.anio, color: r.color || "",
  estatus: r.estatus, sucursal: r.sucursal, cliente: r.cliente || "", flotilla: r.flotilla || "", eco: r.eco || "" });
async function vistaTecnico(ses) {
  const idx = (await getJSON(S(), "idx")) || idxInit();
  const pendientes = [], unidades = [];
  for (const r of Object.values(idx.o)) {
    if (ETAPAS_TALLER.indexOf(r.estatus || "recepcion") < 0) continue;
    unidades.push(unidadTec(r));
    for (const s of r.sol || [])
      if (s.estado === "pendiente" && (!s.para || s.para === ses.usuario))
        pendientes.push({ ...unidadTec(r), sol: s.id, sec: s.sec, secNombre: SECCIONES[s.sec] || s.sec, nota: s.nota, ts: s.ts, paraMi: !!s.para });
  }
  pendientes.sort((a, b) => a.ts - b.ts);
  unidades.sort((a, b) => String(a.placas).localeCompare(String(b.placas)));
  return { ok: true, pendientes, unidades };
}
/* v25.1 · Lo que ve el técnico: cliente (sólo nombre y flotilla), vehículo completo, servicio,
   daños, observaciones, inventario, diagnóstico, trabajos a realizar SIN precios, multipuntos,
   checklist de entrega y fotos. NUNCA: teléfono/correo/fiscales, precios, totales, costos,
   pagos, cobranza ni encuesta. Se arma con lista blanca: lo que no está aquí, no viaja. */
const ITEM_TEC = ["concepto", "componente", "cantidad", "marca", "tipoTrabajo", "urgencia", "tipoServicio"];
function proyeccionTecnico(o, ses) {
  const v = o.vehiculo || {}, s = o.servicio || {}, fl = o.flotilla || {}, di = o.diagnostico || {}, fi = o.finalizado || {};
  const ec = o.entregaCheck || null, mp = o.multipuntos || null;
  const pick = (x, ks) => { const r = {}; for (const k of ks) if (x && x[k] != null && x[k] !== "") r[k] = x[k]; return r; };
  return {
    id: o.id, folio: o.folio || "", sucursal: o.sucursal || "", estatus: o.estatus || "recepcion", fecha: o.fecha || "", hora: o.hora || "",
    evento: o.evento || "", _rev: nz(o._rev),
    // planos (app del técnico)
    placas: v.placas || "", marca: v.marca || "", modelo: v.modelo || "", anio: v.anio || "", color: v.color || "",
    motivo: s.motivo || "", danos: o.estado || "",
    // anidados (para reutilizar las pantallas de multipuntos y checklist)
    cliente: { nombre: (o.cliente || {}).nombre || "" },
    flotilla: pick(fl, ["nombre", "eco"]),
    vehiculo: pick(v, ["marca", "modelo", "anio", "color", "placas", "vin", "km", "fuel", "fuelLabel", "tarjeta"]),
    servicio: pick(s, ["motivo", "asesor"]),
    estado: o.estado || "", observaciones: o.observaciones || "",
    inventario: o.inventario || null, inventarioStr: o.inventarioStr || "",
    fotosUrls: fotosDeSeccion(o, "recepcion"),
    diagnostico: di.texto || (di.fotosUrls || []).length ? { texto: di.texto || "", fecha: di.fecha || "", porTecnico: di.porTecnico || "", fotosUrls: di.fotosUrls || [] } : null,
    trabajos: ((o.cotizacion || {}).items || []).map((it) => pick(it, ITEM_TEC)),
    cotizacion: { items: ((o.cotizacion || {}).items || []).map((it) => pick(it, ["concepto", "componente", "cantidad"])) }, // enPendientes() la usa
    aprobada: !!((o.aprobacion || {}).fecha),
    finalizado: (fi.fotosUrls || []).length || fi.notas ? { notas: fi.notas || "", fotosUrls: fi.fotosUrls || [] } : null,
    multipuntos: mp,
    entregaCheck: ec ? { items: ec.items || {}, total: ec.total, responsable: ec.responsable || "", km: ec.km || "", fuel: ec.fuel,
      fotos: ec.fotosUrls || {}, firmaTecnico: ec.firmaTecnicoUrl || "", firmaCliente: ec.firmaClienteUrl || "",
      pendientes: ec.pendientes || [], fecha: ec.fecha || "", hora: ec.hora || "" } : null,
    solicitudes: (o.solicitudesFotos || []).filter((x) => x.estado === "pendiente" && (!x.para || x.para === ses.usuario))
      .map((x) => ({ id: x.id, sec: x.sec, secNombre: SECCIONES[x.sec] || x.sec, nota: x.nota, ts: x.ts, pidio: x.pidioNombre || "" })),
  };
}
async function ordenTecnico(id, ses) {
  const o = await getJSON(S(), "o/" + id);
  if (!o || ETAPAS_TALLER.indexOf(o.estatus || "recepcion") < 0) return { ok: false, error: "Esta unidad ya no está en el taller" };
  return { ok: true, orden: proyeccionTecnico(o, ses) };
}
/* v25.1 · El técnico guarda SÓLO multipuntos y checklist de entrega (lista blanca).
   Cualquier otro campo que mande su teléfono se ignora. */
async function tecGuardar(o0, ses) {
  if (!o0 || !o0.id) return { ok: false, error: "Orden sin id" };
  const o = normIn(o0), m = o.media || {};
  const hechos = [];
  const r = await mutarOrden(o.id, async (cur) => {
    hechos.length = 0;
    if (ETAPAS_TALLER.indexOf(cur.estatus || "recepcion") < 0) return { ok: false, error: "Esta unidad ya no está en el taller" };
    if (o.multipuntos && Array.isArray(o.multipuntos.puntos) && JSON.stringify(o.multipuntos.puntos) !== JSON.stringify((cur.multipuntos || {}).puntos || [])) {
      if (estaBloqueada(cur.estatus)) return { ok: false, error: "La orden ya está aprobada: la inspección sólo la puede cambiar oficina." };
      const ev = evaluarMultipuntos(o.multipuntos.puntos);
      cur.multipuntos = { puntos: ev.puntos, conteo: ev.conteo, vigencia: ev.vigencia, tecnico: String(o.multipuntos.tecnico || ses.nombre).slice(0, 80),
        fecha: String(o.multipuntos.fecha || fechaHora().fecha) };
      hechos.push(["INSPECCIÓN MULTIPUNTOS", `Verdes: ${ev.conteo.verde} · Amarillos: ${ev.conteo.amarillo} · Rojos: ${ev.conteo.rojo}`]);
    }
    if ((m.entrega || m.finalizado) && o.entregaCheck && o.entregaCheck.items) {
      const ec = o.entregaCheck, p = extractUrls(cur);
      const salida = {};
      const f = typeof ec.fotos === "object" && ec.fotos ? ec.fotos : {};
      for (const k in f) { const u = await firma(f[k], p.salida[k]); if (u) salida[k] = u; }
      const urls = { salida, firmaT: await firma(ec.firmaTecnico, p.firmaT), firmaE: await firma(ec.firmaCliente, p.firmaE) };
      const x = stripMedia({ entregaCheck: {
        items: ec.items, total: ec.total, responsable: String(ec.responsable || "").slice(0, 80), km: ec.km, fuel: ec.fuel,
        fotos: ec.fotos, firmaTecnico: ec.firmaTecnico, firmaCliente: ec.firmaCliente, pendientes: Array.isArray(ec.pendientes) ? ec.pendientes : [],
        fecha: ec.fecha || fechaHora().fecha, hora: ec.hora || fechaHora().hora } }, urls);
      if (JSON.stringify(x.entregaCheck) !== JSON.stringify(cur.entregaCheck || null)) {
        cur.entregaCheck = x.entregaCheck;
        const c = evaluarEntrega(x.entregaCheck);
        hechos.push(["CHECKLIST DE ENTREGA", `OK: ${c.ok} · Atención: ${c.atencion} · Sin marcar: ${c.sin}`]);
      }
    }
    if (!hechos.length) return { ok: true };
    cur._rev = nz(cur._rev) + 1; cur._revPor = usuarioTxt(ses); cur._revDev = String(o._dev || ""); cur._revTs = now(); cur._u = now();
    return { ok: true };
  });
  if (!r.ok) return r;
  for (const [que, despues] of hechos)
    await logBitacora({ ...ctxOrden(r.orden), etapa: r.orden.estatus || "", que, antes: "Capturó en taller: " + usuarioTxt(ses), despues });
  return { ok: true, folio: r.orden.folio || "", drive: r.orden.driveUrl || "", rev: nz(r.orden._rev), urls: {}, v25: !!r.orden._v25 };
}
/* v25.1 · El técnico escribe el diagnóstico (sólo el texto; oficina arma la cotización con montos) */
async function tecDiagnostico(b, ses) {
  const texto = String(b.texto || "").trim().slice(0, 4000);
  let antes = "";
  const r = await mutarOrden(b.id, (cur) => {
    if (["recepcion", "cotizado"].indexOf(cur.estatus || "recepcion") < 0) return { ok: false, error: "La orden ya fue aprobada: el diagnóstico sólo lo puede cambiar oficina." };
    const di = cur.diagnostico || {};
    antes = di.texto || "";
    if (antes === texto) return { ok: true };
    const fh = fechaHora();
    cur.diagnostico = { ...di, texto, fecha: di.fecha || fh.fecha, hora: di.hora || fh.hora.slice(0, 5), porTecnico: ses.nombre };
    cur._rev = nz(cur._rev) + 1; cur._revPor = usuarioTxt(ses); cur._revDev = String(b._dev || ""); cur._revTs = now(); cur._u = now();
    return { ok: true };
  });
  if (!r.ok) return r;
  if (antes !== texto) await logBitacora({ ...ctxOrden(r.orden), etapa: r.orden.estatus || "", que: "DIAGNÓSTICO DEL TÉCNICO", antes: antes ? "Antes: " + antes : "Capturó: " + usuarioTxt(ses), despues: texto });
  return { ok: true, rev: nz(r.orden._rev) };
}
async function tecAgregar(b, ses, origin) {
  const fotos = (Array.isArray(b.fotos) ? b.fotos : []).map((u) => { const m = ABS.exec(String(u)); return m ? m[1] : String(u); })
    .filter((u, i, a) => REL.test(u) && a.indexOf(u) === i).slice(0, MAX_TEC_FOTOS);
  if (!fotos.length) return { ok: false, error: "No llegaron fotos" };
  const ms = M();
  const existen = await Promise.all(fotos.map((u) => ms.getMetadata(u.slice(7)).catch(() => null)));
  if (existen.some((x) => !x)) return { ok: false, error: "Alguna foto no terminó de subir. Intenta de nuevo." };
  let sol = null, sec = "", nuevas = 0;
  const r = await mutarOrden(b.id, (o) => {
    if (ETAPAS_TALLER.indexOf(o.estatus || "recepcion") < 0) return { ok: false, error: "Esta unidad ya no está en el taller" };
    o.solicitudesFotos = o.solicitudesFotos || [];
    if (b.sol) {
      sol = o.solicitudesFotos.find((s) => s.id === b.sol);
      if (!sol) return { ok: false, error: "La solicitud ya no existe" };
      if (sol.estado === "cancelada") return { ok: false, error: "Administración canceló esta solicitud" };
    } else {
      if (!SECCIONES[b.sec]) return { ok: false, error: "Elige en qué sección van las fotos" };
      // Si el teléfono ya mandó este mismo paquete (se cortó la señal en la respuesta) no se duplica
      sol = o.solicitudesFotos.find((s) => s.lote && s.lote === b.lote) || null;
      if (!sol) { sol = { id: nuevoId(), sec: b.sec, para: ses.usuario, paraNombre: ses.nombre, nota: "", pidio: ses.usuario, pidioNombre: ses.nombre,
        ts: now(), estado: "pendiente", fotos: [], origen: "tecnico", rondas: 1, lote: String(b.lote || "").slice(0, 40) }; o.solicitudesFotos.push(sol); }
    }
    sec = sol.sec;
    const lista = fotosDeSeccion(o, sec).slice();
    o._tecFotos = o._tecFotos || {};
    const tf = (o._tecFotos[sec] = o._tecFotos[sec] || []);
    nuevas = 0;
    for (const u of fotos) {
      if (lista.indexOf(u) < 0) { lista.push(u); nuevas++; }
      if (tf.indexOf(u) < 0) tf.push(u);
      if ((sol.fotos || []).indexOf(u) < 0) (sol.fotos = sol.fotos || []).push(u);
    }
    ponerFotosSeccion(o, sec, lista);
    sol.estado = "recibida"; sol.tsSubida = now(); sol.subio = ses.usuario; sol.subioNombre = ses.nombre;
    if (b.notaTec != null) sol.notaTec = String(b.notaTec || "").slice(0, 500);
    o._tf = now();
    o._u = now(); // el Apps Script respalda las fotos nuevas en Drive
    return { ok: true };
  });
  if (!r.ok) return r;
  await logBitacora({ ...ctxOrden(r.orden), etapa: r.orden.estatus || "", que: "FOTOS DEL TALLER",
    antes: `${fotos.length} foto(s) a ${SECCIONES[sec]} · subió: ${usuarioTxt(ses)}`, despues: sol.notaTec || "" });
  return { ok: true, sec, secNombre: SECCIONES[sec], fotos: fotos.length, nuevas, sol: sol.id, folio: r.orden.folio || "",
    placas: ((r.orden.vehiculo || {}).placas) || "" };
}
const idxInit = () => ({ o: {} });

/* ------------------------- quitar fotos del JSON (igual que v23) ------------------------- */
function extractUrls(o) {
  const u = { fotos: [], diag: [], fin: [], firmaR: "", firmaC: "", salida: {}, firmaT: "", firmaE: "" };
  if (!o) return u;
  if (Array.isArray(o.fotosUrls)) u.fotos = o.fotosUrls;
  if (o.diagnostico && Array.isArray(o.diagnostico.fotosUrls)) u.diag = o.diagnostico.fotosUrls;
  if (o.finalizado && Array.isArray(o.finalizado.fotosUrls)) u.fin = o.finalizado.fotosUrls;
  u.firmaR = o.firmaRecibeUrl || "";
  u.firmaC = o.firmaClienteUrl || "";
  if (o.entregaCheck) {
    u.salida = o.entregaCheck.fotosUrls || {};
    u.firmaT = o.entregaCheck.firmaTecnicoUrl || "";
    u.firmaE = o.entregaCheck.firmaClienteUrl || "";
  }
  return u;
}
function stripMedia(o, urls) {
  const x = JSON.parse(JSON.stringify(o || {}));
  x.fotos = cnt(o.fotos);
  x.fotosUrls = urls.fotos || [];
  if (x.diagnostico) { x.diagnostico.fotos = cnt(o.diagnostico && o.diagnostico.fotos); x.diagnostico.fotosUrls = urls.diag || []; }
  if (x.finalizado) { x.finalizado.fotos = cnt(o.finalizado && o.finalizado.fotos); x.finalizado.fotosUrls = urls.fin || []; }
  x.firmaRecibe = o.firmaRecibe ? 1 : 0;
  x.firmaCliente = o.firmaCliente ? 1 : 0;
  x.firmaRecibeUrl = urls.firmaR || "";
  x.firmaClienteUrl = urls.firmaC || "";
  if (x.entregaCheck) {
    const ec = o.entregaCheck || {};
    x.entregaCheck.fotos = typeof ec.fotos === "object" && ec.fotos ? Object.keys(ec.fotos).length : nz(ec.fotos);
    x.entregaCheck.fotosUrls = urls.salida || {};
    x.entregaCheck.firmaTecnico = ec.firmaTecnico ? 1 : 0;
    x.entregaCheck.firmaCliente = ec.firmaCliente ? 1 : 0;
    x.entregaCheck.firmaTecnicoUrl = urls.firmaT || "";
    x.entregaCheck.firmaClienteUrl = urls.firmaE || "";
  }
  delete x.media;
  return x;
}

/* ------------------------- folios únicos ------------------------- */
function siguienteFolio(folio) {
  const m = String(folio || "").match(/^(.*?)(\d+)$/);
  if (!m) return String(folio || "") + "-2";
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, "0");
}
function resolverFolio(idx, id, folio) {
  if (!folio) return folio || "";
  const usados = new Set();
  for (const k in idx.o) if (k !== String(id) && idx.o[k].folio) usados.add(String(idx.o[k].folio));
  let f = String(folio), n = 0;
  while (usados.has(f) && n < 500) { f = siguienteFolio(f); n++; }
  return f;
}

/* ------------- v25: choque entre dos computadoras en la misma orden ------------- */
function esChoque(prev, o) {
  const pr = nz(prev._rev);
  if (!pr) return false;                                   // nadie la ha guardado con v25 todavía
  if (nz(o._base) === pr) return false;                    // trabajó sobre la última versión
  if (prev._revDev && o._dev && prev._revDev === String(o._dev)) return false; // el último cambio lo hizo este mismo equipo
  return true;
}
const sinBase64 = (o) => deepMap(o, (v) => (typeof v === "string" && v.indexOf("data:") === 0 ? "(foto no enviada)" : v));
async function rechazarChoque(o, actual, ses) {
  const t = now();
  const cambios = diffProtegido(actual, normIn(o)).filter((k) => k.indexOf("evidencia") < 0);
  try { await S().setJSON(`conflictos/${o.id}/${t}`, { ts: t, por: usuarioTxt(ses), dev: o._dev || "", base: nz(o._base), rev: nz(actual._rev), orden: sinBase64(o) }); } catch {}
  await logBitacora({ ...ctxOrden(actual), etapa: actual.estatus || "", que: "CAMBIO NO GUARDADO: OTRA COMPUTADORA YA HABÍA CAMBIADO LA ORDEN",
    antes: `Intentó: ${usuarioTxt(ses)} · Último cambio: ${actual._revPor || "—"}`,
    despues: (cambios.length ? "Lo que traía distinto: " + cambios.join(", ") : "Sin diferencias en datos principales") + ` · respaldo: conflictos/${o.id}/${t}` });
  return { ok: false, conflicto: true, rev: nz(actual._rev), por: actual._revPor || "", etapa: actual.estatus || "",
    error: "Otra computadora (" + (actual._revPor || "otro usuario") + ") cambió esta orden mientras la tenías abierta. Tu cambio no se guardó para no borrar el suyo." };
}

/* v26: cuando oficina pasa a "aprobado" una orden que el cliente autorizó en línea, queda confirmada */
function v26confirmar(x, prev, ses) {
  const a = x.autCli;
  if (!a || a.confirmada || ["aprobado", "finalizado", "entregado"].indexOf(x.estatus) < 0) return;
  if (prev && ["aprobado", "finalizado", "entregado"].indexOf(prev.estatus) >= 0) return;
  x.autCli = { ...a, confirmada: { ts: now(), por: usuarioTxt(ses), conLiga: !!(x.aprobacion && x.aprobacion.porCliente) } };
}
/* ------------------------- GUARDAR ------------------------- */
async function guardar(o, token, ses) {
  if (!o || !o.id) return { ok: false, error: "Orden sin id" };
  // v26.3: subtotal, IVA y total se recalculan de las partidas, al centavo (aunque venga de la app v25)
  if (o.cotizacion && Array.isArray(o.cotizacion.items) && o.cotizacion.items.length) { const cc = v26cuentasCot(o.cotizacion); o.cotizacion.subtotal = cc.sub; o.cotizacion.ivaMonto = cc.iva; o.cotizacion.total = cc.total; }
  o = normIn(o);
  const st = S();
  const prevR = await st.getWithMetadata("o/" + o.id, { type: "json" }).catch(() => null);
  const prev = prevR && prevR.data ? prevR.data : null;
  // v25: fotos del taller que este teléfono todavía no ha visto (antes de comparar el candado)
  // v25: dos computadoras en la misma orden. La app v25 manda la revisión sobre la que trabajó (_base);
  // si otra computadora guardó después, NO se pisa: se rechaza, se respalda y se anota en la bitácora.
  if (prev && o._cli === "v25" && esChoque(prev, o)) return await rechazarChoque(o, prev, ses);
  const vistosCli = JSON.parse(JSON.stringify(o._tecFotos || {}));
  mezclarFotosTaller(o, prev);

  if (prev && estaBloqueada(prev.estatus)) {
    const cambios = diffProtegido(prev, o);
    if (cambios.length) {
      if (!(await tokenValido(token)))
        return { ok: false, locked: true, error: "Esta orden está cerrada. Se requiere la clave de autorización para modificarla.", cambios };
      const pe = String(prev.estatus || ""), a = snapProtegido(prev, pe), b = snapProtegido(o, pe);
      await logBitacora({ ...ctxOrden(o), etapa: pe, que: cambios.join(", ") + "  [" + usuarioTxt(ses) + "]",
        antes: cambios.filter((k) => k in a).map((k) => k + ": " + a[k]).join("  ||  "),
        despues: cambios.filter((k) => k in a).map((k) => k + ": " + b[k]).join("  ||  ") });
    }
  }
  if (o.entregaCheck && o.entregaCheck.items) {
    const antes = prev && prev.entregaCheck ? JSON.stringify(prev.entregaCheck.items || {}) : "";
    if (antes !== JSON.stringify(o.entregaCheck.items)) {
      const c = evaluarEntrega(o.entregaCheck);
      await logBitacora({ ...ctxOrden(o), etapa: o.estatus || "", que: "CHECKLIST DE ENTREGA",
        antes: "Revisó: " + (o.entregaCheck.responsable || "—") + " · Capturó: " + usuarioTxt(ses),
        despues: `OK: ${c.ok} · Atención: ${c.atencion} · Sin marcar: ${c.sin}` });
    }
  }
  if (o.multipuntos && o.multipuntos.puntos && o.multipuntos.puntos.length) {
    const ev = evaluarMultipuntos(o.multipuntos.puntos);
    o.multipuntos.puntos = ev.puntos; o.multipuntos.conteo = ev.conteo; o.multipuntos.vigencia = ev.vigencia;
    const antes = prev && prev.multipuntos ? JSON.stringify(prev.multipuntos.puntos || []) : "";
    if (antes !== JSON.stringify(ev.puntos))
      await logBitacora({ ...ctxOrden(o), etapa: o.estatus || "", que: "INSPECCIÓN MULTIPUNTOS",
        antes: "Técnico: " + (o.multipuntos.tecnico || "—") + " · Capturó: " + usuarioTxt(ses),
        despues: `Verdes: ${ev.conteo.verde} · Amarillos: ${ev.conteo.amarillo} · Rojos: ${ev.conteo.rojo}` });
  }

  // Fotos: sólo se actualizan las etapas que la app marca en o.media (igual que v23)
  const p = extractUrls(prev);
  const urls = { ...p, salida: { ...p.salida } };
  const m = o.media || {};
  if (m.reception) {
    urls.fotos = await listaMedios(o.fotos);
    urls.firmaR = await firma(o.firmaRecibe, p.firmaR);
    urls.firmaC = await firma(o.firmaCliente, p.firmaC);
  }
  if (m.diagnostico) urls.diag = await listaMedios((o.diagnostico || {}).fotos);
  if (m.finalizado) urls.fin = await listaMedios((o.finalizado || {}).fotos);
  if (m.entrega || m.finalizado) {
    const ec = o.entregaCheck;
    if (ec && (typeof ec.fotos === "object" || ec.firmaTecnico || ec.firmaCliente)) {
      const out = {};
      const f = typeof ec.fotos === "object" && ec.fotos ? ec.fotos : {};
      for (const k in f) out[k] = await firma(f[k], p.salida[k]);
      for (const k in out) if (!out[k]) delete out[k];
      urls.salida = out;
      urls.firmaT = await firma(ec.firmaTecnico, p.firmaT);
      urls.firmaE = await firma(ec.firmaCliente, p.firmaE);
    }
  }

  const x = stripMedia(o, urls);
  // v25: lo de "fotos del taller" lo decide el servidor, nunca lo que traiga el teléfono
  delete x._cli; delete x._base; delete x._dev;
  x._rev = nz(prev && prev._rev) + 1; x._revPor = usuarioTxt(ses); x._revDev = String(o._dev || ""); x._revTs = now();
  x.machote = (prev && prev.machote) || null; // lo escribe el Apps Script (ackMachote)
  x.cli = (prev && prev.cli) || null; x.autCli = (prev && prev.autCli) || null; // v26: los escribe el servidor (liga del cliente)
  v26confirmar(x, prev, ses);
  x.solicitudesFotos = (prev && prev.solicitudesFotos) || [];
  x._tf = (prev && prev._tf) || 0;
  x._v25 = prev ? !!prev._v25 : o._cli === "v25";
  x._tecFotos = JSON.parse(JSON.stringify((prev && prev._tecFotos) || {}));
  // Si un teléfono que SÍ vio una foto del taller la quitó a propósito, deja de contarse como del taller
  for (const sec in SECCIONES) {
    if (!m[SEC_MEDIA[sec]] || !x._tecFotos[sec]) continue;
    const quedan = fotosDeSeccion(x, sec);
    x._tecFotos[sec] = x._tecFotos[sec].filter((u) => quedan.indexOf(u) >= 0 || (vistosCli[sec] || []).indexOf(u) < 0);
  }
  // v25: una orden nueva no avanza de recepción sin fotos de recepción
  if (x._v25 && ETAPAS_BLOQUEO.indexOf(x.estatus) >= 0 && (!prev || ETAPAS_AVANCE.indexOf(prev.estatus) < 0) && sinFotosRecepcion(x))
    return { ok: false, faltanFotos: true, error: "Faltan las fotos de recepción. Pídelas al taller antes de pasar la orden a cotización." };
  const t = now();
  x.driveUrl = (prev && prev.driveUrl) || o.driveUrl || "";
  x._u = t;
  x._origen = (prev && prev._origen) || "netlify";
  x._historial = (prev && prev._historial) || [];
  if (!prev || prev.estatus !== x.estatus) {
    x._historial.push({ e: x.estatus || "", ts: t, u: (ses && ses.usuario) || "" });
    x._etapaDesde = t;
  } else x._etapaDesde = prev._etapaDesde || etapaDesdeDerivada(prev);
  const cfg = await getConfig();
  x._prueba = prev ? !!prev._prueba : cfg.modo === "prueba";

  // folio único + índice (escritura condicional)
  let folioFinal = x.folio;
  await mutate(st, "idx", idxInit, async (idx) => {
    folioFinal = resolverFolio(idx, x.id, x.folio);
    x.folio = folioFinal;
    idx.o[x.id] = resumen(x);
    return true;
  });
  // v25: escritura condicional. Si el taller subió fotos mientras tanto, se integran y se reintenta.
  let etag = prevR && prevR.data ? prevR.etag : null;
  for (let i = 0; ; i++) {
    const w = await st.setJSON("o/" + x.id, x, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (w && w.modified) break;
    if (i >= 12) throw new Error("La orden se está guardando en otro equipo. Intenta de nuevo en unos segundos.");
    await sleep(60 + Math.random() * 200);
    const cur = await st.getWithMetadata("o/" + x.id, { type: "json" }).catch(() => null);
    if (!cur || !cur.data) { etag = null; continue; }
    etag = cur.etag;
    const c = cur.data;
    if (nz(c._rev) !== nz(prev && prev._rev)) { // otra computadora guardó en este mismo instante
      await actualizarIdx(c);
      return await rechazarChoque(o, c, ses);
    }
    for (const sec in SECCIONES) {
      const lista = fotosDeSeccion(x, sec).slice();
      let cambio = false;
      for (const u of (c._tecFotos || {})[sec] || []) if (((x._tecFotos || {})[sec] || []).indexOf(u) < 0 && lista.indexOf(u) < 0) { lista.push(u); cambio = true; }
      if (cambio) { ponerFotosSeccion(x, sec, lista); urls[{ recepcion: "fotos", diagnostico: "diag", evidencias: "fin" }[sec]] = lista; }
    }
    x._tecFotos = c._tecFotos || {}; x.solicitudesFotos = c.solicitudesFotos || []; x._tf = c._tf || 0;
    x.driveUrl = c.driveUrl || x.driveUrl; x.machote = c.machote || x.machote;
    x.cli = c.cli || x.cli; x.autCli = c.autCli || x.autCli; v26confirmar(x, prev, ses); // v26
    await actualizarIdx(x);
  }

  try {
    if (o.cliente && o.cliente.nombre) {
      const fx = o.fiscal || {};
      await saveCliente({ nombre: o.cliente.nombre, tel: o.cliente.tel, correo: o.cliente.correo, domicilio: o.cliente.domicilio,
        rfc: fx.rfc, razonSocial: fx.razonSocial, regimen: fx.regimen, usoCFDI: fx.usoCFDI, cp: fx.cp, flotilla: (o.flotilla && o.flotilla.nombre) || "" });
    }
  } catch {}
  try { await registrarComponentes((o.cotizacion || {}).items); } catch {}
  try { await histTrasGuardar(x, prev); } catch {}   // v27
  return { ok: true, folio: folioFinal, drive: x.driveUrl, urls, v25: x._v25, rev: x._rev };
}

async function obtener(id, folio) {
  const st = S();
  let o = id ? await getJSON(st, "o/" + id) : null;
  if (!o && folio) {
    const idx = (await getJSON(st, "idx")) || idxInit();
    const k = Object.keys(idx.o).find((k) => String(idx.o[k].folio) === String(folio));
    if (k) o = await getJSON(st, "o/" + k);
  }
  return o;
}
async function listar() {
  const idx = (await getJSON(S(), "idx")) || idxInit();
  return Object.values(idx.o);
}
async function eliminarOrden(id, folio, pin, token, ses) {
  const PIN = env("PIN_EDICION");
  const autoriza = (await tokenValido(token)) || (pin && PIN && String(pin) === String(PIN));
  if (!autoriza) return { ok: false, error: "Clave incorrecta o sin autorización" };
  const st = S();
  const o = await obtener(id, folio);
  if (!o) return { ok: true, borradas: 0, msg: "No estaba registrada" };
  await moverABorradas(o, "app · " + usuarioTxt(ses));
  await logBitacora({ ...ctxOrden(o), etapa: o.estatus || "", que: "ELIMINACIÓN DE ORDEN", antes: "Eliminó: " + usuarioTxt(ses) });
  return { ok: true, borradas: 1 };
}
// Nada se borra de verdad: pasa a "borradas/" con sus fotos intactas
async function moverABorradas(o, motivo) {
  const st = S();
  await st.setJSON("borradas/" + o.id, { ...o, _borrada: { ts: now(), motivo } });
  await mutate(st, "idx", idxInit, async (idx) => { delete idx.o[o.id]; return true; });
  await st.delete("o/" + o.id);
  try { await histQuitar(o.id); } catch {}   // v27
}

/* ------------- rescate de fotos del checklist de entrega (bug de v23) -------------
   v23 nunca subió a Drive las fotos de salida ni las firmas de entrega: sólo existen
   en el teléfono que las tomó. Cada teléfono con v24 las sube UNA vez por aquí.
   Sólo llena huecos: jamás reemplaza una foto que ya está en el servidor ni toca
   ningún otro dato de la orden. */
async function rescatarEntrega(b) {
  const st = S();
  const o = await getJSON(st, "o/" + b.id);
  if (!o || !o.entregaCheck) return { ok: true, rescatadas: 0 };
  const ec = o.entregaCheck;
  ec.fotosUrls = ec.fotosUrls && typeof ec.fotosUrls === "object" ? ec.fotosUrls : {};
  let n = 0;
  const f = b.fotos && typeof b.fotos === "object" ? b.fotos : {};
  for (const k in f) {
    if (ec.fotosUrls[k] || typeof f[k] !== "string" || f[k].indexOf("data:") !== 0) continue;
    const u = await guardarMedio(f[k]);
    if (u) { ec.fotosUrls[k] = u; n++; }
  }
  for (const [campo, url] of [["firmaTecnico", "firmaTecnicoUrl"], ["firmaCliente", "firmaClienteUrl"]]) {
    const v = b[campo];
    if (ec[url] || typeof v !== "string" || v.indexOf("data:") !== 0) continue;
    const u = await guardarMedio(v);
    if (u) { ec[url] = u; ec[campo] = 1; n++; }
  }
  if (!n) return { ok: true, rescatadas: 0 };
  ec.fotos = Object.keys(ec.fotosUrls).length;
  // v25: se aplica sobre la versión más reciente (escritura condicional)
  const fin = await mutarOrden(o.id, (cur) => { cur.entregaCheck = ec; cur._u = now(); return { ok: true }; });
  if (!fin.ok) return { ok: true, rescatadas: 0 };
  await logBitacora({ ...ctxOrden(o), etapa: o.estatus || "", que: "RESCATE DE FOTOS DE ENTREGA", antes: `${n} archivo(s) que sólo estaban en un teléfono` });
  return { ok: true, rescatadas: n };
}

/* ------------------------- clientes y componentes ------------------------- */
const CLI_KEYS = ["nombre", "tel", "correo", "domicilio", "rfc", "razonSocial", "regimen", "usoCFDI", "cp", "flotilla"];
async function saveCliente(c) {
  if (!c || !String(c.nombre || "").trim()) return { ok: false, error: "Sin nombre" };
  const key = String(c.nombre).trim().toLowerCase();
  await mutate(S(), "clientes", () => ({ c: {} }), async (doc) => {
    const prev = doc.c[key] || {};
    const row = {};
    for (const k of CLI_KEYS) { const v = c[k] == null ? "" : String(c[k]); row[k] = v === "" && prev[k] ? prev[k] : v; }
    row.updatedAt = now();
    if (JSON.stringify({ ...prev, updatedAt: 0 }) === JSON.stringify({ ...row, updatedAt: 0 })) return undefined; // sin cambios
    doc.c[key] = row;
    return true;
  });
  return { ok: true };
}
async function listClientes() {
  const d = await getJSON(S(), "clientes");
  return { ok: true, clientes: Object.values((d && d.c) || {}).map((r) => { const o = {}; for (const k of CLI_KEYS) o[k] = r[k] || ""; return o; }) };
}
async function registrarComponentes(items) {
  const nuevos = (items || []).map((it) => String((it && it.componente) || "").trim()).filter(Boolean);
  if (!nuevos.length) return;
  await mutate(S(), "componentes", () => ({ lista: [] }), async (doc) => {
    const ya = new Set(doc.lista.map((x) => x.c.toLowerCase()));
    let n = 0;
    for (const c of nuevos) if (!ya.has(c.toLowerCase())) { ya.add(c.toLowerCase()); doc.lista.push({ c, ts: now() }); n++; }
    return n ? true : undefined;
  });
}
async function listComponentes() {
  const d = await getJSON(S(), "componentes");
  return { ok: true, componentes: ((d && d.lista) || []).map((x) => x.c) };
}

async function getConfig() {
  return (await getJSON(S(), "config")) || { modo: "prueba" };
}

/* ------------------------- cobranza GS ------------------------- */
const ROLES_DIRECCION = ["gerencia", "gerente", "ceo", "director", "direccion", "dirección", "admin", "administrador", "dueño", "dueno"];
const esDireccion = (rol) => ROLES_DIRECCION.includes(String(rol || "").trim().toLowerCase());
async function cargarCobranza(b, ses) {
  if (!ses || !esDireccion(ses.rol))
    return { ok: false, error: "Solo un usuario con rol de dirección (CEO, gerencia, director, admin) puede cargar la cobranza" };
  const arr = Array.isArray(b.data) ? b.data : [];
  if (!arr.length) return { ok: false, error: "El archivo no trae folios" };
  const data = {};
  for (const r of arr) {
    const f = String((r && r.folio) || "").replace(/\D/g, "");
    if (!f) continue;
    data[f] = {
      folio: f, sucursal: r.sucursal || "", categoria: r.categoria || "", estatus: r.estatus_original || "",
      total: nz(r.total), fecha: r.fecha || "", fecha_folio: r.fecha_folio || "", no_factura: r.no_factura || "",
      documento_pago: r.documento_pago || "", confirmado_pdf: !!r.confirmado_pdf, flujo: r.gs_estatus_flujo || "",
      saldo: r.gs_saldo == null ? null : nz(r.gs_saldo), advertencia: r.gs_advertencia || "",
      responsable: r.responsable || r.responsable_edc || "", proceso: r.proceso || r.proceso_a_realizar || "",
    };
  }
  const doc = { corte: String(b.corte || "").slice(0, 40), cargado: now(), por: usuarioTxt(ses), archivo: String(b.archivo || "").slice(0, 160), data };
  await S().setJSON("cobranza_gs", doc);
  await logBitacora({ que: "CARGA DE COBRANZA GS", antes: `Corte: ${doc.corte} · ${Object.keys(data).length} folios`, despues: "Cargó: " + doc.por });
  return { ok: true, folios: Object.keys(data).length, corte: doc.corte };
}

/* ------------------------- PUENTE (Apps Script) ------------------------- */
async function puente(b, origin) {
  const st = S();
  const a = b.action;
  if (a === "estado") {
    const idx = (await getJSON(st, "idx")) || idxInit();
    const rows = Object.values(idx.o);
    const u = await getJSON(st, "usuarios");
    return { ok: true, version: BACKEND_VERSION, modo: (await getConfig()).modo, ordenes: rows.length,
      origenSheets: rows.filter((r) => !r.prueba).length, pruebas: rows.filter((r) => r.prueba).length,
      usuarios: ((u && u.lista) || []).length, ultimoFolio: rows.map((r) => r.folio).filter((f) => !/^CITA-/.test(f)).sort().slice(-1)[0] || "" };
  }
  if (a === "importar") {
    const ords = (b.ordenes || []).filter((o) => o && o.id);
    const listos = [];
    for (const o0 of ords) {
      const o = normIn(o0);
      o._origen = "sheets";
      o._u = nz(o._u) || now();
      o._historial = o._historial || [];
      o._etapaDesde = o._etapaDesde || etapaDesdeDerivada(o);
      delete o._prueba;
      listos.push(o);
    }
    await Promise.all(listos.map((o) => st.setJSON("o/" + o.id, o)));
    await mutate(st, "idx", idxInit, async (idx) => { for (const o of listos) idx.o[o.id] = resumen(o); return true; });
    return { ok: true, importadas: listos.length };
  }
  if (a === "faltanMedia") {
    const keys = (b.keys || []).filter((k) => /^[A-Za-z0-9_-]+$/.test(k)).slice(0, 300);
    const ms = M();
    const res = await Promise.all(keys.map((k) => ms.getMetadata(k).catch(() => null)));
    return { ok: true, faltan: keys.filter((k, i) => !res[i]) };
  }
  if (a === "importarMedia") {
    const key = String(b.key || "");
    if (!/^[A-Za-z0-9_-]+$/.test(key)) return { ok: false, error: "Llave inválida" };
    const bytes = Uint8Array.from(atob(String(b.b64 || "")), (c) => c.charCodeAt(0));
    if (!bytes.length || bytes.length > MAX_MEDIA) return { ok: false, error: "Archivo vacío o muy grande" };
    await M().set(key, bytes.buffer, { metadata: { type: String(b.tipo || "image/jpeg"), creado: now(), origen: "drive" } });
    return { ok: true };
  }
  if (a === "importarUsuarios") {
    const lista = (b.usuarios || []).filter((u) => u && u.usuario).map((u) => ({
      usuario: String(u.usuario).trim().toLowerCase(), password: String(u.password || ""), nombre: String(u.nombre || ""),
      rol: String(u.rol || ""), activo: String(u.activo || "si") }));
    if (!lista.length) return { ok: false, error: "Sin usuarios" };
    await st.setJSON("usuarios", { lista, ts: now() });
    return { ok: true, usuarios: lista.length };
  }
  if (a === "importarClientes") {
    const cl = b.clientes || [];
    await mutate(st, "clientes", () => ({ c: {} }), async (doc) => {
      for (const c of cl) {
        const key = String(c.nombre || "").trim().toLowerCase(); if (!key) continue;
        const prev = doc.c[key] || {}, row = {};
        for (const k of CLI_KEYS) { const v = c[k] == null ? "" : String(c[k]); row[k] = v === "" && prev[k] ? prev[k] : v; }
        row.updatedAt = prev.updatedAt || now();
        doc.c[key] = row;
      }
      return true;
    });
    return { ok: true, clientes: cl.length };
  }
  if (a === "importarComponentes") {
    await registrarComponentes((b.componentes || []).map((c) => ({ componente: c })));
    return { ok: true };
  }
  if (a === "cambios") {
    const desde = nz(b.desde), lim = Math.min(nz(b.limite) || 40, 80);
    const idx = (await getJSON(st, "idx")) || idxInit();
    const ids = Object.values(idx.o).filter((r) => r._u > desde && !r.prueba).sort((x, y) => x._u - y._u).slice(0, lim);
    const ords = (await Promise.all(ids.map((r) => getJSON(st, "o/" + r.id)))).filter(Boolean);
    return { ok: true, ordenes: ords, hasta: ids.length ? ids[ids.length - 1]._u : desde, mas: ids.length === lim };
  }
  if (a === "ackDrive") {
    const m = b.ids || {};
    for (const id in m) {
      // v25: escritura condicional (no pisa fotos que el taller suba en ese momento); no cambia _u
      await mutarOrden(id, (o) => (o.driveUrl === m[id] ? null : ((o.driveUrl = String(m[id])), { ok: true })));
    }
    return { ok: true };
  }
  if (a === "ackMachote") {
    // v25: el Apps Script avisa dónde quedó el Excel; no es un cambio de la orden (no cambia _rev ni _u)
    const r = await mutarOrden(b.id, (o) => {
      o.machote = { excel: String(b.excel || ""), pdf: String(b.pdf || ""), folder: String(b.folder || ""), ts: now() };
      if (b.folder) o.driveUrl = String(b.folder);
      return { ok: true };
    });
    return { ok: !!r.ok };
  }
  if (a === "bitacora") {
    const desde = String(b.desde || "");
    const { blobs } = await st.list({ prefix: "bit/" });
    const keys = blobs.map((x) => x.key).filter((k) => k > desde).sort().slice(0, 300);
    const rows = await Promise.all(keys.map((k) => getJSON(st, k)));
    return { ok: true, filas: rows.filter(Boolean), hasta: keys.length ? keys[keys.length - 1] : desde };
  }
  if (a === "exportOrden") {
    const o = await obtener(b.id, b.folio);
    return o ? { ok: true, orden: absOut(o, origin) } : { ok: false, error: "Orden no encontrada" };
  }
  if (a === "reconciliar") {
    // Órdenes que vinieron de Sheets y ya no existen allá (se borraron en v23 durante el ensayo)
    const vivos = new Set((b.ids || []).map(String));
    const idx = (await getJSON(st, "idx")) || idxInit();
    const sobran = [];
    for (const id in idx.o) {
      if (vivos.has(id) || idx.o[id].prueba) continue;
      const o = await getJSON(st, "o/" + id);
      if (o && o._origen === "sheets") sobran.push(o);
    }
    if (b.aplicar) for (const o of sobran) await moverABorradas(o, "reconciliación: ya no estaba en Sheets");
    return { ok: true, sobran: sobran.map((o) => o.folio || o.id), aplicado: !!b.aplicar };
  }
  if (a === "cutover") {
    const idx = (await getJSON(st, "idx")) || idxInit();
    const pruebas = Object.values(idx.o).filter((r) => r.prueba);
    for (const r of pruebas) { const o = await getJSON(st, "o/" + r.id); if (o) await moverABorradas(o, "orden de prueba (ensayo de v24)"); }
    await st.setJSON("config", { modo: "produccion", desde: now() });
    await logBitacora({ que: "ARRANQUE v24 EN NETLIFY", antes: `Órdenes de prueba retiradas: ${pruebas.length}` });
    return { ok: true, pruebasRetiradas: pruebas.length, modo: "produccion" };
  }
  if (a === "modoPrueba") {
    await st.setJSON("config", { modo: "prueba", desde: now() });
    return { ok: true, modo: "prueba" };
  }
  return { ok: false, error: "Acción del puente desconocida" };
}

/* =====================================================================
   v26 · LIGA DEL CLIENTE
   Cada orden puede tener una liga privada para el cliente (/o/<llave>), con el
   formato nuevo: orden de recepción con fotos, cotización por trabajos con fotos y
   precio, autorización desde el celular y "listo para entregar" con evidencias.
   · La llave es aleatoria (imposible de adivinar). Oficina la crea al mandar el
     primer aviso; "liga nueva" invalida la anterior.
   · El cliente ve SÓLO lo que ya ve en sus documentos impresos: vehículo, fotos,
     diagnóstico, trabajos con precio de venta y total. NUNCA: costos internos,
     proveedor, utilidad, pagos, cobranza, teléfonos, datos fiscales ni bitácora.
   · Su autorización se guarda en la orden (o.autCli) y se avisa a oficina, que la
     confirma (la orden pasa a "aprobado" cuando oficina la confirma, no antes).
   · v26.4: la autorización es general (toda la cotización) y una sola vez; si la
     cotización cambia, el cliente vuelve a autorizar la versión nueva.
   · o.cli y o.autCli los decide siempre el servidor: un guardado de oficina nunca
     los borra ni los cambia.
   ===================================================================== */
/* ---- v26 · común (servidor, app de oficina y página del cliente usan EXACTAMENTE esto) ----
   Las partidas de la cotización se agrupan en "trabajos" para el cliente: partidas seguidas
   con el mismo componente (p. ej. la refacción + su mano de obra) son un solo trabajo, con un
   solo precio, como en la orden del Trax que les gustó a los clientes. */
function v26norm(x){ return String(x==null?'':x).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function v26esMO(it){ return /^mano de obra/i.test(String((it&&it.tipoTrabajo)||'').trim()) || /^mano de obra/i.test(String((it&&it.concepto)||'').trim()); }
function v26huella(co){
  co=co||{};
  var s=JSON.stringify([(co.items||[]).map(function(it){ return [String(it.concepto||''), Number(it.cantidad)||0, Number(it.precio)||0]; }), !!co.iva]);
  var h=5381; for(var i=0;i<s.length;i++){ h=((h<<5)+h+s.charCodeAt(i))|0; }
  return (h>>>0).toString(36);
}
/* Centavos (v26.3): toda cifra de dinero se redondea a 2 decimales con la MISMA regla en la app,
   el servidor, la liga del cliente y el PDF. IVA = subtotal × 16 % redondeado a centavos (como el CFDI),
   y total = subtotal + IVA, exacto. */
function v26r2(n){ n=Number(n)||0; var s=n<0?-1:1; return s*Math.round((Math.abs(n)+Number.EPSILON)*100)/100; }
function v26importe(it){ return v26r2((Number(it&&it.cantidad)||0)*(Number(it&&it.precio)||0)); }
function v26cuentas(sub, conIva){ sub=v26r2(sub); var iva=conIva?v26r2(sub*0.16):0; return {sub:sub, iva:iva, total:v26r2(sub+iva)}; }
function v26cuentasCot(co){ var s=0; ((co&&co.items)||[]).forEach(function(it){ s+=v26importe(it); }); return v26cuentas(s, !!(co&&co.iva)); }
function v26trabajos(co, diagFotos){
  var items=(co&&co.items)||[], out=[], cur=null, fotos=Array.isArray(diagFotos)?diagFotos:[];
  for(var i=0;i<items.length;i++){
    var it=items[i]||{}, comp=v26norm(it.componente);
    if(!cur || !comp || comp!==cur._c){
      cur={k:'t'+i, _c:comp, idx:[], titulo:'', explicacion:'', fotos:[], subtotal:0, incluye:[], componente:String(it.componente||'').trim()};
      out.push(cur);
    }
    cur.idx.push(i);
    cur.subtotal+=v26importe(it);
    var c=String(it.concepto||'').trim(), q=Number(it.cantidad)||0;
    if(!cur.titulo && c && !v26esMO(it)) cur.titulo=c;
    else if(c && !v26esMO(it)) cur.incluye.push(c+(q && q!==1 ? ' ×'+q : ''));   // lo que incluye: otras refacciones/servicios (nunca la mano de obra)
    if(!cur.explicacion && String(it.explicacion||'').trim()) cur.explicacion=String(it.explicacion).trim();
    var fi=Array.isArray(it.fotosIdx)?it.fotosIdx:[];
    for(var j=0;j<fi.length;j++){ var u=fotos[Number(fi[j])]; if(u && cur.fotos.indexOf(u)<0) cur.fotos.push(u); }
  }
  for(var n=0;n<out.length;n++){
    var t=out[n];
    if(!t.titulo) t.titulo=String(items[t.idx[0]].concepto||'Mano de obra')+(t.componente?' · '+t.componente:'');
    t.subtotal=v26r2(t.subtotal);
    delete t._c;
  }
  return out;
}
/* Explicación para el cliente: los renglones que empiezan con "-", "•" o "*" se vuelven lista.
   Si no hay explicación, se lista lo que incluye (otras partidas del trabajo, nunca la mano de obra). */
function v26explicHtml(txt, incluye, esc){
  var lineas=String(txt||'').split(/\r?\n/), par=[], li=[], h='';
  lineas.forEach(function(l){ var t=l.trim(); if(!t) return; var m=/^[-•*·]\s*(.+)$/.exec(t); if(m) li.push(m[1]); else par.push(t); });
  if(!li.length && !par.length && incluye && incluye.length) li=incluye.slice();   // sin explicación: lista de lo que incluye
  if(par.length) h+='<p>'+par.map(esc).join(' ')+'</p>';
  if(li.length) h+='<ul>'+li.map(function(x){ return '<li>'+esc(x)+'</li>'; }).join('')+'</ul>';
  return h;
}

const v26WA = (suc) => String(env(suc === "Servicio Arrez" ? "WA_ARREZ" : "WA_TALLER", "") || env("WA_TALLER", "")).replace(/\D/g, "");
const v26tok = () => { const a = new Uint8Array(16); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const TOK_RE = /^[A-Za-z0-9_-]{16,64}$/;

function autVigente(o) {
  const a = o && o.autCli;
  return !!(a && (a.confirmada || a.huella === v26huella(o.cotizacion)));
}
function resumenAut(o) {
  const a = o.autCli;
  if (!a || a.confirmada || (o.estatus || "") !== "cotizado" || a.huella !== v26huella(o.cotizacion)) return null;
  return { ts: a.ts, nombre: a.nombre || "", total: nz(a.total), n: (a.trabajos || []).length, de: (a.trabajos || []).length + (a.noAut || []).length };
}

function proyeccionCliente(o) {
  const v = o.vehiculo || {}, s = o.servicio || {}, c = o.cliente || {}, fl = o.flotilla || {}, co = o.cotizacion || {};
  const di = o.diagnostico || {}, fi = o.finalizado || {}, ap = o.aprobacion || {}, sal = o.salida || {};
  const pick = (x, ks) => { const r = {}; for (const k of ks) if (x && x[k] != null && x[k] !== "") r[k] = x[k]; return r; };
  const estatus = o.estatus || "recepcion";
  const diagF = fotosDeSeccion(o, "diagnostico");
  const hayCot = (co.items || []).length > 0 && ["cotizado", "aprobado", "finalizado", "entregado"].indexOf(estatus) >= 0;
  const trab = hayCot ? v26trabajos(co, diagF) : [];
  const usadas = new Set(); trab.forEach((t) => t.fotos.forEach((u) => usadas.add(u)));
  const a = o.autCli || null;
  const fin = ["finalizado", "entregado"].indexOf(estatus) >= 0;
  return {
    folio: o.folio || "", sucursal: o.sucursal || "Arsan Motors", estatus, fecha: o.fecha || "", hora: o.hora || "",
    cliente: c.nombre || "", flotilla: fl.nombre || "", eco: fl.eco || "",
    vehiculo: pick(v, ["marca", "modelo", "anio", "color", "placas", "vin", "km", "fuel", "fuelLabel"]),
    motivo: s.motivo || "", asesor: s.asesor || "", danos: o.estado || "", observaciones: o.observaciones || "",
    fotosRecepcion: fotosDeSeccion(o, "recepcion"),
    diagnostico: hayCot || ["cotizado"].indexOf(estatus) >= 0 ? String(di.texto || "") : "",
    trabajos: trab.map((t) => ({ k: t.k, titulo: t.titulo, explicacion: t.explicacion, incluye: t.incluye, fotos: t.fotos, subtotal: t.subtotal, ...v27desglose(co, t) })),
    fotosDiagnostico: hayCot ? diagF.filter((u) => !usadas.has(u)) : [],
    iva: !!co.iva, notas: hayCot ? String(co.notas || "") : "",
    huella: hayCot ? v26huella(co) : "",
    autorizacion: a ? { ts: a.ts, fecha: a.fecha, hora: a.hora, nombre: a.nombre, comentario: a.comentario || "",
      trabajos: (a.trabajos || []).map((t) => t.k), titulos: (a.trabajos || []).map((t) => t.titulo), total: nz(a.total),
      vigente: autVigente(o), confirmada: !!a.confirmada } : null,
    aprobada: ap.fecha ? { fecha: ap.fecha, hora: ap.hora || "", porCliente: !!ap.porCliente } : null,
    finalizado: fin ? { fecha: fi.fecha || "", notas: String(fi.notas || ""), fotos: fotosDeSeccion(o, "evidencias") } : null,
    entregado: estatus === "entregado" ? { fecha: sal.fecha || "", hora: sal.hora || "" } : null,
    wa: v26WA(o.sucursal),
  };
}

/* ---- Oficina: crea (o renueva) la liga y anota cada aviso que se manda ---- */
async function ligaCliente(b, ses, origin) {
  if (!b.id) return { ok: false, error: "Orden sin id" };
  const st = S();
  const cur = await getJSON(st, "o/" + b.id);
  if (!cur) return { ok: false, error: "Orden no encontrada. Guárdala primero." };
  if ((cur.estatus || "") === "cita") return { ok: false, error: "Primero convierte la cita en recepción." };
  const tieneTok = cur.cli && TOK_RE.test(cur.cli.tok || "");
  const tipo = String(b.tipo || "").slice(0, 20);
  if (tieneTok && !b.nueva && !tipo) return { ok: true, tok: cur.cli.tok, url: origin + "/o/" + cur.cli.tok, cli: cur.cli };
  const nuevo = !tieneTok || !!b.nueva, tok = nuevo ? v26tok() : cur.cli.tok, viejo = tieneTok && nuevo ? cur.cli.tok : "";
  if (nuevo) await st.setJSON("cl/" + tok, { id: b.id, ts: now() });
  const r = await mutarOrden(b.id, (o) => {
    o.cli = o.cli || {};
    if (nuevo) { o.cli.tok = tok; o.cli.creado = now(); o.cli.por = ses.nombre; o.cli.visto = 0; o.cli.vistas = 0; }
    if (tipo) o.cli.envios = (o.cli.envios || []).concat([{ tipo, ts: now(), por: ses.nombre }]).slice(-30);
    return { ok: true };
  });
  if (!r.ok) { if (nuevo) await st.delete("cl/" + tok).catch(() => {}); return r; }
  if (viejo) await st.delete("cl/" + viejo).catch(() => {});
  if (nuevo || tipo)
    await logBitacora({ ...ctxOrden(r.orden), etapa: r.orden.estatus || "", que: tipo ? "AVISO AL CLIENTE POR WHATSAPP" : "LIGA DEL CLIENTE",
      antes: (tipo ? tipo + " · " : "") + "por: " + usuarioTxt(ses), despues: nuevo ? (viejo ? "Liga nueva (la anterior dejó de servir)" : "Liga creada") : "" });
  return { ok: true, tok, url: origin + "/o/" + tok, cli: r.orden.cli };
}

/* ---- Cliente (público, sólo con la llave) ---- */
async function ordenDeLlave(tok) {
  if (!TOK_RE.test(String(tok || ""))) return null;
  const ref = await getJSON(S(), "cl/" + tok);
  if (!ref || !ref.id) return null;
  const o = await getJSON(S(), "o/" + ref.id);
  if (!o || !o.cli || o.cli.tok !== tok || (o.estatus || "") === "cita") return null;
  return o;
}
async function vistaCliente(tok, origin) {
  const o = await ordenDeLlave(tok);
  if (!o) return { ok: false, noValida: true, error: "Esta liga ya no es válida. Pida una nueva al taller." };
  if (now() - nz(o.cli.visto) > 5 * 60e3) {
    try { await mutarOrden(o.id, (x) => { x.cli = x.cli || {}; x.cli.visto = now(); x.cli.vistas = nz(x.cli.vistas) + 1; return { ok: true }; }); } catch {}
  }
  return { ok: true, orden: absOut(proyeccionCliente(o), origin) };
}
async function autorizarCliente(tok, b, req) {
  const o0 = await ordenDeLlave(tok);
  if (!o0) return { ok: false, noValida: true, error: "Esta liga ya no es válida. Pida una nueva al taller." };
  const nombre = String(b.nombre || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (nombre.length < 3) return { ok: false, error: "Escriba su nombre completo." };
  let rec = null, de = 0;
  const r = await mutarOrden(o0.id, (o) => {
    if (!o.cli || o.cli.tok !== tok) return { ok: false, noValida: true, error: "Esta liga ya no es válida. Pida una nueva al taller." };
    if ((o.estatus || "") !== "cotizado")
      return { ok: false, recargar: true, error: ["aprobado", "finalizado", "entregado"].indexOf(o.estatus) >= 0 ? "Esta cotización ya quedó aprobada." : "La cotización todavía no está lista." };
    const co = o.cotizacion || {}, hu = v26huella(co);
    if (String(b.huella || "") !== hu) return { ok: false, recargar: true, error: "El taller actualizó la cotización. Recargue la página para ver la versión nueva." };
    // v26.4: una sola autorización por cotización. Para cambiarla, el cliente escribe por WhatsApp y oficina ajusta y reenvía.
    if (autVigente(o)) return { ok: false, yaAutorizo: true, error: "Esta cotización ya está autorizada. Si tiene alguna duda o comentario, escríbanos por WhatsApp." };
    const trab = v26trabajos(co, fotosDeSeccion(o, "diagnostico"));
    const si = trab, no = []; // v26.4: autorización general (todos los trabajos de la cotización)
    if (!si.length) return { ok: false, error: "La cotización no tiene trabajos." };
    de = trab.length;
    const cc = v26cuentas(si.reduce((s, t) => s + t.subtotal, 0), !!co.iva), sub = cc.sub;
    const fh = fechaHora(), prev = o.autCli;
    const corto = (t) => ({ k: t.k, titulo: t.titulo, subtotal: t.subtotal, idx: t.idx });
    rec = { ts: now(), fecha: fh.fecha, hora: fh.hora.slice(0, 5), nombre, comentario: String(b.comentario || "").trim().slice(0, 1000),
      trabajos: si.map(corto), noAut: no.map(corto), subtotal: sub, iva: !!co.iva, ivaMonto: cc.iva, total: cc.total, huella: hu,
      ua: String(req.headers.get("user-agent") || "").slice(0, 160),
      historial: prev ? (prev.historial || []).concat([{ ts: prev.ts, nombre: prev.nombre, total: prev.total, n: (prev.trabajos || []).length }]).slice(-10) : [] };
    o.autCli = rec;
    o._u = now();
    return { ok: true };
  });
  if (!r.ok) return r;
  await logBitacora({ ...ctxOrden(r.orden), etapa: r.orden.estatus || "", que: "AUTORIZACIÓN DEL CLIENTE (LIGA)",
    antes: `${nombre} · ${rec.trabajos.length} de ${de} trabajos · $${rec.total}`,
    despues: rec.trabajos.map((t) => t.titulo).join(", ") + (rec.noAut.length ? " · NO autorizó: " + rec.noAut.map((t) => t.titulo).join(", ") : "") + (rec.comentario ? " · Comentario: " + rec.comentario : "") });
  return { ok: true, autorizacion: { ts: rec.ts, nombre: rec.nombre, total: rec.total, n: rec.trabajos.length } };
}

/* =====================================================================
   v27 · PRECIOS — catálogo oficial, solicitudes de precio e historial de lo cobrado
   Pedido de Chema (23-oct-2026): la secretaria pregunta los precios a cada rato.
   · "catalogo"      Lo da de alta y lo cambia SÓLO dirección (rol CEO, gerencia, director, admin).
                     Oficina lo consulta y agrega sus partidas a la cotización tal cual.
                     El costo de proveedor y el margen NUNCA salen del servidor para oficina.
   · "catalogo_sol"  Lo que oficina buscó y no estaba: "Pedir precio a Chema".
   · "precios_hist"  Las partidas cotizadas de cada orden (vehículo, tipo de cliente, precio),
                     se actualiza al guardar la orden y se reconstruye por tandas la primera vez.
   El técnico no ve nada de esto: la entrada lo bloquea igual que la cotización.
   ===================================================================== */
const CAT_TIPOS_TRAB = ["Refaccion", "Servicio", "Mano de Obra"];
const CAT_TIPOS_CLI = ["todos", "particular", "flotilla", "gs"];
const CAT_CFG0 = { tarifaMO: 480, margenGrande: 1.3, margenChico: 1.6, descFlotilla: 0, descGS: 0, soloCatalogo: false };
const CAT_MAX_PARTIDAS = 15;
const SOL_MAX = 300;
const HIST_TANDA = 40;
const ctxt = (x, n) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n);
const ctxtL = (x, n) => String(x == null ? "" : x).replace(/\r\n?/g, "\n").trim().slice(0, n);
const cnum = (x, min, max, d) => { const n = Number(x); return isNaN(n) ? d : Math.min(max, Math.max(min, n)); };

// Tipo de cliente de una orden (para el historial y para proponer el filtro)
function tipoClienteDe(o) {
  const fl = String(((o && o.flotilla) || {}).nombre || "").trim(), cl = String(((o && o.cliente) || {}).nombre || "").trim();
  if (/salinas|azteca|elektra|italika|totalplay/i.test(fl + " " + cl)) return "gs";
  if (fl && !/^particular$/i.test(fl)) return "flotilla";
  return "particular";
}

async function catLeer() {
  const d = await getJSON(S(), "catalogo");
  return d && d.items ? d : { items: {}, config: { ...CAT_CFG0 }, _u: 0 };
}
const catCfg = (d) => ({ ...CAT_CFG0, ...((d && d.config) || {}) });
const catTotal = (it) => v26r2((it.partidas || []).reduce((s, p) => s + v26importe(p), 0));

// Lo que ve oficina: sin costo, margen, notas internas ni historial de cambios
function catPublico(it, dir) {
  if (dir) return it;
  const { notas, cambios, creadoPor, porAct, ...resto } = it;
  return { ...resto, partidas: (it.partidas || []).map(({ costo, margen, ...p }) => p) };
}

async function verCatalogo(ses) {
  const dir = esDireccion(ses.rol);
  const d = await catLeer();
  const cfg = catCfg(d);
  const items = Object.values(d.items || {}).filter((it) => dir || it.activo !== false).map((it) => catPublico(it, dir));
  const sd = (await getJSON(S(), "catalogo_sol")) || { lista: [] };
  const corte = now() - 30 * 864e5;
  const solicitudes = (sd.lista || []).filter((s) => s.estado === "pendiente" || nz(s.tsResuelta) > corte)
    .filter((s) => dir || s.porU === ses.usuario || s.estado === "pendiente" || s.estado === "resuelta")
    .sort((a, b) => b.ts - a.ts);
  return { ok: true, items, puedeEditar: dir, u: d._u || 0, solicitudes,
    config: dir ? cfg : { tarifaMO: cfg.tarifaMO, descFlotilla: cfg.descFlotilla, descGS: cfg.descGS, soloCatalogo: !!cfg.soloCatalogo } };
}

function limpiarPartida(p, i) {
  p = p || {};
  const tt = CAT_TIPOS_TRAB.find((t) => t.toLowerCase() === String(p.tipoTrabajo || "").trim().toLowerCase());
  const out = { concepto: ctxt(p.concepto, 140), tipoTrabajo: tt || "", componente: ctxt(p.componente, 90), marca: ctxt(p.marca, 60),
    cantidad: v26r2(cnum(p.cantidad, 0, 9999, 0)), precio: v26r2(cnum(p.precio, 0, 9999999, 0)) };
  if (p.costo !== undefined && p.costo !== "" && p.costo !== null) out.costo = v26r2(cnum(p.costo, 0, 9999999, 0));
  if (p.margen !== undefined && p.margen !== "" && p.margen !== null) out.margen = cnum(p.margen, 1, 5, 1);
  if (p.horas !== undefined && p.horas !== "" && p.horas !== null) out.horas = v26r2(cnum(p.horas, 0, 500, 0));
  const falta = [];
  if (!out.concepto) falta.push("descripción");
  if (!out.tipoTrabajo) falta.push("tipo de trabajo");
  if (!out.componente) falta.push("componente");
  if (!(out.cantidad > 0)) falta.push("cantidad");
  if (!(out.precio > 0)) falta.push("precio");
  return { p: out, error: falta.length ? `Partida ${i + 1}: falta ${falta.join(", ")}` : "" };
}

async function guardarCatItem(b, ses) {
  if (!esDireccion(ses.rol)) return { ok: false, soloDireccion: true, error: "Sólo dirección puede dar de alta o cambiar precios. Pídelo con “Pedir precio”." };
  const e = (b && b.item) || {};
  const nombre = ctxt(e.nombre, 140);
  if (!nombre) return { ok: false, error: "Escribe el nombre del servicio" };
  const pin = Array.isArray(e.partidas) ? e.partidas.slice(0, CAT_MAX_PARTIDAS) : [];
  if (!pin.length) return { ok: false, error: "Agrega al menos una partida con su precio" };
  const partidas = [];
  for (let i = 0; i < pin.length; i++) { const r = limpiarPartida(pin[i], i); if (r.error) return { ok: false, error: r.error }; partidas.push(r.p); }
  const pal = (Array.isArray(e.palabras) ? e.palabras : String(e.palabras || "").split(/[,;\n]/))
    .map((x) => ctxt(x, 40).toLowerCase()).filter(Boolean);
  const tc = CAT_TIPOS_CLI.indexOf(String(e.tipoCliente || "todos")) >= 0 ? String(e.tipoCliente || "todos") : "todos";
  const id = /^c_[A-Za-z0-9_-]{4,40}$/.test(String(e.id || "")) ? String(e.id) : "c_" + uuid().replace(/-/g, "").slice(0, 12);
  let antes = null, item = null;
  await mutate(S(), "catalogo", () => ({ items: {}, config: { ...CAT_CFG0 }, _u: 0 }), async (d) => {
    d.items = d.items || {};
    const prev = d.items[id] || null;
    if (e.id && !prev) throw new Error("Ese servicio ya no existe en el catálogo. Recarga la pantalla.");
    antes = prev ? catTotal(prev) : null;
    item = {
      id, nombre, palabras: [...new Set(pal)].slice(0, 30), categoria: ctxt(e.categoria, 40), marca: ctxt(e.marca, 40), modelo: ctxt(e.modelo, 40),
      tipoCliente: tc, partidas, incluye: ctxtL(e.incluye, 1200), notas: ctxtL(e.notas, 600), activo: e.activo === false ? false : true,
      creado: prev ? prev.creado : now(), creadoPor: prev ? prev.creadoPor : usuarioTxt(ses), actualizado: now(), porAct: usuarioTxt(ses),
      cambios: ((prev && prev.cambios) || []).slice(-19),
    };
    const total = catTotal(item);
    if (!prev || antes !== total) item.cambios.push({ ts: now(), por: usuarioTxt(ses), total });
    d.items[id] = item; d._u = now();
    return true;
  });
  let sol = null;
  if (b.solicitud) sol = await marcarSolicitud(String(b.solicitud), "resuelta", ses, { itemId: id, nombre });
  await logBitacora({ que: antes === null ? "CATÁLOGO DE PRECIOS · ALTA" : "CATÁLOGO DE PRECIOS · CAMBIO",
    antes: `${nombre}${item.marca ? " · " + item.marca + (item.modelo ? " " + item.modelo : "") : ""} · cliente ${tc}` + (antes === null ? "" : ` · total antes ${antes}`),
    despues: `Total ${catTotal(item)} · ${partidas.length} partida(s) · ${usuarioTxt(ses)}` });
  return { ok: true, item, solicitud: sol };
}

// v27.1 · Precarga: Chema carga de un jalón lo que ya se cotizó (lo arma la app con el historial;
// él sólo valida los que tienen precios distintos para el mismo vehículo)
const CAT_MAX_IMPORT = 600;
async function importarCatalogo(b, ses) {
  if (!esDireccion(ses.rol)) return { ok: false, soloDireccion: true, error: "Sólo dirección puede cargar precios al catálogo" };
  const lista = Array.isArray(b.items) ? b.items.slice(0, CAT_MAX_IMPORT) : [];
  if (!lista.length) return { ok: false, error: "No hay servicios para cargar" };
  const listos = [], rechazados = [];
  for (let k = 0; k < lista.length; k++) {
    const e = lista[k] || {};
    const nombre = ctxt(e.nombre, 140);
    const pin = Array.isArray(e.partidas) ? e.partidas.slice(0, CAT_MAX_PARTIDAS) : [];
    let err = !nombre ? "sin nombre" : !pin.length ? "sin partidas" : "";
    const partidas = [];
    for (let i = 0; !err && i < pin.length; i++) { const r = limpiarPartida(pin[i], i); if (r.error) err = r.error; else partidas.push(r.p); }
    if (err) { rechazados.push({ i: k, nombre, error: err }); continue; }
    const pal = (Array.isArray(e.palabras) ? e.palabras : String(e.palabras || "").split(/[,;\n]/)).map((x) => ctxt(x, 40).toLowerCase()).filter(Boolean);
    const tc = CAT_TIPOS_CLI.indexOf(String(e.tipoCliente || "todos")) >= 0 ? String(e.tipoCliente || "todos") : "todos";
    const o = e.origen || {};
    listos.push({ id: "c_" + uuid().replace(/-/g, "").slice(0, 12), nombre, palabras: [...new Set(pal)].slice(0, 30), categoria: ctxt(e.categoria, 40),
      marca: ctxt(e.marca, 40), modelo: ctxt(e.modelo, 40), tipoCliente: tc, partidas, incluye: ctxtL(e.incluye, 1200), notas: ctxtL(e.notas, 600),
      activo: true, creado: now(), creadoPor: usuarioTxt(ses), actualizado: now(), porAct: usuarioTxt(ses),
      origen: { folio: ctxt(o.folio, 30), fecha: ctxt(o.fecha, 10), veces: Math.max(0, Math.floor(nz(o.veces))) },
      cambios: [{ ts: now(), por: usuarioTxt(ses) + " · precarga", total: catTotal({ partidas }) }] });
  }
  if (listos.length) {
    await mutate(S(), "catalogo", () => ({ items: {}, config: { ...CAT_CFG0 }, _u: 0 }), async (d) => {
      d.items = d.items || {};
      for (const it of listos) d.items[it.id] = it;
      d._u = now();
      return true;
    });
    await logBitacora({ que: "CATÁLOGO DE PRECIOS · PRECARGA", antes: `${listos.length} servicio(s) desde cotizaciones anteriores`, despues: usuarioTxt(ses) + (rechazados.length ? ` · ${rechazados.length} rechazado(s)` : "") });
  }
  return { ok: true, cargados: listos.length, rechazados };
}

async function activarCatItem(b, ses) {
  if (!esDireccion(ses.rol)) return { ok: false, soloDireccion: true, error: "Sólo dirección puede cambiar el catálogo" };
  const id = String(b.id || ""), activo = b.activo !== false;
  let nombre = "";
  const r = await mutate(S(), "catalogo", () => ({ items: {}, config: { ...CAT_CFG0 }, _u: 0 }), async (d) => {
    const it = d.items && d.items[id];
    if (!it) return false;
    it.activo = activo; it.actualizado = now(); it.porAct = usuarioTxt(ses); nombre = it.nombre; d._u = now();
    return true;
  });
  if (!r) return { ok: false, error: "Ese servicio ya no existe" };
  await logBitacora({ que: "CATÁLOGO DE PRECIOS · " + (activo ? "REACTIVADO" : "DESACTIVADO"), antes: nombre, despues: usuarioTxt(ses) });
  return { ok: true };
}

async function configCatalogo(b, ses) {
  if (!esDireccion(ses.rol)) return { ok: false, soloDireccion: true, error: "Sólo dirección puede cambiar la configuración de precios" };
  const c = (b && b.config) || {};
  let cfg = null;
  await mutate(S(), "catalogo", () => ({ items: {}, config: { ...CAT_CFG0 }, _u: 0 }), async (d) => {
    const prev = catCfg(d);
    cfg = { tarifaMO: v26r2(cnum(c.tarifaMO, 0, 20000, prev.tarifaMO)), margenGrande: cnum(c.margenGrande, 1, 5, prev.margenGrande),
      margenChico: cnum(c.margenChico, 1, 5, prev.margenChico), descFlotilla: cnum(c.descFlotilla, 0, 60, prev.descFlotilla), descGS: cnum(c.descGS, 0, 60, prev.descGS),
      soloCatalogo: c.soloCatalogo === undefined ? !!prev.soloCatalogo : !!c.soloCatalogo };
    d.config = cfg; d._u = now();
    return true;
  });
  await logBitacora({ que: "CATÁLOGO DE PRECIOS · CONFIGURACIÓN", antes: usuarioTxt(ses), despues: JSON.stringify(cfg) });
  return { ok: true, config: cfg };
}

/* ---- solicitudes de precio (oficina → Chema) ---- */
async function solicitarPrecio(b, ses) {
  const texto = ctxt(b.texto, 120);
  if (texto.length < 3) return { ok: false, error: "Escribe qué servicio o pieza necesitas cotizar" };
  const s = { id: "s_" + uuid().replace(/-/g, "").slice(0, 12), texto, marca: ctxt(b.marca, 40), modelo: ctxt(b.modelo, 40), anio: ctxt(b.anio, 6),
    tipo: CAT_TIPOS_CLI.indexOf(String(b.tipo || "")) >= 0 ? String(b.tipo) : "", nota: ctxtL(b.nota, 300),
    folio: ctxt(b.folio, 30), orden: ctxt(b.orden, 60), ts: now(), por: usuarioTxt(ses), porU: ses.usuario, porNombre: ses.nombre, estado: "pendiente" };
  let out = s, repetida = false;
  await mutate(S(), "catalogo_sol", () => ({ lista: [] }), async (d) => {
    d.lista = d.lista || [];
    const k = (x) => [v26norm(x.texto), v26norm(x.marca), v26norm(x.modelo), x.tipo || ""].join("|");
    const ya = d.lista.find((x) => x.estado === "pendiente" && k(x) === k(s));
    if (ya) { out = ya; repetida = true; return undefined; }
    d.lista.push(s);
    if (d.lista.length > SOL_MAX) {
      const pend = d.lista.filter((x) => x.estado === "pendiente"), resto = d.lista.filter((x) => x.estado !== "pendiente");
      d.lista = pend.concat(resto.sort((a, c) => nz(c.tsResuelta) - nz(a.tsResuelta)).slice(0, Math.max(0, SOL_MAX - pend.length)));
    }
    return true;
  });
  if (!repetida) await logBitacora({ folio: s.folio, que: "SOLICITUD DE PRECIO", antes: texto + (s.marca ? " · " + s.marca + " " + s.modelo : ""), despues: "Pidió: " + s.por });
  return { ok: true, solicitud: out, repetida };
}
async function marcarSolicitud(id, estado, ses, extra) {
  let out = null;
  await mutate(S(), "catalogo_sol", () => ({ lista: [] }), async (d) => {
    const s = (d.lista || []).find((x) => x.id === id);
    if (!s) return undefined;
    s.estado = estado; s.tsResuelta = now(); s.resolvio = usuarioTxt(ses);
    if (extra) Object.assign(s, extra);
    out = s;
    return true;
  });
  return out;
}
async function resolverSolicitud(b, ses) {
  if (!esDireccion(ses.rol)) return { ok: false, soloDireccion: true, error: "Sólo dirección atiende las solicitudes de precio" };
  const estado = b.estado === "resuelta" ? "resuelta" : "descartada";
  const s = await marcarSolicitud(String(b.id || ""), estado, ses, { respuesta: ctxtL(b.respuesta, 300), ...(b.itemId ? { itemId: String(b.itemId) } : {}) });
  return s ? { ok: true, solicitud: s } : { ok: false, error: "Esa solicitud ya no existe" };
}
// Para el contador de 1 minuto: Chema ve cuántas hay pendientes; quien pidió, cuáles ya tienen precio
async function avisosPrecios(ses) {
  const d = await getJSON(S(), "catalogo_sol");
  const lista = (d && d.lista) || [];
  if (esDireccion(ses.rol)) return { preciosPend: lista.filter((s) => s.estado === "pendiente").length };
  const corte = now() - 7 * 864e5;
  return { misPrecios: lista.filter((s) => s.porU === ses.usuario && s.estado !== "pendiente" && nz(s.tsResuelta) > corte)
    .map((s) => ({ id: s.id, texto: s.texto, estado: s.estado, nombre: s.nombre || "", ts: s.tsResuelta })) };
}

/* ---- historial de lo cotizado (precios_hist) ---- */
function histEntrada(o) {
  if (!o || !o.id) return null;
  const co = o.cotizacion || {};
  const items = (co.items || []).filter((it) => it && (String(it.concepto || "").trim() || nz(it.precio)))
    .map((it) => [ctxt(it.concepto, 140), ctxt(it.componente, 90), ctxt(it.tipoTrabajo, 20), nz(it.cantidad), nz(it.precio)]);
  if (!items.length) return null;
  const v = o.vehiculo || {};
  return { f: o.folio || "", d: o.fecha || "", s: o.sucursal || "", t: tipoClienteDe(o), c: ctxt((o.flotilla || {}).nombre, 60),
    ma: ctxt(v.marca, 30), mo: ctxt(v.modelo, 40), a: ctxt(v.anio, 6), e: o.estatus || "", p: !!o._prueba, i: items };
}
async function histActualizar(ords) {
  const cambios = ords.filter(Boolean).map((o) => [o.id, histEntrada(o)]);
  if (!cambios.length) return;
  await mutate(S(), "precios_hist", () => ({ o: {}, completo: false }), async (d) => {
    d.o = d.o || {};
    let algo = false;
    for (const [id, e] of cambios) {
      if (e) { if (JSON.stringify(d.o[id]) !== JSON.stringify(e)) { d.o[id] = e; algo = true; } }
      else if (d.o[id]) { delete d.o[id]; algo = true; }
    }
    return algo ? true : undefined;
  });
}
async function histTrasGuardar(x, prev) {
  if (prev && JSON.stringify(histEntrada(prev)) === JSON.stringify(histEntrada(x))) return;
  await histActualizar([x]);
}
async function histQuitar(id) {
  await mutate(S(), "precios_hist", () => ({ o: {}, completo: false }), async (d) => {
    if (!d.o || !d.o[id]) return undefined;
    delete d.o[id];
    return true;
  });
}
async function historialPrecios() {
  const d = (await getJSON(S(), "precios_hist")) || { o: {}, completo: false };
  const hist = Object.entries(d.o || {}).map(([id, e]) => ({ id, ...e }));
  return { ok: true, hist, completo: !!d.completo, n: hist.length };
}
// Primera vez: recorre todas las órdenes por tandas (la app repite la llamada hasta terminar)
async function reconstruirHist(b) {
  const st = S();
  const idx = (await getJSON(st, "idx")) || idxInit();
  const ids = Object.keys(idx.o).sort();
  const desde = Math.max(0, Math.floor(nz(b.cursor)));
  const tanda = ids.slice(desde, desde + HIST_TANDA);
  const ords = (await Promise.all(tanda.map((id) => getJSON(st, "o/" + id)))).filter(Boolean);
  if (desde === 0) {
    // borra lo que ya no existe
    await mutate(st, "precios_hist", () => ({ o: {}, completo: false }), async (d) => {
      d.o = d.o || {};
      let algo = false;
      for (const id of Object.keys(d.o)) if (!idx.o[id]) { delete d.o[id]; algo = true; }
      return algo ? true : undefined;
    });
  }
  await histActualizar(ords);
  const siguiente = desde + tanda.length < ids.length ? desde + tanda.length : null;
  if (siguiente === null) await mutate(st, "precios_hist", () => ({ o: {}, completo: false }), async (d) => { d.completo = true; d.ts = now(); return true; });
  return { ok: true, hechos: desde + tanda.length, total: ids.length, siguiente };
}

/* v27.2 · Para el cliente: cada trabajo con sus partidas (refacción, servicio, mano de obra) y
   sus importes; la liga y el PDF muestran el desglose por pieza y el total de cada tipo. */
function v27tipo(it) {
  if (v26esMO(it) || String((it && it.tipo) || "") === "mano_obra") return "mo";
  return /^servicio/i.test(String((it && it.tipoTrabajo) || "").trim()) ? "serv" : "ref";
}
function v27desglose(co, t) {
  const items = (co && co.items) || [], r = { ref: 0, serv: 0, mo: 0, partidas: [] };
  for (const k of t.idx || []) {
    const it = items[k] || {}, imp = v26importe(it), tp = v27tipo(it);
    r[tp] += imp;
    r.partidas.push({ concepto: String(it.concepto || "").trim(), cantidad: nz(it.cantidad), importe: imp, tipo: tp });
  }
  r.ref = v26r2(r.ref); r.serv = v26r2(r.serv); r.mo = v26r2(r.mo);
  return r;
}

/* ------------------------- ENTRADA ------------------------- */
export default async (req) => {
  const url = new URL(req.url);
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, "");

  // Fotos: públicas por enlace (igual que Drive "cualquiera con el enlace"); la llave es una huella imposible de adivinar
  const mm = /^\/api\/m\/([A-Za-z0-9_-]+)$/.exec(path);
  if (mm && req.method === "GET") {
    const r = await M().getWithMetadata(mm[1], { type: "arrayBuffer" }).catch(() => null);
    if (!r) return new Response("No encontrada", { status: 404 });
    return new Response(r.data, { headers: { "content-type": (r.metadata && r.metadata.type) || "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*" } });
  }
  // v26: liga del cliente (sin clave ni sesión; la llave es aleatoria y se puede renovar)
  const mc = /^\/api\/c\/([A-Za-z0-9_-]+)$/.exec(path);
  if (mc) {
    try {
      if (req.method === "GET") return json(await vistaCliente(mc[1], origin));
      if (req.method !== "POST") return json({ ok: false, error: "Método no permitido" }, 405);
      let bc; try { bc = JSON.parse(await req.text()); } catch { return json({ ok: false, error: "Petición inválida" }); }
      if (bc && bc.action === "autorizar") return json(await autorizarCliente(mc[1], bc, req));
      return json({ ok: false, error: "Acción desconocida" });
    } catch (e) { return json({ ok: false, error: String((e && e.message) || e) }); }
  }
  if (path !== "/api") return json({ ok: false, error: "Ruta no encontrada" }, 404);

  const CLAVE = env("CLAVE", "arsan");
  try {
    if (req.method === "GET") {
      const p = Object.fromEntries(url.searchParams);
      if (p.clave !== CLAVE) return json({ ok: false, error: "Clave incorrecta" });
      const a = p.action || "list";
      if (a === "ping") {
        const cfg = await getConfig();
        return json({ ok: true, msg: "Backend Arsan activo (Netlify)", version: BACKEND_VERSION, borrado: true, login: true,
          netlify: true, modo: cfg.modo, puente: env("PUENTE_URL") });
      }
      const s = await sesionValida(p.sesion);
      if (!s.ok) return json({ ok: false, auth: true, error: "Sesión no válida. Inicia sesión de nuevo." });
      // v25: el técnico sólo ve lo mínimo para tomar fotos
      if (a === "tec") return json(await vistaTecnico(s));
      if (a === "tecOrden") return json(absOut(await ordenTecnico(p.id, s), origin));
      if (esTecnico(s.rol)) return json({ ok: false, soloTaller: true, error: "Tu usuario es de taller: esa información la ve oficina." });
      if (a === "solicitudes") { const r = await listaSolicitudes(); try { Object.assign(r, await avisosPrecios(s)); } catch {} return json(r); }
      if (a === "catalogo") return json(await verCatalogo(s));   // v27
      if (a === "historialPrecios") return json(await historialPrecios());   // v27
      if (a === "tecnicos") return json(await listaTecnicos());
      if (a === "list") return json({ ok: true, ordenes: await listar() });
      if (a === "get") { const o = await obtener(p.id, p.folio); return json({ ok: true, orden: o ? absOut(o, origin) : null }); }
      if (a === "componentes") return json(await listComponentes());
      if (a === "cobranza") { const d = await getJSON(S(), "cobranza_gs"); return json({ ok: true, cobranza: d || null }); }
      return json({ ok: false, error: "Acción desconocida" });
    }

    if (req.method !== "POST") return json({ ok: false, error: "Método no permitido" }, 405);
    let b;
    try { b = JSON.parse(await req.text()); } catch { return json({ ok: false, error: "Petición inválida" }); }

    // Llamadas del Apps Script (migración, respaldo, machote)
    if (b.secreto !== undefined) {
      const SEC = env("PUENTE_SECRETO");
      if (!SEC || String(b.secreto) !== SEC) return json({ ok: false, error: "Secreto del puente incorrecto" }, 401);
      return json(await puente(b, origin));
    }

    if (b.clave !== CLAVE) return json({ ok: false, error: "Clave incorrecta" });
    if (b.action === "login") return json(await login(b.usuario, b.password));
    if (b.action === "logout") { if (b.sesion) await S().delete("ses/" + b.sesion).catch(() => {}); return json({ ok: true }); }
    const ses = await sesionValida(b.sesion);
    if (!ses.ok) return json({ ok: false, auth: true, error: "Sesión no válida. Inicia sesión de nuevo." });
    // v25: acciones del taller
    if (b.action === "subir" || b.action === "tecAgregar" || b.action === "tecDiagnostico") {
      if (b.action === "tecAgregar") return json(await tecAgregar(b, ses, origin));
      if (b.action === "tecDiagnostico") return json(await tecDiagnostico(b, ses));
    } else if (esTecnico(ses.rol)) {
      // v25.1: el técnico guarda multipuntos y checklist con la pantalla de siempre; el servidor sólo toma esos dos campos
      if (b.action === "save") return json(await tecGuardar(b.orden, ses));
      return json({ ok: false, soloTaller: true, error: "Tu usuario es de taller: esa acción la hace oficina." });
    }
    switch (b.action) {
      case "pedirFotos": return json(await pedirFotos(b, ses));
      case "solicitud": return json(await cambiarSolicitud(b, ses));
      case "ligaCliente": return json(await ligaCliente(b, ses, origin)); // v26
      case "catalogoGuardar": return json(await guardarCatItem(b, ses));   // v27: sólo dirección
      case "catalogoActivo": return json(await activarCatItem(b, ses));    // v27: sólo dirección
      case "catalogoImportar": return json(await importarCatalogo(b, ses)); // v27.1: precarga, sólo dirección
      case "catalogoConfig": return json(await configCatalogo(b, ses));    // v27: sólo dirección
      case "precioSolicitud": return json(await resolverSolicitud(b, ses)); // v27: sólo dirección
      case "precioSolicitar": return json(await solicitarPrecio(b, ses));   // v27: oficina
      case "historialReconstruir": return json(await reconstruirHist(b));  // v27
      case "save": return json(await guardar(b.orden, b.token, ses));
      case "subir": { const u = await guardarMedio(b.data); return json(u ? { ok: true, url: origin + u } : { ok: false, error: "No se pudo guardar la foto" }); }
      case "clientes": return json(await listClientes());
      case "cliente": return json(await saveCliente(b.cliente));
      case "unlock": return json(await autorizar(b.pin));
      case "delete": return json(await eliminarOrden(b.id, b.folio, b.pin, b.token, ses));
      case "evaluarmp": return json(evaluarMultipuntos(b.puntos));
      case "cargarCobranza": return json(await cargarCobranza(b, ses));
      case "rescatarEntrega": return json(await rescatarEntrega(b));
      case "proxy": {
        // trae una foto que quedó en Drive (por si alguna no se migró) para incrustarla en el PDF
        const u = String(b.url || "");
        if (!/^https:\/\/(drive|docs|lh\d)\.google(usercontent)?\.com\//.test(u)) return json({ ok: false, error: "URL no permitida" });
        const r = await fetch(u);
        if (!r.ok) return json({ ok: false, error: "No se pudo descargar" });
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return json({ ok: true, data: `data:${r.headers.get("content-type") || "image/jpeg"};base64,${btoa(bin)}` });
      }
      default: return json({ ok: false, error: "Acción desconocida" });
    }
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) });
  }
};

export const config = { path: ["/api", "/api/*"] };
