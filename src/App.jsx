import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from "recharts";

// ================= Backend (Google Apps Script) =================
// Sustituye estos dos valores por los tuyos tras desplegar el backend
// (ver GUIA_DESPLIEGUE.md). API_TOKEN debe coincidir exactamente con el
// definido en el Code.gs del Apps Script — es lo que impide que cualquiera
// que encuentre la URL pueda leer/escribir en tu Sheet sin pasar por la app.
const API_URL = "https://script.google.com/macros/s/AKfycbxh7u6-X2e6wQhbdgfbNOIZYAfiV_gLQszpWpJdGhXMbvgp32SR3pbi33giYXJ0-aXOsg/exec";
const API_TOKEN = "wtt5teGfYTidgZ9TGD19RhF4bJkt7mYPliUULocb";

// ================= Storage keys =================
const K_DATASET = "cmj_dataset_v1";
const K_MICROCICLOS = "cmj_microciclos_v2";
const K_THRESHOLDS = "cmj_thresholds_v1";
const K_ROSTER = "cmj_roster_v1";
const K_PLANTILLAS = "cmj_plantillas_v1";

// ================= CSV parsing =================
const COLS = [
  "fecha","equipo","nombre","peso","hp0","tipo","altCajon","carga",
  "altura","rsiMod","tDespegue","tVuelo","tContacto","dri","fuerza",
  "velocidad","potencia","impulse","ifr","stiffness","color"
];

function num(v) {
  if (v === undefined) return null;
  const s = v.trim();
  if (s === "" || s === "---") return null;
  const n = parseFloat(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function parseDateTime(raw) {
  const [datePart, timePart] = raw.split(",").map(s => s.trim());
  if (!datePart) return null;
  const [d, m, y] = datePart.split(".").map(x => parseInt(x, 10));
  let h = 0, mi = 0;
  if (timePart) {
    const [hh, mm] = timePart.split(":").map(x => parseInt(x, 10));
    h = hh || 0; mi = mm || 0;
  }
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d, h, mi);
}

function dateKey(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], issues: {} };
  const rows = [];
  const seen = new Set();
  let dupCount = 0, pesoZero = 0, hp0Suspect = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(";");
    if (parts.length < 20) continue;
    const rec = {};
    COLS.forEach((c, idx) => { rec[c] = parts[idx]; });

    const nombre = (rec.nombre || "").trim().replace(/\s+/g, " ");
    if (!nombre) continue;
    const date = parseDateTime(rec.fecha);
    if (!date) continue;

    const peso = num(rec.peso);
    const hp0 = num(rec.hp0);
    const altura = num(rec.altura);
    if (altura === null || altura <= 0) continue;

    const pesoValid = peso !== null && peso > 0;
    const hp0Valid = hp0 !== null && hp0 >= 0.10 && hp0 <= 0.55;
    if (!pesoValid) pesoZero++;
    if (peso !== null && peso > 0 && !hp0Valid) hp0Suspect++;
    const kineticsValid = pesoValid && hp0Valid;

    const key = nombre + "|" + date.getTime() + "|" + altura;
    if (seen.has(key)) { dupCount++; continue; }
    seen.add(key);

    rows.push({
      nombre, equipo: (rec.equipo || "").trim(), date: date.toISOString(), dateKey: dateKey(date),
      peso, hp0, altura,
      fuerza: kineticsValid ? num(rec.fuerza) : null,
      potencia: kineticsValid ? num(rec.potencia) : null,
      velocidad: num(rec.velocidad),
      kineticsValid, pesoValid, hp0Valid
    });
  }
  const { rows: aggregated, sessionsAgregadas } = aggregateByDay(rows);
  return { rows: aggregated, issues: { dupCount, pesoZero, hp0Suspect, total: aggregated.length, sessionsAgregadas } };
}

// Si un jugador tiene más de un salto registrado el mismo día (protocolo de
// varios intentos por sesión), se promedian en un único test representativo
// de ese día antes de entrar en el resto del análisis — así el CSV se puede
// leer igual con 1 salto o con 3 sin tocar nada más de la app.
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
// Recharts fuerza por defecto el eje Y a empezar en 0 si no se le da un dominio
// explícito — con esto se calcula el rango real de los datos mostrados y se le
// añade un margen, para que las variaciones reales (aunque sean pequeñas) se
// vean con claridad en vez de aplastarse contra un eje que empieza en cero.
function computeDomain(values, padFactor = 0.15) {
  const valid = values.filter(v => v != null && Number.isFinite(v));
  if (!valid.length) return ["auto", "auto"];
  // Mínimo/máximo reales de los datos mostrados — ningún punto debe quedar
  // nunca fuera del gráfico. La protección frente a valores disparatados
  // (media casi cero al normalizar) se hace en origen, no recortando aquí.
  const min = Math.min(...valid), max = Math.max(...valid);
  if (min === max) { const pad = Math.abs(min) * 0.1 || 1; return [min - pad, max + pad]; }
  const pad = (max - min) * padFactor;
  return [min - pad, max + pad];
}

