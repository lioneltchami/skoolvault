type Level = "info" | "warn" | "error" | "debug";

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info(msg: string) {
    console.log(`[${stamp()}] ${msg}`);
  },
  warn(msg: string) {
    console.warn(`[${stamp()}] ⚠ ${msg}`);
  },
  error(msg: string) {
    console.error(`[${stamp()}] ✖ ${msg}`);
  },
  debug(msg: string) {
    if (process.env.SKOOLVAULT_DEBUG) console.log(`[${stamp()}] · ${msg}`);
  },
  step(msg: string) {
    console.log(`\n→ ${msg}`);
  },
  ok(msg: string) {
    console.log(`  ✓ ${msg}`);
  },
  skip(msg: string) {
    console.log(`  ⏭ ${msg}`);
  },
};
