import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const typesDir = join(process.cwd(), "apps", "desktop", ".next", "types");

let removed = 0;

try {
  for (const entry of readdirSync(typesDir)) {
    if (!/\s[2-9]\.(?:ts|json)$/.test(entry)) {
      continue;
    }

    rmSync(join(typesDir, entry), { force: true });
    removed += 1;
  }
} catch {
  // No generated Next types yet, nothing to clean.
}

console.log(`Removed ${removed} duplicate Next type file(s).`);