// Para cada fila de la tabla, decide contra qué comparar el dato — la
// referencia con sentido depende de qué tipo de test es esa fila:
// MD-2/MD+1 se comparan con el Inicio de esa misma semana (igual que en el
// resto del panel); un Inicio se compara con el Inicio anterior (tendencia).
// Un test sin etiqueta no tiene una referencia válida, así que no se muestra nada.
function referenciaFila(player, row, metric) {
  if (row.tag === "md2" || row.tag === "md1") {
    if (row.microId == null) return null;
    const mr = player.microResults.get(row.microId);
    if (!mr || !mr.inicio) return null;
    const baseVal = metric.get(mr.inicio);
    const val = metric.get(row);
    if (baseVal == null || val == null) return null;
    return pct(val, baseVal);
  }
  if (row.tag === "inicio") {
    const idx = player.inicios.findIndex(r => r.date === row.date);
    if (idx <= 0) return null;
    const baseVal = metric.get(player.inicios[idx - 1]);
    const val = metric.get(row);
    if (baseVal == null || val == null) return null;
    return pct(val, baseVal);
  }
  return null;
}
function CeldaConReferencia({ valor, unidad, decimales, refInfo }) {
  return (
    <>
      {valor == null ? "—" : `${fmt(valor, decimales)} ${unidad}`}
      {refInfo != null && (
        <span style={{ ...S.tablaRefTag, color: refInfo >= 0 ? "#22C55E" : "#EF4444" }}>
          {" "}{signed(refInfo)}
        </span>
      )}
    </>
  );
}
function sdMuestral(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function clamp(v, min, max) { return v == null ? null : Math.min(max, Math.max(min, v)); }
const MIN_INICIOS_PARA_INDIVIDUALIZAR = 4;
const MIN_INICIOS_PARA_RESPALDO_RECUPERACION = 3;
function aggregateByDay(rows) {
  const groups = new Map();
  rows.forEach(r => {
    const key = `${r.nombre}|${r.dateKey}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(r);
  });
  let sessionsAgregadas = 0;
  const result = [];
  groups.forEach(group => {
    if (group.length === 1) { result.push({ ...group[0], nSaltos: 1 }); return; }
    sessionsAgregadas++;
    const sorted = [...group].sort((a, b) => new Date(a.date) - new Date(b.date));
    const kinRows = sorted.filter(r => r.kineticsValid);
    const velRows = sorted.filter(r => r.velocidad != null);
    result.push({
      nombre: sorted[0].nombre, equipo: sorted[0].equipo,
      date: sorted[0].date, dateKey: sorted[0].dateKey,
      peso: mean(sorted.map(r => r.peso).filter(v => v > 0)) ?? sorted[0].peso,
      hp0: sorted[0].hp0,
      altura: mean(sorted.map(r => r.altura)),
      kineticsValid: kinRows.length > 0,
      pesoValid: sorted.some(r => r.pesoValid),
      hp0Valid: sorted.some(r => r.hp0Valid),
      fuerza: kinRows.length ? mean(kinRows.map(r => r.fuerza)) : null,
      potencia: kinRows.length ? mean(kinRows.map(r => r.potencia)) : null,
      velocidad: velRows.length ? mean(velRows.map(r => r.velocidad)) : null,
      nSaltos: group.length
    });
  });
  return { rows: result, sessionsAgregadas };
}

function pct(a, b) { return b ? ((a - b) / b) * 100 : null; }
function fmt(v, d = 1) { return v === null || v === undefined ? "—" : v.toFixed(d); }
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit" });
}
function signed(v, d = 1) { return v == null ? "—" : `${v > 0 ? "+" : ""}${fmt(v, d)}%`; }

// Qué mide cada variable a nivel fisiológico y por qué una caída importa —
// contenido real, no solo "por encima del umbral". Se combina con la
// gravedad (severidad) y con el estado (verde/ámbar/rojo) para construir la
// explicación que se ve en el desplegable de cada jugador.
const METRIC_PHYSIO = {
  altura: {
    concepto: "La altura de salto resume la capacidad global de producir fuerza explosiva en muy poco tiempo.",
    rojo: "Una caída de esta magnitud indica fatiga neuromuscular real: el sistema nervioso y el músculo ya no están generando la potencia de salida habitual. Entrenar o competir así aumenta el riesgo de sobrecarga y de lesión, y conviene reducir la carga antes de exigir el gesto explosivo del partido.",
    ambar: "Una caída moderada puede deberse tanto a fatiga incipiente como al ruido normal de un salto único (la altura varía de forma natural un 3–8% entre sesiones). No es motivo de alarma por sí sola, pero conviene confirmarlo en el próximo test antes de intervenir.",
    verde: "Se mantiene dentro de la variabilidad normal — no hay indicio de fatiga en esta variable."
  },
  potenciaRel: {
    concepto: "La potencia relativa mide la velocidad a la que el jugador aplica fuerza por kilo de peso — es más sensible a la fatiga que la propia altura.",
    rojo: "Que caiga con esta intensidad, incluso si la altura aguanta, señala que el jugador está saltando con otra estrategia (más tiempo de contramovimiento, menos explosividad real) para lograr el mismo resultado aparente. Es precisamente la fatiga que la altura por sí sola puede ocultar, y justifica intervenir en la carga aunque el salto \"parezca\" normal.",
    ambar: "Un descenso moderado en la velocidad de aplicación de fuerza, todavía dentro de un margen que puede ser variabilidad del test — pero es la primera señal que suele adelantarse a una caída de altura, así que merece vigilancia.",
    verde: "Dentro de rango normal — el jugador sigue aplicando fuerza a la velocidad habitual."
  },
  fuerzaRel: {
    concepto: "La fuerza relativa indica cuánta fuerza es capaz de generar el jugador por kilo de peso corporal durante el salto.",
    rojo: "Una caída de esta magnitud sugiere fatiga muscular periférica (acumulación de metabolitos, microdaño muscular tras el esfuerzo) o menor activación neural del músculo. Combinada con una caída de potencia, es una señal consistente de fatiga acumulada real, no de un mal salto puntual.",
    ambar: "Una reducción moderada de la capacidad de generar fuerza — a vigilar junto con la potencia en los próximos tests, sin que por sí sola requiera todavía cambios de carga.",
    verde: "Dentro de rango normal — la capacidad de generar fuerza no muestra signos de fatiga."
  }
};
const ACCION_META = { gray: "Sin datos suficientes todavía para valorar." };

// Cuán lejos está un valor del umbral que lo clasificó.
function severidad(delta, status, ambarPct, rojoPct) {
  if (delta == null || status === "gray" || status === "green") return "";
  if (status === "red") {
    const ratio = Math.abs(delta) / rojoPct;
    if (ratio < 1.15) return "justo por encima del umbral rojo";
    if (ratio < 1.5) return "claramente por encima del umbral rojo";
    return "muy por encima del umbral rojo";
  }
  const rango = rojoPct - ambarPct;
  const progreso = rango > 0 ? (Math.abs(delta) - ambarPct) / rango : 0;
  if (progreso > 0.66) return "cerca de pasar a alerta roja";
  if (progreso > 0.33) return "vigilancia moderada, a mitad de camino del umbral rojo";
  return "poco por encima del umbral ámbar";
}

// Misma gravedad que arriba, pero en una sola palabra — para mostrar junto al
// nombre en la tarjeta sin ocupar espacio.
function nivelPalabra(delta, status, ambarPct, rojoPct) {
  if (delta == null || status === "gray" || status === "green") return null;
  if (status === "red") {
    const ratio = Math.abs(delta) / rojoPct;
    if (ratio < 1.15) return "leve";
    if (ratio < 1.5) return "moderada";
    return "severa";
  }
  const rango = rojoPct - ambarPct;
  const progreso = rango > 0 ? (Math.abs(delta) - ambarPct) / rango : 0;
  if (progreso > 0.66) return "severa";
  if (progreso > 0.33) return "moderada";
  return "leve";
}

// Recomendación graduada: cuánto más lejos del rango óptimo, más contundente
// la acción — un 0,5% por encima del umbral no pide lo mismo que un 15%.
// Además, el texto depende de qué día es: en MD-2 no hay ningún test más antes
// del partido (hay que decidir ya), mientras que en MD+1 o en el chequeo de
// recuperación del Inicio todavía queda margen para observar antes de actuar.
function nivelAccion(delta, status, ambarPct, rojoPct, dayField) {
  if (status === "gray") return ACCION_META.gray;
  if (status === "green") return "Dentro del rango normal respecto al Inicio de esta semana — estado óptimo, no se requiere ninguna intervención sobre la carga.";
  if (delta == null) return "";

  const esMD2 = dayField === "md2";

  if (status === "red") {
    const ratio = Math.abs(delta) / rojoPct;
    if (esMD2) {
      if (ratio < 1.15) return "Cae por debajo del Inicio de esta semana, justo por encima del umbral rojo. No habrá otro test antes del partido para confirmarlo: reduce su carga en las próximas 48h o valora ajustar su papel en el once.";
      if (ratio < 1.5) return "Cae por debajo del Inicio de esta semana, claramente por encima del umbral rojo. No habrá otro test antes del partido: reduce de forma notable su exposición o valora que no salga de inicio.";
      return "Cae muy por debajo del Inicio de esta semana, muy por encima del umbral rojo. No habrá otro test antes del partido: prioriza no exponerlo a esfuerzo máximo.";
    }
    if (dayField === "md1") {
      if (ratio < 1.15) return "Cae por debajo del Inicio de esta semana, justo por encima del umbral rojo. Ajusta un poco la sesión regenerativa de hoy; con varios días por delante hasta el próximo test, confirma que remonta.";
      if (ratio < 1.5) return "Cae por debajo del Inicio de esta semana, claramente por encima del umbral rojo. Ajusta con claridad la regenerativa y el resto de la semana, y confirma la evolución en el Inicio del próximo microciclo.";
      return "Cae muy por debajo del Inicio de esta semana, muy por encima del umbral rojo. Prioriza la recuperación esta semana antes de cualquier carga alta, y vigila de cerca cómo llega al MD-2.";
    }
    if (ratio < 1.15) return "Justo por encima del umbral rojo. Reduce ligeramente la carga y confírmalo en el MD-2 de esta semana.";
    if (ratio < 1.5) return "Claramente por encima del umbral rojo. Ajusta volumen/intensidad ya, y vigila de cerca hasta el MD-2.";
    return "Muy por encima del umbral rojo. Prioriza la recuperación antes de seguir cargando esta semana.";
  }

  const rango = rojoPct - ambarPct;
  const progreso = rango > 0 ? (Math.abs(delta) - ambarPct) / rango : 0;
  if (esMD2) {
    if (progreso > 0.66) return "Cae por debajo del Inicio de esta semana, cerca del umbral rojo. No habrá otro test antes del partido para confirmarlo: decide ya si ajustas su participación.";
    if (progreso > 0.33) return "Cae por debajo del Inicio de esta semana, a mitad de camino del umbral rojo. No habrá otro test antes de jugar: valora ahora si conviene ajustar minutos o rol.";
    return "Apenas por debajo del Inicio de esta semana, dentro de lo normal. Aunque es la última medición antes del partido, la magnitud no justifica cambios — puede jugar con normalidad.";
  }
  if (dayField === "md1") {
    if (progreso > 0.66) return "Cae por debajo del Inicio de esta semana, cerca del umbral rojo. Vigila de cerca los próximos días; si se mantiene al llegar al Inicio de la próxima semana, sí conviene ajustar carga.";
    if (progreso > 0.33) return "Cae por debajo del Inicio de esta semana, a mitad de camino del umbral rojo. Probablemente se resuelva con los días de descanso — confírmalo en el Inicio de la próxima semana.";
    return "Apenas por debajo del Inicio de esta semana, dentro de lo esperable el día después de competir — no hace falta ninguna acción, solo confirmarlo cuando toque el próximo test.";
  }
  if (progreso > 0.66) return "Cerca del umbral rojo. Si no mejora en el MD-2 de esta semana, habrá que intervenir.";
  if (progreso > 0.33) return "A mitad de camino del umbral rojo. Vigila la evolución hasta el próximo test antes de decidir.";
  return "Apenas por encima de lo normal — probablemente no haga falta ningún cambio, confírmalo en el próximo test.";
}

// Explicación fisiológica completa de una fila de métrica, para el desplegable.
function explicacionMetrica(metricKey, delta, status, ambarPct, rojoPct) {
  const info = METRIC_PHYSIO[metricKey];
  const sev = severidad(delta, status, ambarPct, rojoPct);
  const texto = status === "red" ? info.rojo : status === "amber" ? info.ambar : info.verde;
  return `${info.concepto} ${texto}${sev ? ` (${sev}).` : ""}`;
}

// Filas de métrica (Altura / Potencia relativa / Fuerza relativa) para un día
// concreto (md2 o md1). Usa el umbral propio de CADA métrica para ese
// jugador (personalizado si tiene historial suficiente, general si no).
function filasDia(microResult, dayField, umbral) {
  return METRIC_LIST.filter(x => x.drivesStatus).map(metric => {
    const mm = microResult.metrics[metric.key];
    const delta = mm[`${dayField}Delta`];
    const status = mm[`${dayField}Status`];
    const u = umbral[metric.key];
    return { key: metric.key, label: metric.label, delta, status, explicacion: explicacionMetrica(metric.key, delta, status, u.ambarPct, u.rojoPct) };
  });
}
function filasRecuperacion(recuperacion, umbral) {
  if (!recuperacion) return [];
  return METRIC_LIST.filter(x => x.drivesStatus).map(metric => {
    const mm = recuperacion.metrics[metric.key];
    const u = umbral[metric.key];
    return { key: metric.key, label: metric.label, delta: mm.delta, status: mm.status, explicacion: explicacionMetrica(metric.key, mm.delta, mm.status, u.ambarPct, u.rojoPct) };
  });
}

// Estado global del día (peor de las 3 métricas) + la recomendación graduada
// según cuánto se aleja esa métrica de SU umbral — el desglose fisiológico
// por variable vive en cada fila (filasDia).
function motivoDia(microResult, dayField, umbral) {
  const statusKey = `${dayField}Status`;
  const deltaKey = `${dayField}Delta`;
  let worst = "gray", worstDelta = null, worstKey = null;
  METRIC_LIST.filter(x => x.drivesStatus).forEach(metric => {
    const mm = microResult.metrics[metric.key];
    const s = mm[statusKey];
    if (STATUS_ORDER[s] < STATUS_ORDER[worst]) { worst = s; worstDelta = mm[deltaKey]; worstKey = metric.key; }
    else if (s === worst && mm[deltaKey] != null && (worstDelta == null || Math.abs(mm[deltaKey]) > Math.abs(worstDelta))) { worstDelta = mm[deltaKey]; worstKey = metric.key; }
  });
  if (worst === "gray") return { status: "gray", motivo: "Test de hoy aún no registrado.", nivel: null };
  const u = umbral[worstKey];
  return { status: worst, motivo: nivelAccion(worstDelta, worst, u.ambarPct, u.rojoPct, dayField), nivel: nivelPalabra(worstDelta, worst, u.ambarPct, u.rojoPct) };
}
function motivoRecuperacion(recuperacion, umbral) {
  if (!recuperacion) return { status: "gray", motivo: "Sin MD+1 del microciclo anterior con el que comparar.", nivel: null };
  const esFallback = recuperacion.modo === "media_inicios";
  if (recuperacion.status === "gray") {
    return { status: "gray", nivel: null, motivo: esFallback
      ? `Esta semana no hubo MD+1 con el que comparar, y todavía no hay suficientes Inicios previos de este jugador para usar como respaldo (tiene ${recuperacion.nPrevios} de los ${MIN_INICIOS_PARA_RESPALDO_RECUPERACION} necesarios).`
      : "Aún sin datos suficientes para valorar la recuperación." };
  }
  let worstDelta = null, worstKey = null;
  METRIC_LIST.filter(x => x.drivesStatus).forEach(metric => {
    const mm = recuperacion.metrics[metric.key];
    if (mm.status === recuperacion.status && mm.delta != null && (worstDelta == null || Math.abs(mm.delta) > Math.abs(worstDelta))) { worstDelta = mm.delta; worstKey = metric.key; }
  });
  const u = umbral[worstKey] || umbral.altura;
  let prefijo;
  if (esFallback) {
    prefijo = recuperacion.status === "green"
      ? `Sin MD+1 esta semana: comparado con su media de los últimos ${recuperacion.nPrevios} Inicios, está dentro de lo habitual. `
      : `Sin MD+1 esta semana: comparado con su media de los últimos ${recuperacion.nPrevios} Inicios, está por debajo de lo habitual. `;
  } else {
    prefijo = recuperacion.status === "green"
      ? "Recuperación adecuada respecto al MD+1 del microciclo anterior. "
      : "No muestra la recuperación esperada tras el descanso. ";
  }
  return { status: recuperacion.status, motivo: prefijo + nivelAccion(worstDelta, recuperacion.status, u.ambarPct, u.rojoPct, "inicio"), nivel: nivelPalabra(worstDelta, recuperacion.status, u.ambarPct, u.rojoPct) };
}


const STATUS_META = {
  red:    { label: "Intervenir",  color: "#EF4444", bg: "rgba(239,68,68,0.14)" },
  amber:  { label: "Vigilar",     color: "#F5C518", bg: "rgba(245,197,24,0.14)" },
  green:  { label: "Normal",      color: "#22C55E", bg: "rgba(34,197,94,0.12)" },
  gray:   { label: "Sin datos",   color: "#4A6680", bg: "rgba(74,102,128,0.14)" }
};
const TAG_META = {
  inicio: { label: "Inicio microciclo", color: "#1E6FD9", field: "inicio" },
  md2:    { label: "MD-2", color: "#F5C518", field: "md2" },
  md1:    { label: "MD+1", color: "#0F4A99", field: "md1" }
};
const FIELDS = ["inicio", "md2", "md1"];

// Métricas disponibles en el export de My Jump Lab que sí traen datos reales
// (RSI mod, tiempo de despegue/contacto, DRI, IFR y stiffness vienen vacíos en
// este protocolo, así que no se pueden usar todavía). Altura, Potencia y
// Fuerza se relativizan por kg para poder comparar entre jugadores y en el
// tiempo; Velocidad se deriva matemáticamente de la altura (v = √(2gh)), así
// que se muestra como lectura alternativa pero no se usa para las alertas
// (sería contar la misma señal dos veces).
const METRICS = {
  altura:      { key: "altura",      label: "Altura",             unit: "cm",   decimals: 1, get: r => r.altura, drivesStatus: true },
  potenciaRel: { key: "potenciaRel", label: "Potencia relativa",  unit: "W/kg", decimals: 1, get: r => (r.kineticsValid && r.peso) ? r.potencia / r.peso : null, drivesStatus: true },
  fuerzaRel:   { key: "fuerzaRel",   label: "Fuerza relativa",    unit: "N/kg", decimals: 1, get: r => (r.kineticsValid && r.peso) ? r.fuerza / r.peso : null, drivesStatus: true },
  velocidad:   { key: "velocidad",   label: "Velocidad",          unit: "m/s",  decimals: 2, get: r => r.velocidad, drivesStatus: false }
};
const METRIC_LABEL_NOTE = "Altura, Potencia relativa y Fuerza relativa son los nombres reales de My Jump Lab (relativizadas por kg para poder comparar entre jugadores). Velocidad es también una columna real del CSV, pero la propia app la calcula a partir del mismo tiempo de vuelo que la altura — se mueve siempre igual, por eso no genera alertas propias.";
const METRIC_LIST = Object.values(METRICS);
// Colores de línea/barra por métrica en las gráficas — deliberadamente distintos
// de los colores de estado (rojo/ámbar/verde) para no mezclar "qué variable es"
// con "qué tan grave es".
const METRIC_CHART_COLOR = { altura: "#1E6FD9", potenciaRel: "#F5C518", fuerzaRel: "#8B5CF6", velocidad: "#4A6680" };
const STATUS_ORDER = { red: 0, amber: 1, green: 2, gray: 3 };

// Posiciones para clasificar y ordenar la plantilla, en orden de línea (portero → delantero).
const POSICIONES = [
  { key: "portero", label: "Porteros", singular: "Portero" },
  { key: "central", label: "Centrales", singular: "Central" },
  { key: "lateral", label: "Laterales", singular: "Lateral" },
  { key: "mediocentro", label: "Mediocentros", singular: "Mediocentro" },
  { key: "interior", label: "Interiores", singular: "Interior" },
  { key: "extremo", label: "Extremos", singular: "Extremo" },
  { key: "delantero", label: "Delanteros", singular: "Delantero" }
];
function posicionLabel(key) { return POSICIONES.find(p => p.key === key)?.singular || "Sin posición"; }
function posicionOrder(key) { const idx = POSICIONES.findIndex(p => p.key === key); return idx === -1 ? 99 : idx; }
function ordenarPorPosicion(arr, rosterMap) {
  return [...arr].sort((a, b) => {
    const pa = posicionOrder(rosterMap.get(a.nombre));
    const pb = posicionOrder(rosterMap.get(b.nombre));
    if (pa !== pb) return pa - pb;
    return a.nombre.localeCompare(b.nombre);
  });
}

// ================= Microciclos: modelo =================
// Microciclo = { id, numero, inicio: iso|null, md2: iso|null, md1: iso|null }

function microRefDate(m) {
  const defined = FIELDS.map(f => m[f]).filter(Boolean).sort();
  return defined.length ? defined[0] : null;
}

function buildDateIndex(microciclos) {
  const map = new Map(); // dateKey -> { microId, tag, numero }
  microciclos.forEach(m => {
    FIELDS.forEach(f => {
      if (m[f]) {
        map.set(dateKey(new Date(m[f])), { microId: m.id, tag: f, numero: m.numero });
      }
    });
  });
  return map;
}

function orderedMicroList(microciclos) {
  return [...microciclos]
    .filter(m => microRefDate(m))
    .sort((a, b) => new Date(microRefDate(a)) - new Date(microRefDate(b)));
}

function statusFromDelta(d, ambarPct, rojoPct) {
  if (d === null || d === undefined) return "gray";
  if (d <= -rojoPct) return "red";
  if (d <= -ambarPct) return "amber";
  return "green";
}

function buildPlayers(rows, microciclos, ambarPct, rojoPct, individualizar, protocoloDesde) {
  const index = buildDateIndex(microciclos);
  const microList = orderedMicroList(microciclos);
  const byName = {};
  rows.forEach(r => {
    const hit = index.get(r.dateKey);
    const tagged = { ...r, tag: hit ? hit.tag : null, microId: hit ? hit.microId : null };
    (byName[r.nombre] = byName[r.nombre] || []).push(tagged);
  });

  const players = Object.entries(byName).map(([nombre, recs]) => {
    const sorted = [...recs].sort((a, b) => new Date(a.date) - new Date(b.date));
    const inicios = sorted.filter(r => r.tag === "inicio");
    // Si has marcado una fecha de cambio de protocolo (p. ej. de salto único a
    // "mejor de 3"), el perfil de ruido individual solo usa Inicios desde esa
    // fecha — así no se diluye con el ruido del protocolo anterior mientras se
    // acumula historial nuevo, y no hace falta esperar a que la ventana de 10
    // se "limpie" sola con el paso de las semanas.
    const iniciosParaUmbral = protocoloDesde
      ? inicios.filter(r => new Date(r.date) >= new Date(protocoloDesde))
      : inicios;

    // Perfil de ruido propio del jugador: a partir de sus propios Inicios de
    // microciclo (el punto más comparable entre semanas), calculamos su
    // variabilidad y la usamos como umbral ámbar personalizado — el rojo
    // mantiene la misma proporción que hayas fijado en los sliders generales.
    // Importante: NO medimos "cuánto se aleja cada dato de la media general",
    // porque eso confundiría una mejora progresiva real (un jugador que va a
    // más semana a semana) con irregularidad. En vez de eso medimos "cuánto
    // cambia de un Inicio al siguiente" (variabilidad sucesiva / error típico),
    // que cancela cualquier tendencia sostenida y solo capta el "bailoteo"
    // alrededor de ella. Solo se usan los últimos 10 Inicios (ya filtrados por
    // fecha de protocolo si la has marcado), para que el perfil se actualice
    // con el estado reciente del jugador y no quede anclado a datos de hace
    // meses. Con poco historial (menos de 4 inicios), se usa el umbral general
    // hasta que haya datos suficientes para confiar en él.
    const ratioGlobal = ambarPct > 0 ? rojoPct / ambarPct : 2;
    const umbral = {};
    METRIC_LIST.filter(m => m.drivesStatus).forEach(metric => {
      const valoresTodos = iniciosParaUmbral.map(r => metric.get(r)).filter(v => v != null);
      const valores = valoresTodos.slice(-10);
      if (individualizar && valores.length >= MIN_INICIOS_PARA_INDIVIDUALIZAR) {
        const diffs = valores.slice(1).map((v, i) => v - valores[i]);
        const sdDiffs = sdMuestral(diffs);
        const errorTipico = sdDiffs != null ? sdDiffs / Math.SQRT2 : null;
        const m_ = mean(valores);
        const cv = (errorTipico != null && m_) ? (errorTipico / m_) * 100 : null;
        const ambarI = clamp(cv, 3, 20);
        const rojoI = clamp(ambarI * ratioGlobal, ambarI + 1, 35);
        umbral[metric.key] = { ambarPct: ambarI, rojoPct: rojoI, cv, n: valores.length, personalizado: true };
      } else {
        umbral[metric.key] = { ambarPct, rojoPct, cv: null, n: valores.length, personalizado: false };
      }
    });

    const microDataMap = new Map();
    sorted.forEach(r => {
      if (r.microId == null) return;
      if (!microDataMap.has(r.microId)) microDataMap.set(r.microId, {});
      const b = microDataMap.get(r.microId);
      b[r.tag] = r;
    });

    const microResults = new Map();
    microDataMap.forEach((b, id) => {
      const metrics = {};
      let worstStatus = "gray", heightStatus = "gray";
      METRIC_LIST.forEach(metric => {
        const baseVal = b.inicio ? metric.get(b.inicio) : null;
        const md2Val = b.md2 ? metric.get(b.md2) : null;
        const md1Val = b.md1 ? metric.get(b.md1) : null;
        const md2Delta = (baseVal != null && md2Val != null) ? pct(md2Val, baseVal) : null;
        const md1Delta = (baseVal != null && md1Val != null) ? pct(md1Val, baseVal) : null;
        const u = umbral[metric.key] || { ambarPct, rojoPct };
        const md2Status = statusFromDelta(md2Delta, u.ambarPct, u.rojoPct);
        const md1Status = statusFromDelta(md1Delta, u.ambarPct, u.rojoPct);
        const mStatus = STATUS_ORDER[md2Status] <= STATUS_ORDER[md1Status] ? md2Status : md1Status;
        metrics[metric.key] = { base: baseVal, md2Delta, md1Delta, md2Status, md1Status, status: mStatus };
        if (metric.key === "altura") heightStatus = mStatus;
        if (metric.drivesStatus && STATUS_ORDER[mStatus] < STATUS_ORDER[worstStatus]) worstStatus = mStatus;
      });
      // "Divergencia": el estado combinado es peor que lo que diría la altura
      // por sí sola — es decir, potencia o fuerza están delatando fatiga que
      // la altura, saltando con otra estrategia, está enmascarando.
      const divergente = STATUS_ORDER[worstStatus] < STATUS_ORDER[heightStatus];
      microResults.set(id, { ...b, metrics, status: worstStatus, heightStatus, divergente });
    });

    // Chequeo de recuperación: el Inicio de cada microciclo se compara con el
    // MD+1 del microciclo ANTERIOR (¿se ha recuperado del último partido para
    // cuando arranca la semana?). Si esa semana no tuvo MD+1 (no se hizo test
    // ese día), no hay dato del partido con el que comparar — en vez de dejarlo
    // en blanco, se usa como respaldo la media de los Inicios anteriores de
    // ESTE jugador (hasta 10), dejando claro en el resultado (`modo`) que es
    // una comparación distinta, no el mismo chequeo de recuperación real.
    microList.forEach((meta, idx) => {
      const curr = microResults.get(meta.id);
      if (!curr || !curr.inicio || idx === 0) return;
      const prev = microResults.get(microList[idx - 1].id);
      const hayMd1Anterior = prev && prev.md1;
      const modo = hayMd1Anterior ? "md1_anterior" : "media_inicios";
      const iniciosPrevios = hayMd1Anterior ? [] : inicios.filter(r => new Date(r.date) < new Date(curr.inicio.date)).slice(-10);

      const recMetrics = {};
      let worst = "gray";
      METRIC_LIST.filter(m => m.drivesStatus).forEach(metric => {
        let baseVal;
        if (hayMd1Anterior) {
          baseVal = metric.get(prev.md1);
        } else {
          const valoresPrevios = iniciosPrevios.map(r => metric.get(r)).filter(v => v != null);
          baseVal = valoresPrevios.length >= MIN_INICIOS_PARA_RESPALDO_RECUPERACION ? mean(valoresPrevios) : null;
        }
        const nowVal = metric.get(curr.inicio);
        const delta = (baseVal != null && nowVal != null) ? pct(nowVal, baseVal) : null;
        const u = umbral[metric.key] || { ambarPct, rojoPct };
        const status = statusFromDelta(delta, u.ambarPct, u.rojoPct);
        recMetrics[metric.key] = { delta, status };
        if (STATUS_ORDER[status] < STATUS_ORDER[worst]) worst = status;
      });
      curr.recuperacion = { metrics: recMetrics, status: worst, modo, nPrevios: iniciosPrevios.length };
    });

    const orderedIds = microList.map(m => m.id);
    const lastActiveId = [...orderedIds].reverse().find(id => microResults.has(id) && microResults.get(id).status !== "gray");
    const lastId = lastActiveId ?? [...orderedIds].reverse().find(id => microResults.has(id));
    const lastMicro = lastId != null ? microResults.get(lastId) : null;

    const trendPoints = inicios.slice(-6);
    const trendPct = trendPoints.length >= 3 ? pct(trendPoints[trendPoints.length - 1].altura, trendPoints[0].altura) : null;

    return {
      nombre, equipo: sorted[sorted.length - 1].equipo, sorted, inicios,
      microResults, lastMicro, combinedStatus: lastMicro ? lastMicro.status : "gray",
      trendPct, nTests: sorted.length, umbral
    };
  });

  return { players: players.sort((a, b) => STATUS_ORDER[a.combinedStatus] - STATUS_ORDER[b.combinedStatus]), microList };
}

function findCurrentMicroId(microList) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const past = microList.filter(m => { const d = new Date(microRefDate(m)); d.setHours(0,0,0,0); return d <= today; });
  if (past.length === 0) return { id: null, mode: past.length === 0 && microList.length > 0 ? "solo-futuro" : "vacio" };
  // último microciclo pasado cuyo rango (hasta el siguiente inicio) cubre hoy, o si no, el último pasado
  return { id: past[past.length - 1].id, mode: "ok" };
}

function suggestNextNumero(microciclos) {
  const nums = microciclos.map(m => parseInt(m.numero, 10)).filter(n => Number.isFinite(n));
  if (nums.length === 0) return "1";
  return String(Math.max(...nums) + 1);
}

// ================= Backend API (Apps Script) =================
// Toda petición pasa por esta única función. El backend valida el token,
// y para el login/alta/recuperación de contraseña la comparación de hashes
// ocurre en el propio Apps Script (Code.gs), nunca en este archivo — así el
// hash de tu contraseña no es visible para quien abra la consola del navegador.
async function apiCall(action, body = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita el preflight CORS de Apps Script
    body: JSON.stringify({ action, token: API_TOKEN, ...body })
  });
  if (!res.ok) throw new Error("network");
  return res.json();
}

// ================= Storage helpers =================
// Mismo nombre y firma que antes (loadJSON/saveJSON) para no tener que tocar
// el resto de la app: solo cambia el transporte por debajo.
async function loadJSON(key, fallback) {
  try {
    const r = await apiCall("get", { key });
    return r.ok && r.value != null ? JSON.parse(r.value) : fallback;
  } catch { return fallback; }
}
async function saveJSON(key, value) {
  try {
    const r = await apiCall("set", { key, value: JSON.stringify(value) });
    return !!r.ok;
  } catch { return false; }
}

// ================= Auth (barrera de acceso) =================
// La contraseña se valida en el servidor (Apps Script): este archivo nunca
// ve ni calcula el hash. "Recordarme" es solo una comodidad de este
// dispositivo (localStorage) — no es en sí una capa de seguridad, la
// seguridad real es siempre la validación del backend en cada login.
const LS_REMEMBER = "cmj_recordarme_v1";

function AuthGate({ children }) {
  const [status, setStatus] = useState("loading"); // loading | setup | recovery-key | login | forgot | unlocked | error-init
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [claveGenerada, setClaveGenerada] = useState("");
  const [copiado, setCopiado] = useState(false);

  const [initError, setInitError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await apiCall("auth_status");
        if (!r.ok) { setInitError(JSON.stringify(r)); setStatus("error-init"); return; }
        if (!r.configurado) { setStatus("setup"); return; }
        const recordado = localStorage.getItem(LS_REMEMBER) === "1";
        setStatus(recordado ? "unlocked" : "login");
      } catch (err) {
        setInitError(String(err && err.message ? err.message : err));
        setStatus("error-init");
      }
    })();
  }, []);

  async function handleSetup(password) {
    setBusy(true); setError("");
    try {
      const r = await apiCall("setup", { password });
      if (!r.ok) { setError(r.error === "ya_configurado" ? "Ya existe una contraseña configurada. Recarga la página." : "No se pudo crear la contraseña."); setBusy(false); return; }
      setClaveGenerada(r.recoveryKey);
      setStatus("recovery-key");
    } catch { setError("No se pudo contactar con el backend. Comprueba la URL configurada y tu conexión."); }
    setBusy(false);
  }

  async function handleLogin(password, remember) {
    setBusy(true); setError("");
    try {
      const r = await apiCall("login", { password });
      if (!r.ok) { setError("Contraseña incorrecta."); setBusy(false); return; }
      if (remember) localStorage.setItem(LS_REMEMBER, "1");
      setStatus("unlocked");
    } catch { setError("No se pudo contactar con el backend. Comprueba tu conexión."); }
    setBusy(false);
  }

  async function handleForgot(claveRecuperacion, nuevaPassword) {
    setBusy(true); setError("");
    try {
      const r = await apiCall("forgot", { recoveryKey: claveRecuperacion.trim(), newPassword: nuevaPassword });
      if (!r.ok) { setError("Clave de recuperación incorrecta."); setBusy(false); return; }
      setStatus("login");
    } catch { setError("No se pudo contactar con el backend. Comprueba tu conexión."); }
    setBusy(false);
  }

  if (status === "loading") {
    return <div style={S.authScreen}><div style={S.authBox}>Cargando…</div></div>;
  }
  if (status === "error-init") {
    return <div style={S.authScreen}><div style={S.authBox}>
      No se pudo comprobar el acceso. Recarga la página. Si el problema persiste, revisa que API_URL/API_TOKEN estén bien configurados y que el Apps Script esté desplegado con acceso "Cualquier usuario".
      <div style={{ marginTop: 12, fontSize: 11, color: "#EF4444", wordBreak: "break-all" }}>Detalle técnico: {initError || "sin detalle"}</div>
    </div></div>;
  }
  if (status === "unlocked") return children;

  if (status === "setup") {
    return <AuthSetupForm onSubmit={handleSetup} error={error} busy={busy} />;
  }
  if (status === "recovery-key") {
    return (
      <div style={S.authScreen}>
        <div style={S.authBox}>
          <div style={S.authTitle}>Guarda tu clave de recuperación</div>
          <div style={S.authSub}>
            Esta clave es la única forma de recuperar el acceso si olvidas tu contraseña. Se muestra <b>una sola vez</b>: guárdala ahora en un lugar seguro (gestor de contraseñas, nota cifrada…). No podré volver a mostrártela.
          </div>
          <div style={S.authRecoveryKey}>{claveGenerada}</div>
          <button style={S.authBtnSecondary} onClick={async () => {
            try { await navigator.clipboard.writeText(claveGenerada); setCopiado(true); } catch {}
          }}>{copiado ? "Copiada ✓" : "Copiar clave"}</button>
          <button style={{ ...S.authBtn, marginTop: 14 }} onClick={() => setStatus("unlocked")}>
            Ya la he guardado, continuar
          </button>
        </div>
      </div>
    );
  }
  if (status === "login") {
    return <AuthLoginForm onSubmit={handleLogin} onForgot={() => { setError(""); setStatus("forgot"); }} error={error} busy={busy} />;
  }
  if (status === "forgot") {
    return <AuthForgotForm onSubmit={handleForgot} onBack={() => { setError(""); setStatus("login"); }} error={error} busy={busy} />;
  }
  return null;
}

function AuthSetupForm({ onSubmit, error, busy }) {
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [localError, setLocalError] = useState("");
  const submit = (e) => {
    e.preventDefault();
    if (p1.length < 6) { setLocalError("Usa al menos 6 caracteres."); return; }
    if (p1 !== p2) { setLocalError("Las dos contraseñas no coinciden."); return; }
    setLocalError("");
    onSubmit(p1);
  };
  return (
    <div style={S.authScreen}>
      <form style={S.authBox} onSubmit={submit}>
        <div style={S.authTitle}>Configura el acceso</div>
        <div style={S.authSub}>Es la primera vez que se abre este panel. Crea la contraseña de administrador; a partir de ahora se pedirá para entrar.</div>
        <input style={S.authInput} type="password" placeholder="Nueva contraseña (mín. 6 caracteres)" value={p1} onChange={e => setP1(e.target.value)} autoFocus />
        <input style={S.authInput} type="password" placeholder="Repite la contraseña" value={p2} onChange={e => setP2(e.target.value)} />
        {(localError || error) && <div style={S.authError}>{localError || error}</div>}
        <button style={S.authBtn} type="submit" disabled={busy}>{busy ? "Creando…" : "Crear contraseña"}</button>
      </form>
    </div>
  );
}

function AuthLoginForm({ onSubmit, onForgot, error, busy }) {
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const submit = (e) => { e.preventDefault(); if (password) onSubmit(password, remember); };
  return (
    <div style={S.authScreen}>
      <form style={S.authBox} onSubmit={submit}>
        <div style={S.authTitle}>Acceso restringido</div>
        <div style={S.authSub}>Introduce la contraseña de administrador para entrar al panel.</div>
        <input style={S.authInput} type="password" placeholder="Contraseña" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
        <label style={S.authRemember}>
          <input type="checkbox" style={S.checkbox} checked={remember} onChange={e => setRemember(e.target.checked)} />
          Recordarme en este dispositivo
        </label>
        {error && <div style={S.authError}>{error}</div>}
        <button style={S.authBtn} type="submit" disabled={busy}>{busy ? "Comprobando…" : "Entrar"}</button>
        <button type="button" style={S.authLink} onClick={onForgot}>¿Olvidaste tu contraseña?</button>
      </form>
    </div>
  );
}

function AuthForgotForm({ onSubmit, onBack, error, busy }) {
  const [clave, setClave] = useState("");
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [localError, setLocalError] = useState("");
  const submit = (e) => {
    e.preventDefault();
    if (p1.length < 6) { setLocalError("La nueva contraseña debe tener al menos 6 caracteres."); return; }
    if (p1 !== p2) { setLocalError("Las dos contraseñas no coinciden."); return; }
    setLocalError("");
    onSubmit(clave, p1);
  };
  return (
    <div style={S.authScreen}>
      <form style={S.authBox} onSubmit={submit}>
        <div style={S.authTitle}>Restablecer con clave de recuperación</div>
        <div style={S.authSub}>Introduce la clave de recuperación que se generó al crear la contraseña, y define una nueva.</div>
        <input style={{ ...S.authInput, fontFamily: mono, letterSpacing: 1 }} placeholder="XXXX-XXXX-XXXX-XXXX" value={clave} onChange={e => setClave(e.target.value)} autoFocus />
        <input style={S.authInput} type="password" placeholder="Nueva contraseña" value={p1} onChange={e => setP1(e.target.value)} />
        <input style={S.authInput} type="password" placeholder="Repite la nueva contraseña" value={p2} onChange={e => setP2(e.target.value)} />
        {(localError || error) && <div style={S.authError}>{localError || error}</div>}
        <button style={S.authBtn} type="submit" disabled={busy}>{busy ? "Restableciendo…" : "Restablecer contraseña"}</button>
        <button type="button" style={S.authLink} onClick={onBack}>Volver</button>
      </form>
    </div>
  );
}

// ================= Sparkline =================
function Sparkline({ points, width = 90, height = 28 }) {
  const valid = points.filter(p => p.value != null);
  if (valid.length === 0) return <span style={{ color: "#4A6680", fontSize: 11 }}>—</span>;
  const vals = valid.map(p => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const step = width / Math.max(points.length - 1, 1);
  const coords = points.map((p, i) => {
    const x = i * step;
    const y = p.value == null ? null : height - ((p.value - min) / range) * (height - 8) - 4;
    return { ...p, x, y };
  });
  const line = coords.filter(c => c.y != null).map(c => `${c.x},${c.y}`).join(" ");
  return (
    <svg width={width} height={height}>
      <polyline points={line} fill="none" stroke="#4A6680" strokeWidth="1.5" />
      {coords.map((c, i) => c.y != null && (
        <circle key={i} cx={c.x} cy={c.y} r={3.2} fill={TAG_META[c.tag]?.color || "#8BA4C0"} />
      ))}
    </svg>
  );
}

function Badge({ status }) {
  const m = STATUS_META[status];
  return <span style={{ padding: "3px 9px", borderRadius: 20, fontSize: 11.5, fontWeight: 600, color: m.color, background: m.bg }}>{m.label}</span>;
}

const AVATAR_COLORS = ["#1E6FD9", "#8B5CF6", "#F5C518"];
function avatarColor(texto) {
  let h = 0;
  for (let i = 0; i < texto.length; i++) h = (h * 31 + texto.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function iniciales(texto) {
  const partes = texto.trim().split(/\s+/);
  return ((partes[0]?.[0] || "") + (partes[1]?.[0] || "")).toUpperCase();
}
function Avatar({ texto, size = 38 }) {
  const bg = avatarColor(texto);
  const fg = bg === "#F5C518" ? "#060D1A" : "#F0F4FF";
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", background: bg, color: fg,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 700, fontSize: size * 0.4, flexShrink: 0
    }}>
      {iniciales(texto)}
    </div>
  );
}

// ================= App =================
export default function App() {
  return <AuthGate><AppContent /></AuthGate>;
}

function AppContent() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [microciclos, setMicrociclos] = useState([]);
  const [ambarPct, setAmbarPct] = useState(6);
  const [rojoPct, setRojoPct] = useState(12);
  const [individualizar, setIndividualizar] = useState(true);
  const [protocoloDesde, setProtocoloDesde] = useState("");
  const [tab, setTab] = useState("estado");
  const [selected, setSelected] = useState(null);
  const [uploadIssues, setUploadIssues] = useState(null);
  const [saveWarning, setSaveWarning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showThresholdInfo, setShowThresholdInfo] = useState(false);
  const [roster, setRoster] = useState([]);
  const [plantillas, setPlantillas] = useState([]);

  useEffect(() => {
    (async () => {
      const [r, m, t, ro, pl] = await Promise.all([
        loadJSON(K_DATASET, []), loadJSON(K_MICROCICLOS, []), loadJSON(K_THRESHOLDS, null), loadJSON(K_ROSTER, []), loadJSON(K_PLANTILLAS, [])
      ]);
      setRows(r); setMicrociclos(m);
      setRoster(ro.map(x => typeof x === "string" ? { nombre: x, posicion: null, plantillaId: null } : { plantillaId: null, ...x })); // migración de formato antiguo
      setPlantillas(pl);
      if (t) { setAmbarPct(t.ambarPct); setRojoPct(t.rojoPct); if (t.individualizar != null) setIndividualizar(t.individualizar); if (t.protocoloDesde) setProtocoloDesde(t.protocoloDesde); }
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (loading) return;
    saveJSON(K_THRESHOLDS, { ambarPct, rojoPct, individualizar, protocoloDesde });
  }, [ambarPct, rojoPct, individualizar, protocoloDesde, loading]);

  const handleFile = useCallback((e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const { rows: parsed, issues } = parseCSV(ev.target.result);
      setRows(parsed);
      setUploadIssues(issues);
      const ok = await saveJSON(K_DATASET, parsed);
      setSaveWarning(!ok);
    };
    reader.readAsText(file, "utf-8");
  }, []);

  const saveMicrociclo = useCallback(async (record) => {
    const next = record.id
      ? microciclos.map(m => m.id === record.id ? record : m)
      : [...microciclos, { ...record, id: `mc-${Date.now()}` }];
    setMicrociclos(next);
    const ok = await saveJSON(K_MICROCICLOS, next);
    setSaveWarning(!ok);
  }, [microciclos]);

  const deleteMicrociclo = useCallback(async (id) => {
    const next = microciclos.filter(m => m.id !== id);
    setMicrociclos(next);
    await saveJSON(K_MICROCICLOS, next);
  }, [microciclos]);

  const clearDataset = useCallback(async () => {
    setRows([]); setUploadIssues(null);
    await saveJSON(K_DATASET, []);
  }, []);

  const retrySave = useCallback(async () => {
    const results = await Promise.all([
      saveJSON(K_DATASET, rows), saveJSON(K_MICROCICLOS, microciclos),
      saveJSON(K_ROSTER, roster), saveJSON(K_THRESHOLDS, { ambarPct, rojoPct, individualizar, protocoloDesde })
    ]);
    setSaveWarning(results.some(ok => !ok));
  }, [rows, microciclos, roster, ambarPct, rojoPct, individualizar, protocoloDesde]);

  const toggleRoster = useCallback(async (nombre) => {
    const exists = roster.some(r => r.nombre === nombre);
    const next = exists ? roster.filter(r => r.nombre !== nombre) : [...roster, { nombre, posicion: null }];
    setRoster(next);
    await saveJSON(K_ROSTER, next);
  }, [roster]);

  const setRosterAll = useCallback(async (names) => {
    const existing = new Map(roster.map(r => [r.nombre, r]));
    const next = names.map(n => existing.get(n) || { nombre: n, posicion: null });
    setRoster(next);
    await saveJSON(K_ROSTER, next);
  }, [roster]);

  const setPosicion = useCallback(async (nombre, posicion) => {
    const exists = roster.some(r => r.nombre === nombre);
    const next = exists ? roster.map(r => r.nombre === nombre ? { ...r, posicion } : r) : [...roster, { nombre, posicion, plantillaId: null }];
    setRoster(next);
    await saveJSON(K_ROSTER, next);
  }, [roster]);

  const addManualPlayer = useCallback(async (nombre, posicion, plantillaId) => {
    const clean = nombre.trim();
    if (!clean || roster.some(r => r.nombre === clean)) return;
    const next = [...roster, { nombre: clean, posicion, plantillaId: plantillaId ?? null }];
    setRoster(next);
    await saveJSON(K_ROSTER, next);
  }, [roster]);

  const setPlantillaDeJugador = useCallback(async (nombre, plantillaId) => {
    const exists = roster.some(r => r.nombre === nombre);
    const next = exists
      ? roster.map(r => r.nombre === nombre ? { ...r, plantillaId } : r)
      : [...roster, { nombre, posicion: null, plantillaId }];
    setRoster(next);
    await saveJSON(K_ROSTER, next);
  }, [roster]);

  const quitarDePlantilla = useCallback(async (nombre) => {
    const next = roster.map(r => r.nombre === nombre ? { ...r, plantillaId: null } : r);
    setRoster(next);
    await saveJSON(K_ROSTER, next);
  }, [roster]);

  const crearPlantilla = useCallback(async (nombre) => {
    const clean = nombre.trim();
    if (!clean) return null;
    const nueva = { id: `pl-${Date.now()}`, nombre: clean };
    const next = [...plantillas, nueva];
    setPlantillas(next);
    await saveJSON(K_PLANTILLAS, next);
    return nueva.id;
  }, [plantillas]);

  const renombrarPlantilla = useCallback(async (id, nombre) => {
    const next = plantillas.map(p => p.id === id ? { ...p, nombre } : p);
    setPlantillas(next);
    await saveJSON(K_PLANTILLAS, next);
  }, [plantillas]);

  const eliminarPlantilla = useCallback(async (id) => {
    const nextPlantillas = plantillas.filter(p => p.id !== id);
    const nextRoster = roster.map(r => r.plantillaId === id ? { ...r, plantillaId: null } : r);
    setPlantillas(nextPlantillas);
    setRoster(nextRoster);
    await Promise.all([saveJSON(K_PLANTILLAS, nextPlantillas), saveJSON(K_ROSTER, nextRoster)]);
  }, [plantillas, roster]);

  const { players: allPlayers, microList } = useMemo(
    () => buildPlayers(rows, microciclos, ambarPct, rojoPct, individualizar, protocoloDesde),
    [rows, microciclos, ambarPct, rojoPct, individualizar, protocoloDesde]
  );

  const allNames = useMemo(() => Array.from(new Set(rows.map(r => r.nombre))).sort(), [rows]);
  const rosterNames = useMemo(() => new Set(roster.map(r => r.nombre)), [roster]);
  const players = useMemo(
    () => roster.length === 0 ? allPlayers : allPlayers.filter(p => rosterNames.has(p.nombre)),
    [allPlayers, roster, rosterNames]
  );

  const current = useMemo(() => findCurrentMicroId(microList), [microList]);
  const selectedPlayer = players.find(p => p.nombre === selected) || null;

  if (loading) {
    return <div style={{ ...S.page, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#8BA4C0", fontSize: 13 }}>Cargando panel…</div>
    </div>;
  }

  return (
    <div style={S.page}>
      <style>{`
        @media (prefers-reduced-motion: reduce) { * { transition:none!important; animation:none!important; } }
        input:focus-visible, button:focus-visible, select:focus-visible, .row:focus-visible { outline:2px solid #F5C518; outline-offset:2px; }
      `}</style>

      <div style={S.shell}>
        <nav style={S.sidebar}>
          <div style={S.brand}>
            <div style={S.brandMark}>CMJ</div>
            <div style={S.brandTitle}>PANEL DE FATIGA</div>
          </div>
          {[
            ["jugadores", "Jugadores"],
            ["microciclos", "Microciclos"],
            ["estado", "Estado actual"],
            ["historial", "Historial"],
            ["ranking", "Ranking"],
            ["carga", "CSV"]
          ].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              style={{ ...S.navBtn, ...(tab === key ? S.navBtnActive : {}) }}>
              {label}
            </button>
          ))}
          <button style={S.settingsBtn} onClick={() => setShowSettings(s => !s)}>Ajustes de umbral</button>
          {showSettings && (
            <div style={S.settingsPanel}>
              <label style={S.threshLabel}>Ámbar ≤ −{ambarPct}% (umbral general)
                <input type="range" min="3" max="15" value={ambarPct} onChange={e => setAmbarPct(Number(e.target.value))} />
              </label>
              <label style={S.threshLabel}>Rojo ≤ −{rojoPct}% (umbral general)
                <input type="range" min="8" max="25" value={rojoPct} onChange={e => setRojoPct(Number(e.target.value))} />
              </label>
              <label style={S.checkboxLabel}>
                <input type="checkbox" style={S.checkbox} checked={individualizar} onChange={e => setIndividualizar(e.target.checked)} />
                Umbral individualizado por jugador
              </label>
              {individualizar && (
                <label style={S.threshLabel}>
                  Cambié de protocolo de salto el
                  <input type="date" style={{ ...S.dateInput, marginTop: 4 }} value={protocoloDesde}
                    onChange={e => setProtocoloDesde(e.target.value)} />
                  {protocoloDesde && (
                    <button style={{ ...S.infoBtn, marginTop: 6 }} onClick={() => setProtocoloDesde("")}>Quitar fecha</button>
                  )}
                </label>
              )}
              <button style={S.infoBtn} onClick={() => setShowThresholdInfo(s => !s)}>
                {showThresholdInfo ? "Ocultar" : "Ver"} qué significan estos umbrales
              </button>
              {showThresholdInfo && (
                <div style={S.thresholdRef}>
                  <b>¿De dónde salen estos valores?</b><br/>
                  Con un salto único por jugador y día (protocolo estándar de este panel) el ruido normal
                  de sesión a sesión de la altura de CMJ en deportistas entrenados suele estar entre el 3%
                  y el 8%. Por eso el ámbar general empieza en 6% y el rojo en 12% — una aproximación al
                  "cambio mínimo detectable" (≈0,2 × la desviación estándar entre sesiones) para toda la
                  plantilla por igual.<br/><br/>
                  Con "umbral individualizado" activo, cada jugador con <b>4 o más Inicios de microciclo</b> registrados
                  usa su propia variabilidad histórica en vez del 6%/12% general — algunos jugadores saltan
                  de forma más constante que otros, y esto evita tratarlos a todos con la misma vara de medir.
                  Esa variabilidad se calcula mirando cuánto cambia de un Inicio al siguiente (no cuánto se
                  aleja de la media general), para no confundir una mejora progresiva real con irregularidad,
                  y solo con los últimos 10 Inicios, para que se actualice con el estado reciente del jugador.
                  El día de referencia para decidir sigue siendo siempre el mismo (MD-2/MD+1 de esta semana);
                  lo único que cambia es cuánta caída se considera "normal" para ESE jugador en concreto.
                  Se ve marcado como "personalizado" en la ficha de cada uno.<br/><br/>
                  Si cambias de protocolo de medición (por ejemplo, de salto único a "mejor de 3"), marca la
                  fecha del cambio arriba: el cálculo de variabilidad ignorará todo lo anterior a esa fecha,
                  así no mezcla el ruido del protocolo antiguo con el nuevo mientras se acumula historial.
                </div>
              )}
            </div>
          )}
          <div style={S.sidebarFooter}>
            {players.length} jugadores{roster.length > 0 ? ` de ${allNames.length}` : ""} · {rows.length} tests<br/>
            {microList.length} microciclos guardados<br/>
            {saveWarning && <><span style={{ color: "#F5C518" }}>Cambios no guardados</span> <button style={S.retryBtn} onClick={retrySave}>Reintentar guardado</button></>}
          </div>
        </nav>

        <main style={S.main}>
          {tab === "estado" && (
            <EstadoActual players={players} microList={microList} current={current}
              selected={selected} setSelected={setSelected} selectedPlayer={selectedPlayer}
              rosterActive={roster.length > 0} totalNames={allNames.length}
              ambarPct={ambarPct} rojoPct={rojoPct} roster={roster} />
          )}
          {tab === "microciclos" && (
            <Microciclos microciclos={microciclos} onSave={saveMicrociclo} onDelete={deleteMicrociclo} currentId={current.id} />
          )}
          {tab === "historial" && (
            <Historial players={players} microList={microList}
              selected={selected} setSelected={setSelected} selectedPlayer={selectedPlayer}
              ambarPct={ambarPct} rojoPct={rojoPct} roster={roster} />
          )}
          {tab === "carga" && (
            <CargadorCSV onFile={handleFile} issues={uploadIssues} rows={rows} onClear={clearDataset} />
          )}
          {tab === "jugadores" && (
            <Jugadores allNames={allNames} roster={roster} onToggle={toggleRoster} onSetAll={setRosterAll}
              onSetPosicion={setPosicion} onAddManual={addManualPlayer}
              plantillas={plantillas} onCrearPlantilla={crearPlantilla} onRenombrarPlantilla={renombrarPlantilla}
              onEliminarPlantilla={eliminarPlantilla} onSetPlantillaDeJugador={setPlantillaDeJugador} onQuitarDePlantilla={quitarDePlantilla}
              allPlayers={allPlayers} microList={microList} ambarPct={ambarPct} rojoPct={rojoPct} />
          )}
          {tab === "ranking" && (
            <Ranking players={players} roster={roster} microList={microList} />
          )}
        </main>
      </div>
    </div>
  );
}

// ================= Tab: Estado actual =================
// Desplegable de filtro multi-selección: botón con resumen ("Todos" / "3 de 7")
// que despliega una lista de checkboxes justo debajo, en línea con el resto
// de desplegables de la app (sin overlays flotantes).
function FiltroDropdown({ label, options, selected, onToggle, onAll, onNone }) {
  const [open, setOpen] = useState(false);
  const total = options.length;
  const resumen = selected.size === total ? "Todos" : selected.size === 0 ? "Ninguno" : `${selected.size} de ${total}`;
  return (
    <div style={S.filtroDropdown}>
      <button style={S.filtroDropdownBtn} onClick={() => setOpen(o => !o)}>
        <span>{label}: <b style={{ color: "#F0F4FF" }}>{resumen}</b></span>
        <span style={{ color: "#8BA4C0" }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div style={S.filtroDropdownPanel}>
          <div style={S.filtroDropdownActions}>
            <button style={S.filtroDropdownActionBtn} onClick={onAll}>Todos</button>
            <button style={S.filtroDropdownActionBtn} onClick={onNone}>Ninguno</button>
          </div>
          {options.map(o => (
            <label key={o.key} style={S.filtroDropdownItem}>
              <input type="checkbox" style={S.checkbox} checked={selected.has(o.key)} onChange={() => onToggle(o.key)} />
              <span style={{ color: o.color || "#DCE3EC" }}>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function EstadoActual({ players, microList, current, selected, setSelected, selectedPlayer, rosterActive, totalNames, ambarPct, rojoPct, roster }) {
  const rosterMap = useMemo(() => new Map(roster.map(r => [r.nombre, r.posicion])), [roster]);
  const showRosterHint = !rosterActive && totalNames > 25;
  const [expandedMetrics, setExpandedMetrics] = useState(() => new Set());
  const toggleMetric = (key) => setExpandedMetrics(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const [expandedCards, setExpandedCards] = useState(() => new Set());
  const toggleCard = (nombre) => setExpandedCards(prev => {
    const next = new Set(prev);
    next.has(nombre) ? next.delete(nombre) : next.add(nombre);
    return next;
  });
  const [filtroEstado, setFiltroEstado] = useState(() => new Set(["red", "amber", "green", "gray"]));
  const toggleFiltroEstado = (s) => setFiltroEstado(prev => {
    const next = new Set(prev);
    next.has(s) ? next.delete(s) : next.add(s);
    return next;
  });
  const [filtroPosicion, setFiltroPosicion] = useState(() => new Set([...POSICIONES.map(p => p.key), "sin"]));
  const toggleFiltroPosicion = (k) => setFiltroPosicion(prev => {
    const next = new Set(prev);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });
  if (microList.length === 0) {
    return <EmptyPanel title="Sin microciclos definidos"
      body="Ve a la pestaña Microciclos y crea al menos uno (Inicio, MD-2, MD+1) para poder ver el estado semanal." />;
  }

  if (current.id == null) {
    const next = microList[0];
    return <EmptyPanel title="El primer microciclo programado aún no ha empezado"
      body={`Microciclo Nº ${next.numero} · inicio previsto ${fmtDate(microRefDate(next))}. En cuanto se registren tests para esa fecha, aparecerán aquí.`} />;
  }

  const meta = microList.find(m => m.id === current.id);
  const todayKey = dateKey(new Date());
  const todayTag = FIELDS.find(f => meta[f] && dateKey(new Date(meta[f])) === todayKey) || null;

  function hoyDe(p) {
    const m = p.microResults.get(current.id);
    if (!todayTag) {
      const dayField = m?.md1 ? "md1" : m?.md2 ? "md2" : null;
      if (!dayField) return { mode: "context", status: "gray", motivo: "Sin tests registrados en este microciclo todavía.", rows: [], m, nivel: null };
      const d = motivoDia(m, dayField, p.umbral);
      return { mode: "context", status: d.status, motivo: `Última lectura (${TAG_META[dayField].label}): ${d.motivo}`, rows: filasDia(m, dayField, p.umbral), m, nivel: d.nivel };
    }
    if (todayTag === "inicio") {
      if (!m || !m.inicio) return { mode: "pending", status: "gray", motivo: "Test de inicio de hoy aún no registrado.", rows: [], m, nivel: null };
      const r = motivoRecuperacion(m.recuperacion, p.umbral);
      return { mode: "inicio", status: r.status, motivo: r.motivo, rows: filasRecuperacion(m.recuperacion, p.umbral), m, nivel: r.nivel };
    }
    if (!m || !m[todayTag]) return { mode: "pending", status: "gray", motivo: `Test de hoy (${TAG_META[todayTag].label}) aún no registrado.`, rows: [], m, nivel: null };
    const d = motivoDia(m, todayTag, p.umbral);
    return { mode: todayTag, status: d.status, motivo: d.motivo, rows: filasDia(m, todayTag, p.umbral), m, nivel: d.nivel };
  }


  const porPosicion = new Map(POSICIONES.map(p => [p.key, []]));
  porPosicion.set(null, []);
  players.forEach(p => {
    const pos = rosterMap.get(p.nombre) || null;
    const posKeyFiltro = pos || "sin";
    if (!filtroEstado.has(hoyDe(p).status)) return;
    if (!filtroPosicion.has(posKeyFiltro)) return;
    (porPosicion.has(pos) ? porPosicion.get(pos) : porPosicion.get(null)).push(p);
  });
  porPosicion.forEach((list, key) => porPosicion.set(key, [...list].sort((a, b) => a.nombre.localeCompare(b.nombre))));
  const totalFiltrados = [...porPosicion.values()].reduce((s, l) => s + l.length, 0);

  return (
    <div>
      <PageTitle title="Estado actual"
        sub={`Microciclo Nº ${meta.numero} · inicio ${fmtDate(microRefDate(meta))} · ${todayTag ? `hoy: ${TAG_META[todayTag]?.label || "Inicio microciclo"}` : "hoy no hay test programado — última lectura de la semana"}`} />

      {showRosterHint && (
        <div style={S.hintBanner}>
          Este CSV trae {totalNames} jugadores y aún no has filtrado tu plantilla — ve a "Jugadores" para marcar solo los tuyos.
        </div>
      )}

      <div style={S.filterBar}>
        <FiltroDropdown
          label="Estado"
          options={["red", "amber", "green", "gray"].map(s => ({ key: s, label: STATUS_META[s].label, color: STATUS_META[s].color }))}
          selected={filtroEstado}
          onToggle={toggleFiltroEstado}
          onAll={() => setFiltroEstado(new Set(["red", "amber", "green", "gray"]))}
          onNone={() => setFiltroEstado(new Set())}
        />
        <FiltroDropdown
          label="Posición"
          options={[...POSICIONES.map(p => ({ key: p.key, label: p.label })), { key: "sin", label: "Sin posición" }]}
          selected={filtroPosicion}
          onToggle={toggleFiltroPosicion}
          onAll={() => setFiltroPosicion(new Set([...POSICIONES.map(p => p.key), "sin"]))}
          onNone={() => setFiltroPosicion(new Set())}
        />
      </div>

      {totalFiltrados === 0 && <div style={S.emptySmall}>Ningún jugador coincide con el filtro seleccionado.</div>}

      {[...POSICIONES.map(p => p.key), null].map(posKey => {
        const list = porPosicion.get(posKey) || [];
        if (list.length === 0) return null;
        const label = posKey ? POSICIONES.find(p => p.key === posKey).label : "Sin posición";
        return (
          <section key={posKey ?? "sin"} style={S.groupSection}>
            <div style={S.groupHeader}>
              <span style={S.posSectionTitle}>{label}</span>
              <span style={S.groupCount}>{list.length}</span>
            </div>
            <div style={S.cardGrid}>
              {list.map(p => {
                const hoy = hoyDe(p);
                const m = hoy.m;
                const cardOpen = expandedCards.has(p.nombre);
                return (
                  <div key={p.nombre} className="row" tabIndex={0}
                    style={{ ...S.playerCard, ...S.playerCardByStatus[hoy.status] }}
                    onClick={() => toggleCard(p.nombre)}>
                    <div style={S.playerCardName}>
                      <span onClick={e => { e.stopPropagation(); setSelected(p.nombre); }} style={S.playerCardNameLink} title={p.nombre}>{p.nombre}</span>
                      {hoy.nivel && <span style={S.nivelSep}>|</span>}
                      {hoy.nivel && <span style={{ ...S.nivelTag, color: STATUS_META[hoy.status].color }}>{hoy.nivel}</span>}
                      {m?.divergente && (
                        <span onClick={e => { e.stopPropagation(); toggleMetric(`${p.nombre}::divergencia`); }} style={S.divergeDot}>⚠</span>
                      )}
                    </div>
                    {m?.divergente && expandedMetrics.has(`${p.nombre}::divergencia`) && (
                      <div style={S.explainRow}>
                        <b>Divergencia:</b> la altura no muestra fatiga, pero potencia y/o fuerza sí caen — es señal de que está cambiando de estrategia de salto para compensar. Fíjate especialmente en esas dos variables, no solo en la altura.
                      </div>
                    )}

                    {hoy.rows.length > 0 ? (
                      <div style={S.metricRows}>
                        {hoy.rows.map(row => {
                          const mkey = `${p.nombre}::${row.key}`;
                          const mOpen = expandedMetrics.has(mkey);
                          return (
                            <div key={row.key}>
                              <div className="row" tabIndex={0} onClick={e => { e.stopPropagation(); toggleMetric(mkey); }} style={S.metricRow}>
                                <span style={S.metricRowLabel}>{mOpen ? "▾" : "▸"} {row.label}</span>
                                <span style={{ ...S.metricRowValue, color: STATUS_META[row.status].color }}>{signed(row.delta)}</span>
                              </div>
                              {mOpen && <div style={S.explainRow}>{row.explicacion}</div>}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={S.metricRowsEmpty}>Sin valores todavía</div>
                    )}

                    {hoy.motivo && (
                      <>
                        <div style={S.expandHint}>{cardOpen ? "▾ ocultar recomendación" : "▸ ver recomendación"}</div>
                        {cardOpen && <div style={S.motivoRow}>{hoy.motivo}</div>}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {selectedPlayer && <PlayerDetail player={selectedPlayer} microList={microList} posicion={rosterMap.get(selectedPlayer.nombre)} />}
    </div>
  );
}

// ================= Tab: Microciclos =================
const emptyForm = { id: null, numero: "", inicio: "", md2: "", md1: "" };

function Microciclos({ microciclos, onSave, onDelete, currentId }) {
  const [form, setForm] = useState(emptyForm);
  const isEditing = form.id != null;

  const startNew = () => setForm({ ...emptyForm, numero: suggestNextNumero(microciclos) });
  const startEdit = (m) => setForm({
    id: m.id, numero: m.numero,
    inicio: m.inicio ? m.inicio.slice(0, 10) : "",
    md2: m.md2 ? m.md2.slice(0, 10) : "",
    md1: m.md1 ? m.md1.slice(0, 10) : ""
  });

  const handleSave = () => {
    if (!form.numero.trim()) return;
    const toIso = (s) => s ? new Date(s + "T00:00:00").toISOString() : null;
    onSave({
      id: form.id,
      numero: form.numero.trim(),
      inicio: toIso(form.inicio),
      md2: toIso(form.md2),
      md1: toIso(form.md1)
    });
    setForm(emptyForm.numero === form.numero ? { ...emptyForm, numero: suggestNextNumero(microciclos) } : emptyForm);
  };

  const sorted = orderedMicroList(microciclos);
  const today = new Date(); today.setHours(0,0,0,0);

  return (
    <div>
      <PageTitle title="Microciclos" sub="Crea el microciclo completo (número + fechas) y guárdalo. Puedes programar fechas futuras y editar o borrar cualquiera después." />

      <div style={S.microForm}>
        <div style={S.microFormTitle}>{isEditing ? `Editando microciclo Nº ${form.numero}` : "Nuevo microciclo"}</div>
        <div style={S.formRow}>
          <div style={S.formField}>
            <label style={S.fieldLabel}>Número de microciclo</label>
            <input style={S.numInput} value={form.numero}
              placeholder="ej. 12"
              onChange={e => setForm({ ...form, numero: e.target.value })} />
          </div>
          <div style={S.formField}>
            <label style={{ ...S.fieldLabel, color: TAG_META.inicio.color }}>Inicio microciclo</label>
            <input type="date" style={S.dateInput} value={form.inicio}
              onChange={e => setForm({ ...form, inicio: e.target.value })} />
          </div>
          <div style={S.formField}>
            <label style={{ ...S.fieldLabel, color: TAG_META.md2.color }}>MD-2</label>
            <input type="date" style={S.dateInput} value={form.md2}
              onChange={e => setForm({ ...form, md2: e.target.value })} />
          </div>
          <div style={S.formField}>
            <label style={{ ...S.fieldLabel, color: TAG_META.md1.color }}>MD+1</label>
            <input type="date" style={S.dateInput} value={form.md1}
              onChange={e => setForm({ ...form, md1: e.target.value })} />
          </div>
        </div>
        <div style={S.formActions}>
          <button style={S.applyBtn} onClick={handleSave} disabled={!form.numero.trim()}>
            {isEditing ? "Guardar cambios" : "Guardar microciclo"}
          </button>
          {isEditing && <button style={S.cancelBtn} onClick={() => setForm(emptyForm)}>Cancelar edición</button>}
        </div>
      </div>

      <div style={S.microTitle}>Microciclos registrados</div>
      {sorted.length === 0 && <div style={S.emptySmall}>Aún no hay ninguno guardado.</div>}

      <table style={S.table}>
        <thead>
          <tr style={S.trHead}>
            <th style={S.th}>Nº</th>
            <th style={S.th}>Inicio</th>
            <th style={S.th}>MD-2</th>
            <th style={S.th}>MD+1</th>
            <th style={S.th}>Estado</th>
            <th style={S.th}></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(m => {
            const ref = new Date(microRefDate(m)); ref.setHours(0,0,0,0);
            const when = m.id === currentId ? "Actual" : ref > today ? "Futuro" : "Pasado";
            const whenColor = when === "Actual" ? "#F5C518" : when === "Futuro" ? "#1E6FD9" : "#8BA4C0";
            return (
              <tr key={m.id} style={S.tr}>
                <td style={{ ...S.td, fontFamily: "monospace", fontWeight: 700 }}>{m.numero}</td>
                <td style={S.td}>{m.inicio ? fmtDate(m.inicio) : "—"}</td>
                <td style={S.td}>{m.md2 ? fmtDate(m.md2) : "—"}</td>
                <td style={S.td}>{m.md1 ? fmtDate(m.md1) : "—"}</td>
                <td style={S.td}><span style={{ color: whenColor, fontSize: 12, fontWeight: 600 }}>{when}</span></td>
                <td style={{ ...S.td, textAlign: "right" }}>
                  <button style={S.linkBtn} onClick={() => startEdit(m)}>Editar</button>
                  <button style={S.linkBtnDanger} onClick={() => onDelete(m.id)}>Eliminar</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ================= Tab: Historial =================
function Historial({ players, microList, selected, setSelected, selectedPlayer, ambarPct, rojoPct, roster }) {
  const rosterMap = useMemo(() => new Map(roster.map(r => [r.nombre, r.posicion])), [roster]);
  const playersOrdenados = useMemo(() => ordenarPorPosicion(players, rosterMap), [players, rosterMap]);

  const grupos = new Map(POSICIONES.map(p => [p.key, []]));
  grupos.set("sin", []);
  playersOrdenados.forEach(p => {
    const pos = rosterMap.get(p.nombre) || "sin";
    (grupos.has(pos) ? grupos.get(pos) : grupos.get("sin")).push(p);
  });

  return (
    <div>
      <PageTitle title="Historial" sub="Elige un jugador para ver su evolución completa: variables, periodo y microciclos concretos." />

      <select style={{ ...S.select, width: "100%", maxWidth: 360, marginBottom: 18 }}
        value={selected || ""} onChange={e => setSelected(e.target.value || null)}>
        <option value="">— Selecciona un jugador —</option>
        {[...POSICIONES.map(p => p.key), "sin"].map(key => {
          const list = grupos.get(key) || [];
          if (list.length === 0) return null;
          const label = key === "sin" ? "Sin posición" : POSICIONES.find(p => p.key === key).label;
          return (
            <optgroup key={key} label={label}>
              {list.map(p => (
                <option key={p.nombre} value={p.nombre}>{p.nombre}</option>
              ))}
            </optgroup>
          );
        })}
      </select>

      {!selectedPlayer && <div style={S.emptySmall}>Selecciona un jugador arriba para ver su evolución.</div>}
      {selectedPlayer && <PlayerDetail player={selectedPlayer} microList={microList} posicion={rosterMap.get(selectedPlayer.nombre)} />}
    </div>
  );
}

// ================= Tab: Ranking =================
function Ranking({ players, roster, microList }) {
  const [metricKey, setMetricKey] = useState("altura");
  const [periodo, setPeriodo] = useState("historico"); // 'historico' | 'microciclo' | 'rango'
  const [microSel, setMicroSel] = useState(() => microList.length ? microList[microList.length - 1].id : null);
  const [rango, setRango] = useState({ start: "", end: "" });
  const [filtroTags, setFiltroTags] = useState(() => new Set(["inicio", "md2", "md1", "sin"]));
  const toggleTag = (k) => setFiltroTags(prev => {
    const next = new Set(prev);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });
  const [filtroPosicion, setFiltroPosicion] = useState(() => new Set([...POSICIONES.map(p => p.key), "sin"]));
  const toggleFiltroPosicion = (k) => setFiltroPosicion(prev => {
    const next = new Set(prev);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });

  const rosterMap = useMemo(() => new Map(roster.map(r => [r.nombre, r.posicion])), [roster]);
  const metric = METRICS[metricKey];

  const candidatosDe = (p) => {
    if (periodo === "microciclo") {
      const m = p.microResults.get(microSel);
      if (!m) return [];
      return ["inicio", "md2", "md1"].filter(k => m[k] && filtroTags.has(k)).map(k => m[k]);
    }
    const dentroDeRango = (r) => {
      if (periodo !== "rango" || !rango.start || !rango.end) return periodo !== "rango";
      const t = new Date(r.date).getTime();
      return t >= new Date(rango.start).getTime() && t <= new Date(rango.end).getTime();
    };
    return p.sorted.filter(r => filtroTags.has(r.tag || "sin") && dentroDeRango(r));
  };

  const filaDe = (p) => {
    const candidatos = candidatosDe(p)
      .map(r => ({ r, v: metric.get(r) }))
      .filter(c => c.v != null);
    if (candidatos.length === 0) return null;
    const mejor = candidatos.reduce((a, b) => (b.v > a.v ? b : a));
    return { player: p, valor: mejor.v, fecha: mejor.r.date, tag: mejor.r.tag };
  };

  const filas = players
    .filter(p => filtroPosicion.has(rosterMap.get(p.nombre) || "sin"))
    .map(filaDe)
    .filter(Boolean)
    .sort((a, b) => b.valor - a.valor);

  const sinDatos = players.filter(p => filtroPosicion.has(rosterMap.get(p.nombre) || "sin") && !filaDe(p));

  const RANK_COLOR = { 0: "#F5C518", 1: "#C8CDD6", 2: "#C98A4B" };
  const RANK_ROW_BG = { 0: "rgba(245,197,24,0.10)", 1: "rgba(200,205,214,0.08)", 2: "rgba(201,138,75,0.08)" };
  const RANK_ROW_BORDER = { 0: "#F5C518", 1: "#C8CDD6", 2: "#C98A4B" };
  const esReciente = (fecha) => (Date.now() - new Date(fecha).getTime()) / 86400000 <= 14;

  const [showFiltros, setShowFiltros] = useState(false);
  const [showRankingInfo, setShowRankingInfo] = useState(false);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="row" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => setShowFiltros(s => !s)}>
          <PageTitle title={`Ranking ${showFiltros ? "▾" : "▸"}`} />
        </div>
        <button
          style={{ ...S.infoIconBtn, marginBottom: 18 }}
          onClick={(e) => { e.stopPropagation(); setShowRankingInfo(s => !s); }}
          title="Información sobre el ranking"
        >ℹ️</button>
      </div>

      {showRankingInfo && (
        <div style={{ ...S.umbralNote, marginTop: -10 }}>
          Mejor marca de cada jugador en la variable y el periodo que elijas. El podio (1º-3º) se resalta en dorado/plata/bronce; ▲ reciente indica que la marca es de los últimos 14 días. Toca el título para ver los filtros.
        </div>
      )}

      {showFiltros && (
      <>
      <div style={S.subTabs}>
        {METRIC_LIST.map(m => (
          <button key={m.key} style={{ ...S.tabBtn, ...(metricKey === m.key ? { ...S.tabBtnActive, color: METRIC_CHART_COLOR[m.key], borderColor: METRIC_CHART_COLOR[m.key] } : {}) }}
            onClick={() => setMetricKey(m.key)}>
            {m.label}
          </button>
        ))}
      </div>

      <div style={S.subTabs}>
        <button style={{ ...S.tabBtn, ...(periodo === "historico" ? S.tabBtnActive : {}) }} onClick={() => setPeriodo("historico")}>Histórico completo</button>
        <button style={{ ...S.tabBtn, ...(periodo === "microciclo" ? S.tabBtnActive : {}) }} onClick={() => setPeriodo("microciclo")}>Microciclo concreto</button>
        <button style={{ ...S.tabBtn, ...(periodo === "rango" ? S.tabBtnActive : {}) }} onClick={() => setPeriodo("rango")}>Rango de fechas</button>
      </div>

      <div style={S.chartControls}>
        <div style={S.controlsRow}>
          <span style={S.controlsLabel}>Momento</span>
          <FiltroDropdown
            label="Momento"
            options={[
              { key: "inicio", label: "Inicio", color: TAG_META.inicio.color },
              { key: "md2", label: "MD-2", color: TAG_META.md2.color },
              { key: "md1", label: "MD+1", color: TAG_META.md1.color },
              { key: "sin", label: "Sin etiqueta", color: "#4A6680" }
            ]}
            selected={filtroTags} onToggle={toggleTag}
            onAll={() => setFiltroTags(new Set(["inicio", "md2", "md1", "sin"]))}
            onNone={() => setFiltroTags(new Set())}
          />
        </div>
        <div style={S.controlsRow}>
          <span style={S.controlsLabel}>Posición</span>
          <FiltroDropdown
            label="Posición"
            options={[...POSICIONES.map(p => ({ key: p.key, label: p.label })), { key: "sin", label: "Sin posición" }]}
            selected={filtroPosicion} onToggle={toggleFiltroPosicion}
            onAll={() => setFiltroPosicion(new Set([...POSICIONES.map(p => p.key), "sin"]))}
            onNone={() => setFiltroPosicion(new Set())}
          />
        </div>
        {periodo === "microciclo" && microList.length > 0 && (
          <div style={S.controlsRow}>
            <span style={S.controlsLabel}>Microciclo</span>
            <select style={S.select} value={microSel || ""} onChange={e => setMicroSel(e.target.value)}>
              {microList.map(m => <option key={m.id} value={m.id}>Nº {m.numero}</option>)}
            </select>
          </div>
        )}
        {periodo === "rango" && (
          <div style={S.controlsRow}>
            <span style={S.controlsLabel}>Fechas</span>
            <div style={{ display: "flex", gap: 14 }}>
              <input type="date" style={S.dateInput} value={rango.start} onChange={e => setRango({ ...rango, start: e.target.value })} />
              <input type="date" style={S.dateInput} value={rango.end} onChange={e => setRango({ ...rango, end: e.target.value })} />
            </div>
          </div>
        )}
      </div>
      </>
      )}

      {filas.length === 0 ? (
        <EmptyPanel title="Sin datos para este filtro" body="Prueba a ampliar el momento, la posición o el periodo seleccionados." />
      ) : (
        <table style={S.table}>
          <thead>
            <tr style={S.trHead}>
              <th style={S.th}>Nº</th>
              <th style={S.th}>Jugador</th>
              <th style={S.th}>Posición</th>
              <th style={S.thNum}>{metric.label}</th>
              <th style={S.th}>Fecha</th>
              <th style={S.th}>Momento</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f, i) => (
              <tr key={f.player.nombre} style={{ ...S.tr, background: RANK_ROW_BG[i], borderLeft: RANK_ROW_BORDER[i] ? `3px solid ${RANK_ROW_BORDER[i]}` : "3px solid transparent" }}>
                <td style={{ ...S.td, fontFamily: mono, fontWeight: 700, color: RANK_COLOR[i] || "#8BA4C0" }}>{i + 1}</td>
                <td style={S.td}>{f.player.nombre}</td>
                <td style={S.td}>{posicionLabel(rosterMap.get(f.player.nombre)) === "Sin posición" ? "—" : posicionLabel(rosterMap.get(f.player.nombre))}</td>
                <td style={S.tdNum}>{fmt(f.valor, metric.decimals)} {metric.unit}</td>
                <td style={S.td}>
                  {fmtDate(f.fecha)}
                  {esReciente(f.fecha) && <span style={S.recienteTag} title="Marca conseguida en los últimos 14 días">▲ reciente</span>}
                </td>
                <td style={S.td}>{f.tag ? TAG_META[f.tag].label : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {sinDatos.length > 0 && (
        <div style={{ ...S.emptySmall, marginTop: 14 }}>
          Sin marca en este filtro: {sinDatos.map(p => p.nombre).join(", ")}.
        </div>
      )}
    </div>
  );
}

// ================= Tab: Jugadores (plantilla + ficha) =================
function Jugadores({ allNames, roster, onToggle, onSetAll, onSetPosicion, onAddManual,
  plantillas, onCrearPlantilla, onRenombrarPlantilla, onEliminarPlantilla, onSetPlantillaDeJugador, onQuitarDePlantilla,
  allPlayers, microList, ambarPct, rojoPct }) {
  const [plantillaSel, setPlantillaSel] = useState(null);
  const [nuevaPlantilla, setNuevaPlantilla] = useState("");
  const [mostrarCrear, setMostrarCrear] = useState(false);
  const [search, setSearch] = useState("");
  const [profileName, setProfileName] = useState(null);
  const [nuevoNombre, setNuevoNombre] = useState("");
  const [nuevaPosicion, setNuevaPosicion] = useState(POSICIONES[0].key);
  const [addExistente, setAddExistente] = useState("");
  const [mostrarAnadir, setMostrarAnadir] = useState(false);
  const [renombrando, setRenombrando] = useState(false);
  const [nombreEditado, setNombreEditado] = useState("");
  const [editandoNombre, setEditandoNombre] = useState(null);

  const rosterMap = useMemo(() => new Map(roster.map(r => [r.nombre, r])), [roster]);
  const testsDe = (nombre) => allPlayers.find(p => p.nombre === nombre)?.nTests ?? 0;
  const profilePlayer = allPlayers.find(p => p.nombre === profileName) || null;
  const posicionDelPerfil = profilePlayer ? rosterMap.get(profilePlayer.nombre)?.posicion : null;

  const contarJugadores = (plantillaId) => roster.filter(r => r.plantillaId === plantillaId).length;
  const plantilla = plantillas.find(p => p.id === plantillaSel) || null;

  // ---- Vista: lista de plantillas ----
  if (!plantilla) {
    const sinPlantilla = roster.filter(r => !r.plantillaId || !plantillas.some(p => p.id === r.plantillaId));
    return (
      <div>
        <div style={S.listHeaderRow}>
          <PageTitle title="Jugadores" sub="Tus equipos. Entra en uno para ver y gestionar sus jugadores." />
          <button style={S.addRoundBtn} onClick={() => setMostrarCrear(s => !s)} title="Crear plantilla">+</button>
        </div>

        {mostrarCrear && (
          <div style={S.microForm}>
            <div style={S.microFormTitle}>Nueva plantilla</div>
            <div style={S.formRow}>
              <div style={S.formField}>
                <label style={S.fieldLabel}>Nombre</label>
                <input style={S.dateInput} value={nuevaPlantilla} placeholder="Ej. SUB19 A"
                  onChange={e => setNuevaPlantilla(e.target.value)} autoFocus />
              </div>
            </div>
            <button style={S.applyBtn} disabled={!nuevaPlantilla.trim()}
              onClick={async () => { const id = await onCrearPlantilla(nuevaPlantilla); setNuevaPlantilla(""); setMostrarCrear(false); if (id) setPlantillaSel(id); }}>
              Guardar plantilla
            </button>
          </div>
        )}

        {plantillas.length === 0 ? (
          <EmptyPanel title="Aún no tienes ninguna plantilla" body="Pulsa el + de arriba para crear la primera — por ejemplo, con el nombre de tu equipo." />
        ) : (
          <div style={S.listaCard}>
            {plantillas.map((p, i) => (
              <div key={p.id} className="row" tabIndex={0}
                style={{ ...S.listaRow, borderTop: i === 0 ? "none" : S.listaRow.borderTop }}
                onClick={() => setPlantillaSel(p.id)}>
                <Avatar texto={p.nombre} />
                <div style={S.listaRowBody}>
                  <div style={S.listaRowName}>{p.nombre}</div>
                </div>
                <div style={S.listaRowCount}># de jugadores: {contarJugadores(p.id)}</div>
                <button style={S.linkBtnDanger} onClick={e => { e.stopPropagation(); onEliminarPlantilla(p.id); }}>Eliminar</button>
              </div>
            ))}
          </div>
        )}

        {sinPlantilla.length > 0 && (
          <>
            <div style={S.microTitle}>Jugadores sin plantilla asignada</div>
            <div style={S.listaCard}>
              {sinPlantilla.map((r, i) => (
                <div key={r.nombre} style={{ ...S.listaRow, borderTop: i === 0 ? "none" : S.listaRow.borderTop }}>
                  <Avatar texto={r.nombre} />
                  <div style={S.listaRowBody}>
                    <div style={S.listaRowName} onClick={() => setProfileName(r.nombre)}>{r.nombre}</div>
                  </div>
                  <select style={S.posSelect} value={r.plantillaId || ""} onChange={e => onSetPlantillaDeJugador(r.nombre, e.target.value || null)}>
                    <option value="">Sin plantilla</option>
                    {plantillas.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </>
        )}

        {profilePlayer && <PlayerDetail player={profilePlayer} microList={microList} posicion={posicionDelPerfil} />}
      </div>
    );
  }

  // ---- Vista: dentro de una plantilla ----
  const jugadoresPlantilla = roster.filter(r => r.plantillaId === plantilla.id);
  const disponiblesParaAnadir = allNames.filter(n => !roster.some(r => r.nombre === n && r.plantillaId));
  const filtrados = jugadoresPlantilla.filter(r => r.nombre.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <button style={S.cancelBtn} onClick={() => { setPlantillaSel(null); setProfileName(null); }}>← Equipos</button>

      <div style={S.listHeaderRow}>
        <div>
          {renombrando ? (
            <div style={{ display: "flex", gap: 8 }}>
              <input style={S.dateInput} value={nombreEditado} onChange={e => setNombreEditado(e.target.value)} autoFocus />
              <button style={S.applyBtn} onClick={() => { onRenombrarPlantilla(plantilla.id, nombreEditado); setRenombrando(false); }}>Guardar</button>
            </div>
          ) : (
            <div style={S.plantillaHeaderRow}>
              <div style={S.detailName}>{plantilla.nombre}</div>
              <button style={S.linkBtn} onClick={() => { setNombreEditado(plantilla.nombre); setRenombrando(true); }}>Renombrar</button>
            </div>
          )}
          <div style={S.detailSub}># de jugadores: {jugadoresPlantilla.length}</div>
        </div>
        <button style={S.addRoundBtn} onClick={() => setMostrarAnadir(s => !s)} title="Añadir jugador">+</button>
      </div>

      {mostrarAnadir && (
        <div style={S.microForm}>
          <div style={S.microFormTitle}>Añadir jugador a esta plantilla</div>
          <div style={S.formRow}>
            <div style={S.formField}>
              <label style={S.fieldLabel}>Desde el CSV</label>
              <select style={S.select} value={addExistente} onChange={e => {
                if (e.target.value) { onSetPlantillaDeJugador(e.target.value, plantilla.id); setAddExistente(""); setMostrarAnadir(false); }
              }}>
                <option value="">— Elegir jugador —</option>
                {disponiblesParaAnadir.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
          <div style={S.controlsDivider} />
          <div style={S.formRow}>
            <div style={S.formField}>
              <label style={S.fieldLabel}>O crea uno nuevo — Nombre</label>
              <input style={S.dateInput} value={nuevoNombre} placeholder="Nombre y apellido"
                onChange={e => setNuevoNombre(e.target.value)} />
            </div>
            <div style={S.formField}>
              <label style={S.fieldLabel}>Posición</label>
              <select style={S.select} value={nuevaPosicion} onChange={e => setNuevaPosicion(e.target.value)}>
                {POSICIONES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
          </div>
          <button style={S.applyBtn} disabled={!nuevoNombre.trim()}
            onClick={() => { onAddManual(nuevoNombre, nuevaPosicion, plantilla.id); setNuevoNombre(""); setMostrarAnadir(false); }}>
            Guardar jugador
          </button>
        </div>
      )}

      <input style={{ ...S.search, marginBottom: 14 }} placeholder="Buscar en esta plantilla…"
        value={search} onChange={e => setSearch(e.target.value)} />

      {filtrados.length === 0 ? (
        <div style={S.emptySmall}>Esta plantilla todavía no tiene jugadores.</div>
      ) : (
        <div style={S.listaCard}>
          {filtrados.map((r, i) => (
            <div key={r.nombre}>
              <div className="row" tabIndex={0} style={{ ...S.listaRow, borderTop: i === 0 ? "none" : S.listaRow.borderTop }}
                onClick={() => setEditandoNombre(editandoNombre === r.nombre ? null : r.nombre)}>
                <Avatar texto={r.nombre} />
                <div style={S.listaRowBody}>
                  <div style={S.listaRowName} onClick={e => { e.stopPropagation(); setProfileName(r.nombre); }}>{r.nombre} ›</div>
                  {r.posicion && <div style={S.listaRowSub}>{posicionLabel(r.posicion)}</div>}
                </div>
                <div style={S.listaRowCount}># de tests: {testsDe(r.nombre)}</div>
              </div>
              {editandoNombre === r.nombre && (
                <div style={S.listaRowEdit}>
                  <select style={S.posSelect} value={r.posicion || ""} onChange={e => onSetPosicion(r.nombre, e.target.value || null)}>
                    <option value="">Sin posición</option>
                    {POSICIONES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </select>
                  <button style={S.linkBtnDanger} onClick={() => onQuitarDePlantilla(r.nombre)}>Quitar de la plantilla</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {profilePlayer && <PlayerDetail player={profilePlayer} microList={microList} posicion={posicionDelPerfil} />}
    </div>
  );
}

// ================= Tab: Cargador CSV =================
function CargadorCSV({ onFile, issues, rows, onClear }) {
  const nPlayers = new Set(rows.map(r => r.nombre)).size;
  return (
    <div>
      <PageTitle title="Cargador CSV" sub="Sube la exportación de My Jump Lab. Como incluye siempre el histórico completo, cada carga sustituye al dataset guardado." />

      <label style={S.bigUpload}>
        Seleccionar archivo CSV
        <input type="file" accept=".csv" onChange={onFile} style={{ display: "none" }} />
      </label>

      {rows.length > 0 && (
        <div style={S.uploadSummary}>
          <Metric label="Registros válidos" value={rows.length} />
          <Metric label="Jugadores" value={nPlayers} />
          <button style={S.clearBtn} onClick={onClear}>Borrar dataset guardado</button>
        </div>
      )}

      {issues && (
        <section style={S.qualityPanel}>
          <ul style={S.qualityList}>
            <li><b>{issues.pesoZero}</b> registros sin peso corporal válido — Fuerza/Potencia excluidas en esos tests.</li>
            <li><b>{issues.hp0Suspect}</b> registros con distancia de empuje fuera de rango plausible (0,10–0,55 m).</li>
            <li><b>{issues.dupCount}</b> filas duplicadas eliminadas.</li>
            {issues.sessionsAgregadas > 0 && (
              <li><b>{issues.sessionsAgregadas}</b> sesiones con más de un salto el mismo día — se han promediado automáticamente en un único test por día.</li>
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

// ================= Shared: Player detail (ficha de jugador) =================
function PlayerDetail({ player, microList, posicion }) {
  const [periodo, setPeriodo] = useState("temporada"); // 'temporada' | 'rango' | 'microciclo'
  const [vista, setVista] = useState("real"); // 'real' | 'pct' — se aplica igual en los 3 periodos
  const [rango, setRango] = useState({ start: "", end: "" });
  const [filtroMetricas, setFiltroMetricas] = useState(() => new Set(["altura", "potenciaRel", "fuerzaRel"]));
  const toggleMetrica = (k) => setFiltroMetricas(prev => {
    const next = new Set(prev);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });
  const [showControls, setShowControls] = useState(false);
  const [showUmbralInfo, setShowUmbralInfo] = useState(false);
  const [showTablaInfo, setShowTablaInfo] = useState(false);

  const [filtroTags, setFiltroTags] = useState(() => new Set(["inicio", "md2", "md1", "sin"]));
  const toggleTag = (k) => setFiltroTags(prev => {
    const next = new Set(prev);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });

  const microRows = microList
    .map(m => ({ m, r: player.microResults.get(m.id) }))
    .filter(({ r }) => r);
  const [microSel, setMicroSel] = useState(() => microRows.length ? microRows[microRows.length - 1].m.id : null);

  // Media propia de cada métrica (toda la historia del jugador) — sirve para
  // normalizar altura/potencia/fuerza a "% respecto a su media" y poder verlas
  // juntas en un mismo eje aunque sus unidades sean distintas (cm, W/kg, N/kg).
  const mediaPropia = {};
  METRIC_LIST.forEach(metric => {
    const vals = player.sorted.map(r => metric.get(r)).filter(v => v != null);
    mediaPropia[metric.key] = vals.length ? mean(vals) : null;
  });

  const metricasActivas = METRIC_LIST.filter(m => filtroMetricas.has(m.key));
  // Ahora se pueden ver varias variables a la vez en cualquier vista: en "%"
  // comparten una escala común (misma unidad), y en "Valores reales" cada una
  // usa su propio eje interno oculto (sin números) — así ninguna aplasta a
  // las demás por tener una magnitud distinta, y el eje nunca induce a leer
  // mal la escala.
  const metricasMostradas = periodo === "microciclo" ? metricasActivas.filter(m => m.drivesStatus) : metricasActivas;

  const dentroDeRango = (r) => {
    if (periodo !== "rango") return true;
    if (!rango.start || !rango.end) return true;
    const t = new Date(r.date).getTime();
    return t >= new Date(rango.start).getTime() && t <= new Date(rango.end).getTime();
  };
  const registrosFiltrados = player.sorted.filter(r => filtroTags.has(r.tag || "sin") && dentroDeRango(r));
  const chartData = registrosFiltrados.map(r => {
    const point = { dateLabel: fmtDate(r.date), tag: r.tag };
    METRIC_LIST.forEach(metric => {
      const raw = metric.get(r);
      const media = mediaPropia[metric.key];
      // Si la media es prácticamente cero, dividir dispara el % a valores
      // absurdos (miles por ciento) — en ese caso se omite el punto en vez de
      // mostrar un dato sin sentido.
      point[metric.key] = (raw != null && media != null && Math.abs(media) > 0.5) ? ((raw - media) / media) * 100 : null;
      point[`${metric.key}_raw`] = raw;
    });
    return point;
  });
  const dominioChart = computeDomain(
    vista === "pct"
      ? chartData.flatMap(d => metricasMostradas.map(m => d[m.key]))
      : chartData.flatMap(d => metricasMostradas.map(m => d[`${m.key}_raw`]))
  );

  const microSeleccionado = microRows.find(({ m }) => m.id === microSel);
  const barData = [];
  if (microSeleccionado) {
    const r = microSeleccionado.r;
    ["inicio", "md2", "md1"].forEach(k => {
      if (!r[k]) return;
      const point = { label: TAG_META[k].label };
      METRIC_LIST.forEach(metric => {
        point[`${metric.key}_raw`] = metric.get(r[k]);
        point[metric.key] = metric.drivesStatus ? (k === "inicio" ? 0 : r.metrics[metric.key][`${k}Delta`]) : null;
      });
      barData.push(point);
    });
  }
  // Con solo 2-3 puntos, un margen del 15% puede seguir viéndose plano — se
  // amplía al 35% para que la ondulación entre Inicio/MD-2/MD+1 se note bien.
  const dominioMicro = computeDomain(
    vista === "pct"
      ? barData.flatMap(d => metricasMostradas.map(m => d[m.key]))
      : barData.flatMap(d => metricasMostradas.map(m => d[`${m.key}_raw`])),
    0.35
  );

  const etiquetaVariables = metricasMostradas.map(m => m.label).join(", ") || "sin variables seleccionadas";
  
  return (
    <section style={S.detail}>
      <div style={S.detailHeader}>
        <div className="row" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => setShowControls(s => !s)}>
          <div style={S.detailName}>{player.nombre} <span style={S.detailNameHint}>{showControls ? "▾" : "▸"}</span></div>
          <div style={S.detailSub}>{player.equipo}{posicion ? ` · ${posicionLabel(posicion)}` : ""} · {player.nTests} tests · primer test {fmtDate(player.sorted[0].date)} · último {fmtDate(player.sorted[player.sorted.length - 1].date)}</div>
        </div>
        <Badge status={player.combinedStatus} />
      </div>

      {showControls && (
      <>
      <div style={S.subTabs}>
        <button style={{ ...S.tabBtn, ...(periodo === "temporada" ? S.tabBtnActive : {}) }} onClick={() => setPeriodo("temporada")}>Temporada completa</button>
        <button style={{ ...S.tabBtn, ...(periodo === "rango" ? S.tabBtnActive : {}) }} onClick={() => setPeriodo("rango")}>Rango de fechas</button>
        <button style={{ ...S.tabBtn, ...(periodo === "microciclo" ? S.tabBtnActive : {}) }} onClick={() => setPeriodo("microciclo")}>Microciclo concreto</button>
      </div>

      <div style={S.chartControls}>
        <div style={S.controlsRow}>
          <span style={S.controlsLabel}>Vista</span>
          <div style={S.subTabs}>
            <button style={{ ...S.tabBtn, ...(vista === "real" ? S.tabBtnActive : {}) }} onClick={() => setVista("real")}>Valores reales</button>
            <button style={{ ...S.tabBtn, ...(vista === "pct" ? S.tabBtnActive : {}) }} onClick={() => setVista("pct")}>% respecto a su media</button>
          </div>
        </div>

        <div style={S.controlsDivider} />

        <div style={S.controlsRow}>
          <span style={S.controlsLabel}>Variables</span>
          <FiltroDropdown
            label="Variables"
            options={METRIC_LIST.map(m => ({ key: m.key, label: m.label, color: METRIC_CHART_COLOR[m.key] }))}
            selected={filtroMetricas} onToggle={toggleMetrica}
            onAll={() => setFiltroMetricas(new Set(METRIC_LIST.map(m => m.key)))}
            onNone={() => setFiltroMetricas(new Set())}
          />
        </div>

        {periodo !== "microciclo" && (
          <div style={S.controlsRow}>
            <span style={S.controlsLabel}>Momento</span>
            <FiltroDropdown
              label="Momento"
              options={[
                { key: "inicio", label: "Inicio", color: TAG_META.inicio.color },
                { key: "md2", label: "MD-2", color: TAG_META.md2.color },
                { key: "md1", label: "MD+1", color: TAG_META.md1.color },
                { key: "sin", label: "Sin etiqueta", color: "#4A6680" }
              ]}
              selected={filtroTags} onToggle={toggleTag}
              onAll={() => setFiltroTags(new Set(["inicio", "md2", "md1", "sin"]))}
              onNone={() => setFiltroTags(new Set())}
            />
          </div>
        )}

        {periodo === "rango" && (
          <div style={S.controlsRow}>
            <span style={S.controlsLabel}>Fechas</span>
            <div style={{ display: "flex", gap: 14 }}>
              <input type="date" style={S.dateInput} value={rango.start} onChange={e => setRango({ ...rango, start: e.target.value })} />
              <input type="date" style={S.dateInput} value={rango.end} onChange={e => setRango({ ...rango, end: e.target.value })} />
            </div>
          </div>
        )}

        {periodo === "microciclo" && microRows.length > 0 && (
          <div style={S.controlsRow}>
            <span style={S.controlsLabel}>Microciclo</span>
            <select style={S.select} value={microSel || ""} onChange={e => setMicroSel(e.target.value)}>
              {microRows.map(({ m }) => <option key={m.id} value={m.id}>Nº {m.numero}</option>)}
            </select>
          </div>
        )}
      </div>
      </>
      )}

      {periodo !== "microciclo" ? (
        <>
          <div style={S.chartSectionTitleRow}>
            <div style={S.chartSectionTitle}>{periodo === "rango" ? "Periodo seleccionado" : "Todos los registros"}</div>
            {metricasMostradas.some(m => m.drivesStatus) && (
              <button style={S.infoIconBtn} onClick={() => setShowUmbralInfo(s => !s)} title="Umbrales aplicados">ℹ️</button>
            )}
          </div>
          {showUmbralInfo && metricasMostradas.some(m => m.drivesStatus) && (
            <div style={S.umbralNote}>
              {metricasMostradas.filter(m => m.drivesStatus).map(metric => {
                const u = player.umbral[metric.key];
                if (!u) return null;
                return (
                  <div key={metric.key} style={{ marginBottom: 4 }}>
                    <span style={{ color: METRIC_CHART_COLOR[metric.key], fontWeight: 700 }}>{metric.label}: </span>
                    {u.personalizado
                      ? <>umbral <b>personalizado</b> (ámbar {fmt(u.ambarPct, 1)}% / rojo {fmt(u.rojoPct, 1)}%, a partir de {u.n} Inicios)</>
                      : <>umbral <b>general</b> (tiene {u.n} de los 4 Inicios necesarios para personalizarlo)</>}
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ marginBottom: 10 }}>
            <ResponsiveContainer width="100%" height={270}>
              <LineChart data={chartData} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="#1A3050" vertical={false} />
                <XAxis dataKey="dateLabel" tick={{ fill: "#8BA4C0", fontSize: 11 }} interval="preserveStartEnd" />
                {vista === "pct" ? (
                  <YAxis tick={false} domain={dominioChart} allowDataOverflow />
                ) : (
                  metricasMostradas.map(metric => (
                    <YAxis key={metric.key} yAxisId={metric.key} hide
                      domain={computeDomain(chartData.map(d => d[`${metric.key}_raw`]))} allowDataOverflow />
                  ))
                )}
                <Tooltip
                  contentStyle={{ background: "#122440", border: "1px solid #1A3050", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "#8BA4C0" }}
                  formatter={(value, name, entry) => {
                    const metric = METRICS[name] || METRICS[String(entry.dataKey).replace(/_raw$/, "")];
                    if (!metric) return [value, name];
                    if (vista === "pct") {
                      const raw = entry.payload[`${metric.key}_raw`];
                      return [value == null ? "—" : `${raw != null ? raw.toFixed(metric.decimals) + " " + metric.unit + " · " : ""}${value > 0 ? "+" : ""}${value.toFixed(1)}%`, metric.label];
                    }
                    return [value == null ? "—" : `${value.toFixed(metric.decimals)} ${metric.unit}`, metric.label];
                  }}
                  labelFormatter={(label, entry) => {
                    const tag = entry?.[0]?.payload?.tag;
                    return tag ? `${label} · ${TAG_META[tag]?.label || ""}` : label;
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(value) => METRICS[value]?.label || value} />
                {metricasMostradas.map(metric => (
                  <Line key={metric.key} type="monotone"
                    dataKey={vista === "pct" ? metric.key : `${metric.key}_raw`} name={metric.key}
                    yAxisId={vista === "pct" ? undefined : metric.key}
                    stroke={METRIC_CHART_COLOR[metric.key]} strokeWidth={2} connectNulls
                    dot={{ r: 3.5, fill: METRIC_CHART_COLOR[metric.key], stroke: "#060D1A", strokeWidth: 1 }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {vista === "pct" && metricasMostradas.length > 1 && (
            <div style={{ ...S.emptySmall, marginBottom: 18 }}>
              Nota: cada variable se muestra como % respecto a su propia media, para poder comparar su forma
              en la misma escala aunque sus unidades reales sean distintas.
            </div>
          )}
        </>
      ) : (
        microRows.length > 0 && (
          <>
            <div style={S.chartSectionTitleRow}>
              <div style={S.chartSectionTitle}>Microciclo Nº {microSeleccionado?.m.numero}</div>
              {metricasMostradas.some(m => m.drivesStatus) && (
                <button style={S.infoIconBtn} onClick={() => setShowUmbralInfo(s => !s)} title="Umbrales aplicados">ℹ️</button>
              )}
            </div>
            {showUmbralInfo && metricasMostradas.some(m => m.drivesStatus) && (
              <div style={S.umbralNote}>
                {metricasMostradas.filter(m => m.drivesStatus).map(metric => {
                  const u = player.umbral[metric.key];
                  if (!u) return null;
                  return (
                    <div key={metric.key} style={{ marginBottom: 4 }}>
                      <span style={{ color: METRIC_CHART_COLOR[metric.key], fontWeight: 700 }}>{metric.label}: </span>
                      {u.personalizado
                        ? <>umbral <b>personalizado</b> (ámbar {fmt(u.ambarPct, 1)}% / rojo {fmt(u.rojoPct, 1)}%, a partir de {u.n} Inicios)</>
                        : <>umbral <b>general</b> (tiene {u.n} de los 4 Inicios necesarios para personalizarlo)</>}
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ marginBottom: 10 }}>
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={barData} margin={{ top: 24, right: 20, left: -10, bottom: 0 }}>
                  <CartesianGrid stroke="#1A3050" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: "#8BA4C0", fontSize: 11 }} />
                  {vista === "pct" ? (
                    <YAxis tick={false} domain={dominioMicro} allowDataOverflow />
                  ) : (
                    metricasMostradas.map(metric => (
                      <YAxis key={metric.key} yAxisId={metric.key} hide
                        domain={computeDomain(barData.map(d => d[`${metric.key}_raw`]), 0.35)} allowDataOverflow />
                    ))
                  )}
                  <Tooltip
                    contentStyle={{ background: "#122440", border: "1px solid #1A3050", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "#8BA4C0" }}
                    formatter={(value, name) => {
                      const metric = METRICS[name];
                      if (!metric) return [value, name];
                      return vista === "pct"
                        ? [`${value > 0 ? "+" : ""}${value.toFixed(1)}%`, metric.label]
                        : [`${value.toFixed(metric.decimals)} ${metric.unit}`, metric.label];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} formatter={(value) => METRICS[value]?.label || value} />
                  {metricasMostradas.map(metric => (
                    <Line key={metric.key} type="monotone"
                      dataKey={vista === "pct" ? metric.key : `${metric.key}_raw`} name={metric.key}
                      yAxisId={vista === "pct" ? undefined : metric.key}
                      stroke={METRIC_CHART_COLOR[metric.key]} strokeWidth={2.5} connectNulls
                      dot={{ r: 6, fill: METRIC_CHART_COLOR[metric.key], stroke: "#060D1A", strokeWidth: 1.5 }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )
      )}

      <div style={S.microTitleRow}>
        <span style={S.microTitle}>Tabla de rendimiento ({etiquetaVariables})</span>
        <button style={S.infoBtnSmall} onClick={() => setShowTablaInfo(s => !s)}>{showTablaInfo ? "▾" : "▸"} ¿Qué es el %?</button>
      </div>
      {showTablaInfo && (
        <div style={{ ...S.emptySmall, marginBottom: 10 }}>
          El % entre paréntesis junto a cada dato es su cambio frente a la referencia que corresponde:
          MD-2/MD+1 se comparan con el Inicio de esa misma semana, y un Inicio se compara con el Inicio anterior.
          Sin ninguna de esas referencias disponibles, no se muestra ningún %.
        </div>
      )}
      {periodo !== "microciclo" ? (
        registrosFiltrados.length === 0 ? (
          <div style={S.emptySmall}>Ningún registro coincide con el filtro seleccionado.</div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr style={S.trHead}>
                <th style={S.th}>Fecha</th>
                <th style={S.th}>Momento</th>
                {metricasMostradas.map(m => <th key={m.key} style={S.thNum}>{m.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...registrosFiltrados].reverse().map((r, i) => (
                <tr key={i} style={S.tr}>
                  <td style={S.td}>{fmtDate(r.date)}</td>
                  <td style={S.td}>{r.tag ? TAG_META[r.tag].label : "—"}</td>
                  {metricasMostradas.map(m => {
                    const v = m.get(r);
                    const ref = referenciaFila(player, r, m);
                    const tip = r.tag === "inicio" ? "vs Inicio anterior" : r.tag ? "vs Inicio de esa semana" : undefined;
                    return (
                      <td key={m.key} style={S.tdNum} title={tip}>
                        <CeldaConReferencia valor={v} unidad={m.unit} decimales={m.decimals} refInfo={ref} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        microSeleccionado ? (
          <table style={S.table}>
            <thead>
              <tr style={S.trHead}>
                <th style={S.th}>Momento</th>
                {metricasMostradas.map(m => <th key={m.key} style={S.thNum}>{m.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {["inicio", "md2", "md1"].filter(k => microSeleccionado.r[k]).map(k => (
                <tr key={k} style={S.tr}>
                  <td style={S.td}>{TAG_META[k].label}</td>
                  {metricasMostradas.map(m => {
                    const v = m.get(microSeleccionado.r[k]);
                    const ref = k === "inicio" ? null : (m.drivesStatus ? microSeleccionado.r.metrics[m.key][`${k}Delta`] : null);
                    return (
                      <td key={m.key} style={S.tdNum} title={k === "inicio" ? undefined : "vs Inicio de esa semana"}>
                        <CeldaConReferencia valor={v} unidad={m.unit} decimales={m.decimals} refInfo={ref} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div style={S.emptySmall}>Selecciona un microciclo.</div>
      )}
    </section>
  );
}

function SummaryStat({ label, value }) {
  return (
    <div style={S.summaryStat}>
      <div style={S.summaryValue}>{value}</div>
      <div style={S.summaryLabel}>{label}</div>
    </div>
  );
}

// ================= Small shared UI =================
function PageTitle({ title, sub }) {
  return (
    <div style={S.pageTitle}>
      <div style={S.pageTitleMain}>{title}</div>
      {sub && <div style={S.pageTitleSub}>{sub}</div>}
    </div>
  );
}
function Metric({ label, value }) {
  return (
    <div>
      <div style={S.metricValue}>{value}</div>
      <div style={S.metricLabel}>{label}</div>
    </div>
  );
}
function EmptyPanel({ title, body }) {
  return (
    <div style={S.emptyState}>
      <div style={S.emptyBig}>{title}</div>
      <div style={S.emptySmall}>{body}</div>
    </div>
  );
}

// ================= Styles =================
const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const sans = "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const S = {
  page: { minHeight: "100vh", background: "#060D1A", color: "#F0F4FF", fontFamily: sans },
  shell: { display: "flex", minHeight: "100vh" },
  sidebar: { width: 190, borderRight: "1px solid #1A3050", padding: "18px 14px", display: "flex", flexDirection: "column", gap: 6 },
  brand: { display: "flex", alignItems: "center", gap: 8, marginBottom: 14 },
  brandMark: { fontFamily: mono, fontWeight: 700, fontSize: 12, color: "#060D1A", background: "#F5C518", padding: "5px 8px", borderRadius: 6 },
  brandTitle: { fontWeight: 700, fontSize: 11.5, letterSpacing: 0.4 },
  navBtn: { textAlign: "left", background: "transparent", border: "none", color: "#8BA4C0", padding: "10px 10px", borderRadius: 8, cursor: "pointer", fontSize: 13.5 },
  navBtnActive: { background: "#122440", color: "#F5C518", fontWeight: 600 },
  settingsBtn: { marginTop: 14, textAlign: "left", background: "transparent", border: "1px solid #1A3050", color: "#8BA4C0", padding: "8px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12 },
  settingsPanel: { display: "flex", flexDirection: "column", gap: 10, padding: "10px 4px" },
  threshLabel: { fontSize: 11, color: "#8BA4C0", display: "flex", flexDirection: "column", gap: 2 },
  checkboxLabel: { fontSize: 11.5, color: "#8BA4C0", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" },
  thresholdRef: { fontSize: 10.5, color: "#8BA4C0", lineHeight: 1.6, marginTop: 4, paddingTop: 10, borderTop: "1px dashed #1A3050" },
  infoBtn: { fontSize: 11, background: "transparent", border: "1px solid #1A3050", color: "#8BA4C0", padding: "6px 10px", borderRadius: 6, cursor: "pointer", marginTop: 2, marginBottom: 10, textAlign: "left" },
  infoBtnSmall: { fontSize: 10.5, background: "transparent", border: "none", color: "#8BA4C0", cursor: "pointer", padding: 0 },
  sidebarFooter: { marginTop: "auto", fontSize: 11, color: "#4A6680", lineHeight: 1.5, paddingTop: 14 },
  retryBtn: { fontSize: 10.5, background: "transparent", border: "1px solid #F5C518", color: "#F5C518", padding: "2px 6px", borderRadius: 4, cursor: "pointer" },
  main: { flex: 1, padding: "24px 28px", minWidth: 0 },
  pageTitle: { marginBottom: 18 },
  pageTitleMain: { fontSize: 19, fontWeight: 700 },
  pageTitleSub: { fontSize: 12.5, color: "#8BA4C0", marginTop: 3 },
  groupSection: { marginBottom: 22 },
  groupHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 },
  groupCount: { fontFamily: mono, fontSize: 12, color: "#8BA4C0" },
  cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 },
  playerCard: { background: "#0E1E35", border: "1px solid #1A3050", borderRadius: 10, padding: "9px 11px", cursor: "pointer" },
  playerCardByStatus: {
    red:    { background: "rgba(239,68,68,0.14)",  border: "1px solid #EF4444" },
    amber:  { background: "rgba(245,197,24,0.14)", border: "1px solid #F5C518" },
    green:  { background: "rgba(34,197,94,0.12)",  border: "1px solid #22C55E" },
    gray:   { background: "#0E1E35", border: "1px solid #1A3050" }
  },
  playerCardName: { fontSize: 12.5, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 5, minWidth: 0 },
  playerCardDeltas: { display: "flex", justifyContent: "space-between", fontSize: 11, color: "#8BA4C0", marginTop: 6, fontFamily: mono },
  metricRows: { display: "flex", flexDirection: "column", gap: 2, marginTop: 2 },
  metricRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 12, cursor: "pointer", padding: "1px 0" },
  metricRowLabel: { color: "#8BA4C0" },
  metricRowValue: { fontFamily: mono, fontWeight: 700, fontSize: 13 },
  metricRowsEmpty: { fontSize: 12, color: "#4A6680", marginTop: 4 },
  playerCardNameLink: { cursor: "pointer", textDecoration: "underline", textDecorationColor: "rgba(240,244,255,0.25)", textUnderlineOffset: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, maxWidth: "65%", flexShrink: 1, fontSize: 12.5 },
  nivelTag: { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, flexShrink: 0 },
  nivelSep: { color: "#4A6680", flexShrink: 0 },
  posicionTag: { fontSize: 10.5, color: "#8BA4C0", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 },
  expandHint: { fontSize: 10.5, color: "#8BA4C0", marginTop: 6, textAlign: "center" },
  explainBox: { marginTop: 8, paddingTop: 8, borderTop: "1px dashed #1A3050", display: "flex", flexDirection: "column", gap: 8 },
  explainAccion: { fontSize: 12, fontWeight: 700 },
  explainRow: { fontSize: 12, lineHeight: 1.55, color: "#DCE3EC" },
  explainMetricHeader: { cursor: "pointer", fontSize: 12.5, padding: "3px 0" },
  posSectionTitle: { fontSize: 12.5, fontWeight: 700, color: "#8BA4C0", textTransform: "uppercase", letterSpacing: 0.5 },
  divergeDot: { marginLeft: 6, fontSize: 11, color: "#F5C518", cursor: "pointer", flexShrink: 0 },
  tablaRefTag: { fontSize: 10.5, fontWeight: 700, fontFamily: mono },
  recienteTag: { marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: "#22C55E" },
  divergeRow: { fontSize: 10.5, color: "#F5C518", marginTop: 5, fontFamily: mono, borderTop: "1px dashed #1A3050", paddingTop: 5 },
  motivoRow: { fontSize: 11, color: "#8BA4C0", marginTop: 6, borderTop: "1px dashed #1A3050", paddingTop: 6, lineHeight: 1.4 },
  velocityNote: { fontSize: 11.5, color: "#8BA4C0", marginBottom: 14, maxWidth: 560, lineHeight: 1.5 },
  umbralNote: { fontSize: 11.5, color: "#8BA4C0", marginBottom: 14, maxWidth: 560, lineHeight: 1.5, background: "#122440", border: "1px solid #1A3050", borderRadius: 8, padding: "8px 12px" },
  barList: { display: "flex", flexDirection: "column", gap: 4 },
  barRow: { display: "grid", gridTemplateColumns: "150px 1fr 60px", alignItems: "center", gap: 10, padding: "4px 0", cursor: "pointer" },
  barLabel: { fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  barTrack: { background: "#122440", borderRadius: 4, height: 10, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 4 },
  barValue: { fontFamily: mono, fontSize: 12, textAlign: "right" },
  microForm: { background: "#0E1E35", border: "1px solid #1A3050", borderRadius: 12, padding: 18, marginBottom: 22, maxWidth: 720 },
  microFormTitle: { fontSize: 13, fontWeight: 700, marginBottom: 14, color: "#8BA4C0", textTransform: "uppercase", letterSpacing: 0.4 },
  formRow: { display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 },
  formField: { display: "flex", flexDirection: "column", gap: 5, minWidth: 120 },
  fieldLabel: { fontSize: 11, color: "#8BA4C0", fontWeight: 600 },
  numInput: { background: "#122440", border: "1px solid #1A3050", color: "#F0F4FF", padding: "8px 10px", borderRadius: 6, fontSize: 13, width: 80, fontFamily: mono },
  dateInput: { background: "#122440", border: "1px solid #1A3050", color: "#F0F4FF", padding: "8px 10px", borderRadius: 6, fontSize: 12.5 },
  select: { background: "#122440", border: "1px solid #1A3050", color: "#F0F4FF", padding: "8px 10px", borderRadius: 6, fontSize: 12.5 },
  formActions: { display: "flex", gap: 10, alignItems: "center" },
  applyBtn: { fontFamily: mono, fontSize: 12, background: "#F5C518", border: "none", color: "#060D1A", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontWeight: 700 },
  cancelBtn: { fontFamily: mono, fontSize: 12, background: "transparent", border: "1px solid #1A3050", color: "#8BA4C0", padding: "8px 16px", borderRadius: 6, cursor: "pointer" },
  microTitle: { fontSize: 12.5, color: "#8BA4C0", margin: "6px 0 10px", textTransform: "uppercase", letterSpacing: 0.4 },
  microTitleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", margin: "6px 0 10px", flexWrap: "wrap", gap: 8 },
  chartSectionTitle: { fontSize: 12.5, color: "#8BA4C0", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700 },
  chartSectionTitleRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 18, marginBottom: 10 },
  infoIconBtn: { background: "transparent", border: "none", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 },
  chartControls: { background: "#0E1E35", border: "1px solid #1A3050", borderRadius: 12, padding: 16, marginTop: 16, marginBottom: 18, display: "flex", flexDirection: "column", gap: 12 },
  controlsRow: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" },
  controlsLabel: { fontSize: 11, color: "#4A6680", textTransform: "uppercase", letterSpacing: 0.4, minWidth: 70, flexShrink: 0 },
  controlsDivider: { borderTop: "1px dashed #1A3050" },
  chartMetricTitle: { fontSize: 12.5, fontWeight: 600, marginBottom: 6 },
  chartMetricUnit: { color: "#8BA4C0", fontWeight: 400 },
  linkBtn: { background: "transparent", border: "none", color: "#1E6FD9", cursor: "pointer", fontSize: 12, marginRight: 10 },
  linkBtnDanger: { background: "transparent", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 12 },
  subTabs: { display: "flex", gap: 8, marginBottom: 16 },
  tabBtn: { fontSize: 13, background: "transparent", border: "1px solid #1A3050", color: "#8BA4C0", padding: "8px 14px", borderRadius: 6, cursor: "pointer" },
  tabBtnActive: { background: "#122440", color: "#F5C518", borderColor: "#F5C518" },
  vueltasRanges: { display: "flex", gap: 30, marginBottom: 14, flexWrap: "wrap" },
  rangeBlock: { display: "flex", flexDirection: "column", gap: 6 },
  rangeTitle: { fontSize: 12, color: "#8BA4C0", textTransform: "uppercase", letterSpacing: 0.4 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  trHead: { borderBottom: "1px solid #1A3050" },
  th: { textAlign: "left", padding: "8px 10px", color: "#8BA4C0", fontWeight: 500, fontSize: 11, textTransform: "uppercase" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "#8BA4C0", fontWeight: 500, fontSize: 11, textTransform: "uppercase" },
  tr: { borderBottom: "1px solid #1A3050" },
  td: { padding: "10px", fontSize: 13.5 },
  tdNum: { padding: "10px", fontSize: 13.5, textAlign: "right", fontFamily: mono },
  bigUpload: { display: "inline-block", fontFamily: mono, fontSize: 13, background: "#122440", border: "1px dashed #F5C518", color: "#F5C518", padding: "20px 28px", borderRadius: 10, cursor: "pointer", marginBottom: 18 },
  uploadSummary: { display: "flex", alignItems: "center", gap: 30, marginBottom: 16 },
  metricValue: { fontFamily: mono, fontWeight: 700, fontSize: 20 },
  metricLabel: { fontSize: 11, color: "#8BA4C0", textTransform: "uppercase" },
  clearBtn: { marginLeft: "auto", fontSize: 12, background: "transparent", border: "1px solid #EF4444", color: "#EF4444", padding: "8px 12px", borderRadius: 6, cursor: "pointer" },
  hintBanner: { background: "rgba(245,197,24,0.1)", border: "1px solid rgba(245,197,24,0.35)", color: "#F5C518", fontSize: 12.5, padding: "10px 14px", borderRadius: 8, marginBottom: 18, maxWidth: 640 },
  filterBar: { display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" },
  filtroDropdown: { position: "relative" },
  filtroDropdownBtn: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, background: "#0E1E35", border: "1px solid #1A3050", color: "#8BA4C0", padding: "8px 14px", borderRadius: 8, cursor: "pointer" },
  filtroDropdownPanel: { position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 20, background: "#122440", border: "1px solid #1A3050", borderRadius: 10, padding: 12, minWidth: 190, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" },
  filtroDropdownActions: { display: "flex", gap: 8, marginBottom: 8, paddingBottom: 8, borderBottom: "1px dashed #1A3050" },
  filtroDropdownActionBtn: { fontSize: 11, background: "transparent", border: "1px solid #1A3050", color: "#8BA4C0", padding: "3px 9px", borderRadius: 6, cursor: "pointer" },
  filtroDropdownItem: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "4px 2px", cursor: "pointer" },
  search: { background: "#122440", border: "1px solid #1A3050", color: "#F0F4FF", padding: "8px 12px", borderRadius: 6, fontSize: 13, minWidth: 220 },
  rosterBar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 },
  rosterOn: { fontSize: 12.5, color: "#F5C518", fontWeight: 600 },
  rosterOff: { fontSize: 12.5, color: "#8BA4C0" },
  rosterGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 4, maxHeight: 480, overflowY: "auto", background: "#0E1E35", border: "1px solid #1A3050", borderRadius: 10, padding: 12 },
  rosterItem: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "6px 8px", borderRadius: 6 },
  rosterItemRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "6px 8px", borderRadius: 6 },
  plantillaCard: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#0E1E35", border: "1px solid #1A3050", borderRadius: 10, padding: 14, cursor: "pointer" },
  listHeaderRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 18 },
  addRoundBtn: { width: 34, height: 34, borderRadius: "50%", background: "#F5C518", color: "#060D1A", border: "none", fontSize: 20, fontWeight: 700, cursor: "pointer", flexShrink: 0, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  listaCard: { background: "#0E1E35", border: "1px solid #1A3050", borderRadius: 12, overflow: "hidden" },
  listaRow: { display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderTop: "1px solid #1A3050", cursor: "pointer" },
  listaRowBody: { flex: 1, minWidth: 0 },
  listaRowName: { fontSize: 13.5, fontWeight: 600, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  listaRowSub: { fontSize: 11, color: "#8BA4C0", marginTop: 2 },
  listaRowCount: { fontSize: 12, color: "#8BA4C0", flexShrink: 0, whiteSpace: "nowrap" },
  listaRowEdit: { display: "flex", alignItems: "center", gap: 12, padding: "10px 14px 14px 64px", borderTop: "1px dashed #1A3050", background: "#0B1930" },
  plantillaCardName: { fontSize: 14, fontWeight: 700 },
  plantillaCardCount: { fontSize: 11.5, color: "#8BA4C0", marginTop: 3 },
  plantillaHeaderRow: { display: "flex", alignItems: "center", gap: 12, marginTop: 12, marginBottom: 2 },
  posSelect: { marginLeft: "auto", background: "#122440", border: "1px solid #1A3050", color: "#8BA4C0", padding: "3px 6px", borderRadius: 5, fontSize: 11.5 },
  rosterName: { cursor: "pointer" },
  summaryRow: { display: "flex", gap: 22, marginBottom: 16, flexWrap: "wrap" },
  summaryStat: {},
  summaryValue: { fontFamily: mono, fontWeight: 700, fontSize: 17 },
  summaryLabel: { fontSize: 10.5, color: "#8BA4C0", textTransform: "uppercase", letterSpacing: 0.4 },
  checkbox: { accentColor: "#F5C518", width: 15, height: 15, cursor: "pointer" },
  qualityPanel: { padding: 14, background: "#122440", border: "1px solid #1A3050", borderRadius: 10, maxWidth: 640 },
  qualityList: { fontSize: 13, color: "#8BA4C0", lineHeight: 1.6, paddingLeft: 18, margin: 0 },
  emptyState: { padding: "30px 0", maxWidth: 520 },
  emptyBig: { fontSize: 15, fontWeight: 600, marginBottom: 8 },
  emptySmall: { fontSize: 13.5, color: "#8BA4C0", lineHeight: 1.5 },
  detail: { marginTop: 20, padding: 20, background: "#0E1E35", border: "1px solid #1A3050", borderRadius: 12, maxWidth: 780 },
  detailHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, flexWrap: "wrap", gap: 10 },
  detailName: { fontSize: 17, fontWeight: 700 },
  detailNameHint: { fontSize: 13, color: "#8BA4C0", fontWeight: 400 },
  detailSub: { fontSize: 12, color: "#8BA4C0", marginTop: 3 },
  legend: { display: "flex", gap: 14, marginBottom: 10, flexWrap: "wrap" },
  legendItem: { fontSize: 11.5, color: "#8BA4C0", display: "flex", alignItems: "center", gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 8, display: "inline-block" },
  authScreen: { minHeight: "100vh", background: "#060D1A", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "system-ui, sans-serif", color: "#F0F4FF" },
  authBox: { background: "#0E1E35", border: "1px solid #1A3050", borderRadius: 14, padding: 28, width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 12 },
  authTitle: { fontSize: 18, fontWeight: 700 },
  authSub: { fontSize: 12.5, color: "#8BA4C0", lineHeight: 1.5, marginBottom: 4 },
  authInput: { background: "#122440", border: "1px solid #1A3050", color: "#F0F4FF", padding: "10px 12px", borderRadius: 8, fontSize: 14 },
  authBtn: { fontFamily: mono, fontSize: 13, background: "#F5C518", border: "none", color: "#060D1A", padding: "10px 16px", borderRadius: 8, cursor: "pointer", fontWeight: 700 },
  authBtnSecondary: { fontFamily: mono, fontSize: 12.5, background: "transparent", border: "1px solid #1A3050", color: "#F0F4FF", padding: "8px 14px", borderRadius: 8, cursor: "pointer" },
  authLink: { background: "transparent", border: "none", color: "#1E6FD9", cursor: "pointer", fontSize: 12.5, padding: 0, textAlign: "left" },
  authError: { fontSize: 12.5, color: "#EF4444" },
  authRemember: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#8BA4C0" },
  authRecoveryKey: { fontFamily: mono, fontSize: 17, letterSpacing: 1.5, background: "#122440", border: "1px dashed #F5C518", color: "#F5C518", padding: "14px 10px", borderRadius: 8, textAlign: "center", wordBreak: "break-all" }
};
