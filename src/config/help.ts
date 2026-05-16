// Fuente ÚNICA de la ayuda/onboarding del bot. Al agregar un flujo nuevo:
// añade (o edita) una entrada en HELP_TOPICS y aparece automáticamente en el
// menú (`ayuda`) y como tema detallado (`ayuda <clave>`). No duplicar textos
// de comandos en index.ts ni en docs: esto es la referencia viva.
//
// Restricción WhatsApp/Twilio: un mensaje ≈ 1600 chars. Por eso el menú es
// compacto y cada tema es un mensaje aparte (escala sin truncar).

export type HelpTopicKey =
  | "gastos"
  | "consultas"
  | "cuentas"
  | "saldo"
  | "pendientes"
  | "historial";

interface HelpTopic {
  /** Etiqueta del tema en el menú. */
  menuLabel: string;
  /** Una línea: para qué sirve (se muestra en el menú). */
  menuHint: string;
  /** Palabras que resuelven a este tema en `ayuda <alias>`. */
  aliases: string[];
  /** Cuerpo detallado del tema (un solo mensaje WhatsApp). */
  body: string;
}

// Orden = orden en el menú.
export const HELP_TOPICS: Record<HelpTopicKey, HelpTopic> = {
  gastos: {
    menuLabel: "💸 Registrar gastos",
    menuHint: "por texto, foto o audio",
    aliases: [
      "gasto", "gastos", "registrar", "registro",
      "foto", "imagen", "audio", "voz", "nota de voz",
    ],
    body:
      "💸 *Registrar un gasto*\n\n" +
      "Tienes 3 formas:\n\n" +
      "📝 *Texto* (lo más rápido)\n" +
      "• \"50 almuerzo\"\n" +
      "• \"25.50 taxi con yape\"\n" +
      "• \"Gasté 100 en supermercado\"\n" +
      "• Con fecha: \"ayer 30 mercado\", " +
      "\"el 12 de mayo 80 cena\"\n\n" +
      "📷 *Foto*\n" +
      "Envía la imagen de:\n" +
      "• Boleta / factura / recibo\n" +
      "• Captura de Yape o Plin\n" +
      "• Comprobante de transferencia\n" +
      "Leo el monto, comercio, fecha y método.\n\n" +
      "🎤 *Audio*\n" +
      "Manda una nota de voz: \"Gasté 25 soles en " +
      "almuerzo\". La transcribo y la registro.\n\n" +
      "Detecto solo: categoría, método de pago, moneda y " +
      "fecha. Si algo queda dudoso lo marco y te aviso " +
      "(escribe *ayuda pendientes*).",
  },
  consultas: {
    menuLabel: "📊 Consultar",
    menuHint: "cuánto gastaste y en qué",
    aliases: [
      "consulta", "consultas", "cuanto", "cuanto gaste",
      "reportes", "reporte", "resumen",
    ],
    body:
      "📊 *Consultar tus gastos*\n\n" +
      "Pregúntame en lenguaje natural:\n\n" +
      "• \"cuánto gasté hoy\"\n" +
      "• \"cuánto llevo este mes\"\n" +
      "• \"cuánto gasté en comida\"\n" +
      "• \"cuánto gasté en taxi esta semana\"\n" +
      "• \"resumen mayo\" / \"resumen mes pasado\"\n" +
      "• \"gastos de hoy\" — la lista del día\n\n" +
      "Periodos: *hoy*, *ayer*, *esta semana*, *este mes*, " +
      "*mes pasado*, o un mes (*mayo*).\n\n" +
      "Y para saber qué tienes configurado:\n" +
      "• *mis categorías* · *mis cuentas* · *mis métodos " +
      "de pago*",
  },
  cuentas: {
    menuLabel: "💳 Cuentas",
    menuHint: "consultar o cambiar la cuenta activa",
    aliases: ["cuenta", "cuentas"],
    body:
      "💳 *Cuentas*\n\n" +
      "Cada gasto se guarda en una cuenta (define la " +
      "moneda).\n\n" +
      "• *cuenta actual* — ver la cuenta activa\n" +
      "• *usar cuenta <nombre>* — cambiarla durante esta " +
      "conversación\n   Ej: \"usar cuenta negocio\"\n" +
      "• *cuenta principal* — volver a la principal\n\n" +
      "Tip: \"usar cuenta\" dura un rato y luego vuelve sola " +
      "a la principal.",
  },
  saldo: {
    menuLabel: "🧮 Dinero",
    menuHint: "saldo, ingresos y transferencias",
    aliases: [
      "saldo", "saldos", "dinero", "billetera", "wallet",
      "ingreso", "ingresos", "transferir", "transferencia",
      "movimiento", "movimientos",
    ],
    body:
      "🧮 *Dinero: saldo, ingresos, transferencias*\n\n" +
      "• *saldo* — saldo de la cuenta activa\n" +
      "• *saldos* — saldo de todas tus cuentas\n" +
      "• *movimientos* — últimos movimientos\n" +
      "• *ingreso <monto> <descripción>*\n" +
      "   Ej: \"ingreso 500 sueldo\"\n" +
      "• *transferir <monto> a <cuenta>*\n" +
      "   Ej: \"transferir 100 a ahorros\"",
  },
  pendientes: {
    menuLabel: "🗂️ Pendientes",
    menuHint: "gastos por clasificar o revisar",
    aliases: [
      "pendiente", "pendientes", "clasificar",
      "clasificacion", "revisar", "revision",
    ],
    body:
      "🗂️ *Pendientes y clasificación*\n\n" +
      "A veces no puedo clasificar un gasto, no reconozco el " +
      "método o el monto es atípico. Esos quedan " +
      "\"pendientes\".\n\n" +
      "• *pendientes* — lista lo que necesita tu revisión " +
      "(te muestro el ID de cada uno)\n" +
      "• *clasificar <id> <categoria> [subcategoria]*\n" +
      "   Ej: \"clasificar AbC123 comida restaurantes\"\n\n" +
      "⚠️ El *id* distingue mayúsculas: copia y pega el que " +
      "te muestro, no lo reescribas.\n" +
      "Cuando me corriges, lo aprendo para la próxima.",
  },
  historial: {
    menuLabel: "🧠 Aprendizaje",
    menuHint: "lo que recuerdo de ti",
    aliases: [
      "historial", "aprendizaje", "aprendizajes",
      "memoria", "recuerdos",
    ],
    body:
      "🧠 *Lo que aprendo de ti*\n\n" +
      "Recuerdo cómo clasificas tus gastos para acertar más " +
      "contigo.\n\n" +
      "• *historial* — tus decisiones recientes que estoy " +
      "usando\n" +
      "• *olvidar historial* — borrarlo todo (te pido " +
      "confirmar antes)\n\n" +
      "Tus correcciones (con *clasificar*) pesan más que mis " +
      "adivinanzas.",
  },
};

