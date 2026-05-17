// Side-effect: fija la zona horaria del proceso a Perú (UTC-5, sin
// horario de verano) ANTES de que cualquier otro módulo evalúe fechas.
// Cloud Run ya la inyecta vía `TZ` en `.env` (seteada antes de arrancar
// Node); esto es defensa en profundidad para runtimes/contextos donde la
// env no se aplique (scripts, futuros runtimes). DEBE importarse PRIMERO
// en src/index.ts. Sin esto, "hoy/ayer/semana/mes" se calculan en UTC y
// tras las 19:00 hora Perú "hoy" salta de día (bug de filtrado).
process.env.TZ = process.env.TZ || "America/Lima";
