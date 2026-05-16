import {
  TwilioWebhookBody,
  BotCommand,
  QueryCommand,
  ResolvedPeriod,
  EditCommand,
} from "../types";

// Meses ES (incl. variante "setiembre"). Índice 0 = enero.
const MONTHS: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
};
const MONTH_LABELS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export class MessageParser {
  static normalizePhoneNumber(phone: string): string {
    let normalized = phone.replace(/^whatsapp:/, "");
    normalized = normalized.replace(/[^\d+]/g, "");

    if (!normalized.startsWith("+")) {
      normalized = `+${normalized}`;
    }

    return normalized;
  }

  static isValidWhatsAppMessage(body: TwilioWebhookBody): boolean {
    return (
      !!body &&
      typeof body === "object" &&
      !!body.MessageSid &&
      !!body.From &&
      body.From.startsWith("whatsapp:")
    );
  }

  static hasMedia(body: TwilioWebhookBody): boolean {
    const numMedia = parseInt(body.NumMedia || "0", 10);
    return numMedia > 0 && !!body.MediaUrl0;
  }

  static extractMessageText(body: string): string {
    return body.trim().toLowerCase();
  }

  // Normalización compartida para matching (ROADMAP § C.3):
  // minúsculas + sin diacríticos + espacios colapsados + trim.
  static normalizeForMatching(text: string): string {
    return text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  static isCommandMessage(
    message: string
  ): { isCommand: boolean; command?: string } {
    const lowerMessage = message.toLowerCase().trim();

    // "ayuda"/"comandos"/"menu" los maneja parseHelpCommand (soporta
    // "ayuda <tema>"), no este mapa.
    const commandMap: Record<string, string> = {
      "resumen": "resumen",
      "summary": "resumen",
      "total": "resumen",
      "ver gastos": "resumen",
      "hola": "inicio",
      "hi": "inicio",
      "inicio": "inicio",
      "start": "inicio",
    };

    for (const [key, value] of Object.entries(commandMap)) {
      if (lowerMessage === key || lowerMessage.startsWith(`/${key}`)) {
        return { isCommand: true, command: value };
      }
    }

    return { isCommand: false };
  }

  // Comandos de cuenta (ROADMAP § B.1): "usar cuenta <nombre>",
  // "cuenta actual", "cuenta principal" (con o sin prefijo "/").
  static parseAccountCommand(
    message: string
  ): { kind: "use" | "current" | "primary"; nombre?: string } | null {
    const m = message.toLowerCase().trim().replace(/^\//, "");
    if (m === "cuenta actual") return { kind: "current" };
    if (m === "cuenta principal") return { kind: "primary" };
    const useMatch = m.match(/^usar cuenta\s+(.+)$/);
    if (useMatch) return { kind: "use", nombre: useMatch[1].trim() };
    return null;
  }

  // Comando de ayuda: "ayuda" / "ayuda <tema>" (aliases: help, comandos,
  // commands, menu/menú; con o sin "/"). Devuelve el resto NORMALIZADO
  // (sin tildes, minúsculas) para que el caller lo resuelva a un tema vía
  // resolveHelpTopic. `rest` vacío → menú. null → no es comando de ayuda.
  static parseHelpCommand(message: string): { rest: string } | null {
    const m = MessageParser.normalizeForMatching(
      message.trim().replace(/^\//, "")
    );
    const keys = ["ayuda", "help", "comandos", "commands", "menu"];
    for (const k of keys) {
      if (m === k) return { rest: "" };
      if (m.startsWith(`${k} `)) {
        return { rest: m.slice(k.length).trim() };
      }
    }
    return null;
  }

  // Validación dura de monto (ROADMAP § B.3): > 0, finito, 2 decimales.
  static validateAmount(
    amount: number
  ): { ok: boolean; value?: number; error?: string } {
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      return { ok: false, error: "El monto no es un número válido." };
    }
    if (amount <= 0) {
      return { ok: false, error: "El monto debe ser mayor a 0." };
    }
    return { ok: true, value: Math.round(amount * 100) / 100 };
  }

  // Fecha real del gasto desde el texto (ROADMAP § B.4). Devuelve null si
  // no hay fecha explícita — el caller usa la fecha del mensaje como
  // fallback. Solo regex; frases relativas complejas las cubre el LLM.
  static parseDateFromText(text: string): Date | null {
    const norm = MessageParser.normalizeForMatching(text);
    const now = new Date();
    const atMessageTime = (d: Date): Date => {
      d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
      return d;
    };

    if (/\bhoy\b/.test(norm)) return atMessageTime(new Date());
    if (/\bayer\b/.test(norm) && !/\bantes de ayer\b/.test(norm)) {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return atMessageTime(d);
    }
    if (/\banteayer\b|\bantes de ayer\b/.test(norm)) {
      const d = new Date();
      d.setDate(d.getDate() - 2);
      return atMessageTime(d);
    }

    const iso = norm.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) {
      const d = new Date(+iso[1], +iso[2] - 1, +iso[3]);
      return isNaN(d.getTime()) ? null : atMessageTime(d);
    }

    const dmy = norm.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
    if (dmy) {
      const d = new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
      return isNaN(d.getTime()) ? null : atMessageTime(d);
    }

    const meses: Record<string, number> = {
      enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
      julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
      noviembre: 10, diciembre: 11,
    };
    const mesesAlt = Object.keys(meses).join("|");
    const elNde = norm.match(
      new RegExp(`\\bel (\\d{1,2}) de (${mesesAlt})\\b`)
    );
    if (elNde) {
      const day = +elNde[1];
      const month = meses[elNde[2]];
      const d = new Date(now.getFullYear(), month, day);
      if (d.getTime() > now.getTime()) {
        d.setFullYear(now.getFullYear() - 1);
      }
      return isNaN(d.getTime()) ? null : atMessageTime(d);
    }

    return null;
  }

  // Comandos de bot con argumentos (ROADMAP § F.5 + § C.6 + § G.5).
  static parseBotCommand(message: string): BotCommand | null {
    const m = message.toLowerCase().trim().replace(/^\//, "");
    // Los IDs de documento de Firestore son case-sensitive. `m` sirve para
    // matchear keywords, pero `clasificar <id>` debe leer el ID con su
    // capitalización original o getById nunca encuentra el doc.
    const orig = message.trim().replace(/^\//, "");

    if (m === "saldos" || m === "saldo de cuentas") return { kind: "saldos" };
    if (m === "saldo" || m === "mi saldo") return { kind: "saldo" };
    if (m === "movimientos" || m === "mis movimientos") {
      return { kind: "movimientos" };
    }
    if (
      m === "olvidar historial confirmar" ||
      m === "olvidar historial si" ||
      m === "si olvidar historial"
    ) {
      return { kind: "olvidar_historial" };
    }
    if (m === "olvidar historial") {
      return { kind: "olvidar_historial_prompt" };
    }
    if (m === "historial" || m === "mi historial" || m === "aprendizajes") {
      return { kind: "historial" };
    }

    const ingreso = m.match(
      /^ingreso\s+(\d+(?:[.,]\d{1,2})?)\s+(.+)$/
    );
    if (ingreso) {
      return {
        kind: "ingreso",
        monto: parseFloat(ingreso[1].replace(",", ".")),
        descripcion: ingreso[2].trim(),
      };
    }

    const transferir = m.match(
      /^transferir\s+(\d+(?:[.,]\d{1,2})?)\s+a\s+(.+)$/
    );
    if (transferir) {
      return {
        kind: "transferir",
        monto: parseFloat(transferir[1].replace(",", ".")),
        cuenta: transferir[2].trim(),
      };
    }

    const clasificar = orig.match(
      /^clasificar\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/i
    );
    if (clasificar) {
      return {
        kind: "clasificar",
        expenseId: clasificar[1],
        categoria: clasificar[2].toLowerCase(),
        subcategoria: clasificar[3]?.toLowerCase(),
      };
    }

    if (m === "pendientes" || m === "clasificar") {
      return { kind: "pendientes" };
    }

    return null;
  }

  // Resuelve un token de periodo a un rango [start, end) + etiqueta legible.
  // Tokens: "hoy", "ayer", "semana"/"esta semana", "mes"/"este mes",
  // "mes pasado"/"mes anterior", o un nombre de mes ("mayo"). Vacío o no
  // reconocido → mes en curso. Semana = lunes..lunes (Perú).
  static resolveQueryPeriod(periodRaw: string): ResolvedPeriod {
    const p = MessageParser.normalizeForMatching(periodRaw);
    const now = new Date();
    const y = now.getFullYear();
    const startOfDay = (d: Date): Date => {
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      return x;
    };
    const monthRange = (year: number, month: number): ResolvedPeriod => ({
      start: new Date(year, month, 1),
      end: new Date(year, month + 1, 1),
      label:
        month === now.getMonth() && year === y ?
          `${MONTH_LABELS[month]} (este mes)` :
          `${MONTH_LABELS[month]} ${year}`,
    });

    if (p === "hoy") {
      const s = startOfDay(now);
      const e = new Date(s);
      e.setDate(e.getDate() + 1);
      return { start: s, end: e, label: "hoy" };
    }
    if (p === "ayer") {
      const e = startOfDay(now);
      const s = new Date(e);
      s.setDate(s.getDate() - 1);
      return { start: s, end: e, label: "ayer" };
    }
    if (p === "semana" || p === "esta semana") {
      const s = startOfDay(now);
      // Lunes como inicio de semana (getDay: 0=domingo).
      const diff = (s.getDay() + 6) % 7;
      s.setDate(s.getDate() - diff);
      const e = new Date(s);
      e.setDate(e.getDate() + 7);
      return { start: s, end: e, label: "esta semana" };
    }
    if (
      p === "mes pasado" ||
      p === "el mes pasado" ||
      p === "mes anterior"
    ) {
      const d = new Date(y, now.getMonth() - 1, 1);
      return monthRange(d.getFullYear(), d.getMonth());
    }
    for (const [name, idx] of Object.entries(MONTHS)) {
      if (p === name || p === `de ${name}`) {
        // Mes futuro en este año → se asume el del año pasado.
        const year = idx > now.getMonth() ? y - 1 : y;
        return monthRange(year, idx);
      }
    }
    // "mes" / "este mes" / vacío / desconocido → mes en curso.
    return monthRange(y, now.getMonth());
  }

  // Frases de periodo, ORDENADAS (más específico primero) para recortar el
  // sufijo correcto de una consulta (ej. "el mes pasado" antes que "mes").
  private static periodPhrases(): string[] {
    return [
      "el mes pasado", "mes pasado", "mes anterior", "este mes",
      "esta semana", "hoy", "ayer", "semana", "mes",
      ...Object.keys(MONTHS).map((n) => `de ${n}`),
      ...Object.keys(MONTHS),
    ];
  }

  // Separa una cola "<...> <periodo>" en [resto, periodoRaw]. Si no hay
  // periodo reconocible, periodoRaw queda "" (→ mes en curso por defecto).
  private static splitTrailingPeriod(text: string): [string, string] {
    for (const ph of MessageParser.periodPhrases()) {
      if (text === ph || text.endsWith(` ${ph}`)) {
        return [text.slice(0, text.length - ph.length).trim(), ph];
      }
    }
    return [text, ""];
  }

  // Consultas de solo-lectura. El bot debe "responder", no solo registrar.
  // Soporta:
  //  - "cuanto gaste [en <cat>] [<periodo>]" / "cuanto llevo <periodo>"
  //  - "resumen <periodo>" (sin periodo → null: lo maneja el resumen legacy)
  //  - "gastos de <periodo>" / "que gaste <periodo>"
  //  - "mis categorias" / "mis cuentas" / "mis metodos de pago"
  static parseQueryCommand(message: string): QueryCommand | null {
    const m = MessageParser.normalizeForMatching(
      message.trim().replace(/^\//, "")
    );

    if (
      /^(que |cuales |mis )?(categorias|categoria)( tengo)?$/.test(m)
    ) {
      return { kind: "categories" };
    }
    if (/^(que |cuales |mis )?cuentas( tengo)?$/.test(m)) {
      return { kind: "accounts" };
    }
    if (
      /^(que |cuales |mis )?(metodos? de pago|metodos)( tengo)?$/.test(m)
    ) {
      return { kind: "payments" };
    }

    // Listado de gastos de un periodo (sin monto → no es un gasto nuevo).
    const list = m.match(
      /^(?:gastos|mis gastos|que gaste|que he gastado)\b\s*(?:de |en )?(.*)$/
    );
    if (list && !/\d/.test(m)) {
      return { kind: "list", periodRaw: list[1].trim() };
    }

    // Monto gastado (+ categoría y/o periodo opcionales).
    const spent = m.match(
      /^(cuanto (?:gaste|he gastado|llevo|va|tengo gastado)|resumen)\b(.*)$/
    );
    if (spent) {
      const verb = spent[1];
      const [afterPeriod, periodRaw] = MessageParser.splitTrailingPeriod(
        spent[2].trim()
      );
      const enCat = afterPeriod.match(/^en (.+)$/);
      const categoria = enCat ? enCat[1].trim() : undefined;
      // "resumen" pelado = resumen histórico legacy (lo maneja otro flujo).
      if (verb === "resumen" && !periodRaw && !categoria) return null;
      return { kind: "spent", periodRaw, categoria };
    }

    return null;
  }

  // Edición del ÚLTIMO gasto, sin IDs. Reconoce:
  //  - borrar/eliminar/anular el último, "deshacer"
  //  - corregir el monto del último ("corregir monto 60", "el último
  //    eran 60", "no, eran 60", "el monto era 60")
  static parseEditCommand(message: string): EditCommand | null {
    const m = MessageParser.normalizeForMatching(
      message.trim().replace(/^\//, "")
    );

    if (
      /^(borrar|eliminar|anular|borra|elimina)( el)?( ultimo)( gasto)?$/
        .test(m) ||
      m === "deshacer" ||
      m === "ultimo gasto borrar"
    ) {
      return { kind: "delete_last" };
    }

    // Captura el monto en frases de corrección del último gasto.
    // OJO: "corrige" tiene raíz "corrig-", "corregir" tiene "correg-".
    const num = "(\\d+(?:[.,]\\d{1,2})?)";
    const verbo =
      "(?:corrige|corregir|corregi|corrijo|cambia|cambiar|cambio)";
    const patterns = [
      new RegExp("^" + verbo + "(?: el)? monto(?: a| en| =| de)? " +
        num + "$"),
      new RegExp("^(?:el )?(?:ultimo|monto)(?: gasto)? " +
        "(?:era|eran|es|fue|fueron) " + num + "$"),
      new RegExp("^no,? ?(?:eran|era|fue|fueron|son) " + num + "$"),
    ];
    for (const re of patterns) {
      const mt = m.match(re);
      if (mt) {
        const monto = parseFloat(mt[1].replace(",", "."));
        if (Number.isFinite(monto)) {
          return { kind: "correct_amount", monto };
        }
      }
    }
    return null;
  }

  // Sí/No para confirmar una acción pendiente. Solo se consulta cuando
  // hay un pending_action activo. null = no es una confirmación.
  static parseConfirmation(message: string): "yes" | "no" | null {
    const m = MessageParser.normalizeForMatching(
      message.trim().replace(/^\//, "")
    );
    if (/^(si|sí|sii+|ya|dale|ok|okey|confirmar|confirmo|correcto|claro)$/
      .test(m)) {
      return "yes";
    }
    if (/^(no|nop|cancelar|cancela|negativo|para|detente)$/.test(m)) {
      return "no";
    }
    return null;
  }

  // ¿El texto tiene pistas de fecha que el regex no cubre? Gate barato
  // para decidir si vale la pena el fallback LLM (ROADMAP § G.1).
  static hasTemporalHint(text: string): boolean {
    const n = MessageParser.normalizeForMatching(text);
    const cues = [
      "hace", "pasad[oa]", "proxim[oa]", "que viene", "anoche",
      "anteanoche", "la semana", "el mes", "el ano pasado",
      "el otro dia", "lunes", "martes", "miercoles", "jueves",
      "viernes", "sabado", "domingo", "fin de semana",
    ];
    return new RegExp(`\\b(${cues.join("|")})\\b`).test(n);
  }

  static parseExpenseFromText(text: string): {
    amount: number;
    description: string;
  } | null {
    const patterns = [
      /(?:gast[eé]|pagu[eé])\s+(\d+(?:\.\d{1,2})?)\s+(?:soles?\s+)?(?:en\s+)?(.+)/i,
      /(\d+(?:\.\d{1,2})?)\s+(?:soles?\s+)?(?:en\s+)?(.+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const amount = parseFloat(match[1]);
        const description = match[2].trim();

        if (!isNaN(amount) && amount > 0 && description) {
          return { amount, description };
        }
      }
    }

    return null;
  }

  static parseAmount(text: string): number | null {
    const patterns = [
      /(\d+\.?\d*)\s*(?:soles?|s\/\.?|pen)/i,
      /s\/\.?\s*(\d+\.?\d*)/i,
      /(\d+\.?\d*)/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const amount = parseFloat(match[1]);
        if (!isNaN(amount) && amount > 0) {
          return amount;
        }
      }
    }

    return null;
  }

  static sanitizeInput(input: string): string {
    if (!input) return "";

    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/[<>]/g, "")
      .trim()
      .substring(0, 500);
  }

  static detectPaymentMethodInText(text: string): string | null {
    const lowerText = text.toLowerCase();

    if (lowerText.includes("yape") || lowerText.includes("con yape")) {
      return "yape";
    }
    if (lowerText.includes("plin") || lowerText.includes("con plin")) {
      return "plin";
    }
    if (lowerText.includes("efectivo") || lowerText.includes("en efectivo")) {
      return "efectivo";
    }
    if (lowerText.includes("transferencia")) {
      return "transferencia";
    }
    if (lowerText.includes("tarjeta")) {
      return "tarjeta";
    }

    return null;
  }
}