const HELP_KEYS = Object.keys(HELP_TOPICS) as HelpTopicKey[];

/**
 * Resuelve el resto de un comando de ayuda a un tema.
 * @param {string} restNormalized - texto tras "ayuda " ya normalizado
 *   (minúsculas, sin tildes). Vacío → menú (null).
 * @return {HelpTopicKey | null} el tema, o null si no hay match (→ menú).
 */
export function resolveHelpTopic(
  restNormalized: string
): HelpTopicKey | null {
  const r = restNormalized.trim();
  if (!r) return null;
  for (const key of HELP_KEYS) {
    if (key === r) return key;
    if (HELP_TOPICS[key].aliases.includes(r)) return key;
  }
  // match laxo: primera palabra (p.ej. "ayuda cuentas nueva")
  const first = r.split(" ")[0];
  for (const key of HELP_KEYS) {
    if (key === first || HELP_TOPICS[key].aliases.includes(first)) {
      return key;
    }
  }
  return null;
}

/**
 * Menú compacto. Generado desde HELP_TOPICS: un flujo nuevo aparece solo.
 * @return {string} mensaje del menú (cabe en 1 WhatsApp).
 */
export function buildHelpMenu(): string {
  const lines = HELP_KEYS.map(
    (k) =>
      `${HELP_TOPICS[k].menuLabel} — ${HELP_TOPICS[k].menuHint}\n` +
      `   → escribe *ayuda ${k}*`
  );
  return (
    "🤖 *Soy tu asistente de gastos*\n\n" +
    "Esto puedo hacer 👇\n\n" +
    lines.join("\n") +
    "\n📊 *Resumen* — total por categoría\n" +
    "   → escribe *resumen*\n\n" +
    "💡 Lo más rápido: escribe el monto y qué fue.\n" +
    "Ej: *\"50 almuerzo\"* o *\"25.50 taxi con yape\"*"
  );
}

/**
 * Detalle de un tema.
 * @param {HelpTopicKey} topic - tema a mostrar.
 * @return {string} cuerpo del tema + pie para volver al menú.
 */
export function buildHelpTopic(topic: HelpTopicKey): string {
  return (
    `${HELP_TOPICS[topic].body}\n\n` +
    "↩️ Escribe *ayuda* para ver todo."
  );
}

/**
 * Bienvenida / onboarding. Mismo módulo que la ayuda para no divergir.
 * @param {string} [name] - nombre del usuario (opcional).
 * @param {boolean} [firstContact] - true en el primer contacto tras
 *   vincular WhatsApp (añade el ✅ de vinculación).
 * @return {string} mensaje de bienvenida (1 WhatsApp).
 */
export function buildOnboarding(
  name?: string,
  firstContact = false
): string {
  const hi = name ? `¡Hola ${name}!` : "¡Hola!";
  const linked = firstContact ?
    " Tu número quedó vinculado ✅" :
    "";
  return (
    `👋 ${hi} Soy tu *asistente de gastos* por ` +
    `WhatsApp.${linked}\n\n` +
    "Registrar un gasto es así de simple:\n" +
    "📝 Escribe *\"50 almuerzo\"*\n" +
    "📷 O envíame la *foto* de una boleta / Yape\n" +
    "🎤 O una *nota de voz*\n\n" +
    "Yo detecto solo la categoría, el método de pago, la " +
    "moneda y la fecha.\n\n" +
    "También puedo: ver tu *saldo*, registrar *ingresos*, " +
    "*transferir* entre cuentas, darte un *resumen* y " +
    "aprender de tus correcciones.\n\n" +
    "📖 Escribe *ayuda* para ver todo lo que puedo hacer " +
    "(o *ayuda gastos*, *ayuda saldo*, …).\n\n" +
    "¡Empieza cuando quieras! 💸"
  );
}
