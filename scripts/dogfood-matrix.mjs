import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pins = JSON.parse(await readFile(path.join(root, "tests", "dogfood", "compiler-versions.json"), "utf8"));
for (const role of ["minimum", "latest"]) {
  const pin = pins[role];
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin.version) || !/^[a-f0-9]{64}$/i.test(pin.linuxX64Sha256)) {
    throw new Error(`Invalid ${role} Bend dogfood compiler pin.`);
  }
}
const versions = [...new Set([pins.minimum.version, pins.latest.version])];
console.log(`versions=${JSON.stringify(versions)}`);
