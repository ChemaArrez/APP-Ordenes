/****************************************************************
 *  ARSAN MOTORS · Órdenes de servicio — Backend v24 (Netlify)
 *
 *  Reemplaza al Apps Script como backend de la app. Habla EXACTAMENTE
 *  el mismo idioma que el Apps Script de v23 (mismas acciones, mismas
 *  respuestas), así la app casi no cambió por dentro.
 *
 *  Dónde vive cada cosa (Netlify Blobs):
 *    store "ordenes"  → idx (resumen de todas las órdenes), o/<id> (orden
 *                       completa), borradas/<id>, usuarios, ses/<token>,
 *                       tok/<token>, bit/<fecha>_<n> (bitácora), clientes,
 *                       componentes, cobranza_gs, config
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
 *    CLAVE           clave de la app (por omisión "arsan")
 ****************************************************************/
import { getStore } from "@netlify/blobs";

const BACKEND_VERSION = "2026-10-13-v24";
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
    if (esUrl(x)) out.push(x);
    else if (typeof x === "string" && x.indexOf("data:") === 0) { const u = await guardarMedio(x); if (u) out.push(u); }
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
    "total de la cotización": String(co.total != null ? co.total : ""),
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
  };
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

/* ------------------------- GUARDAR ------------------------- */
async function guardar(o, token, ses) {
  if (!o || !o.id) return { ok: false, error: "Orden sin id" };
  o = normIn(o);
  const st = S();
  const prev = await getJSON(st, "o/" + o.id);

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
  await st.setJSON("o/" + x.id, x);

  try {
    if (o.cliente && o.cliente.nombre) {
      const fx = o.fiscal || {};
      await saveCliente({ nombre: o.cliente.nombre, tel: o.cliente.tel, correo: o.cliente.correo, domicilio: o.cliente.domicilio,
        rfc: fx.rfc, razonSocial: fx.razonSocial, regimen: fx.regimen, usoCFDI: fx.usoCFDI, cp: fx.cp, flotilla: (o.flotilla && o.flotilla.nombre) || "" });
    }
  } catch {}
  try { await registrarComponentes((o.cotizacion || {}).items); } catch {}
  return { ok: true, folio: folioFinal, drive: x.driveUrl, urls };
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
  o._u = now(); // para que el Apps Script la respalde en Drive
  await st.setJSON("o/" + o.id, o);
  await mutate(st, "idx", idxInit, async (idx) => { if (idx.o[o.id]) idx.o[o.id]._u = o._u; return true; });
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
async function cargarCobranza(b, ses) {
  if (!ses || String(ses.rol || "").toLowerCase() !== "gerencia")
    return { ok: false, error: "Solo un usuario con rol gerencia puede cargar la cobranza" };
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
      const o = await getJSON(st, "o/" + id);
      if (!o || o.driveUrl === m[id]) continue;
      o.driveUrl = String(m[id]);
      await st.setJSON("o/" + id, o); // no cambia _u: no es un cambio de la orden
      await mutate(st, "idx", idxInit, async (idx) => { if (idx.o[id]) idx.o[id].driveUrl = o.driveUrl; return true; });
    }
    return { ok: true };
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
    switch (b.action) {
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
