// Runs the Khronos glTF validator on .vrm/.glb files and prints errors and warnings.
// The validator lives outside the repo: npm install gltf-validator in ~/dev/gltf-validator.
// Usage: node scripts/validate-gltf.mjs <files...>
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const require = createRequire(homedir() + "/dev/gltf-validator/");
const validator = require("gltf-validator");
let failed = false;
for (const file of process.argv.slice(2)) {
  const report = await validator.validateBytes(new Uint8Array(readFileSync(file)), { maxIssues: 50 });
  const { numErrors, numWarnings, numInfos, messages } = report.issues;
  console.log(`${file}: ${numErrors} errors, ${numWarnings} warnings, ${numInfos} infos`);
  for (const m of messages.filter((m) => m.severity <= 1)) console.log(`  [${m.severity ? "warn" : "ERROR"}] ${m.code} ${m.pointer ?? ""} ${m.message}`);
  failed ||= numErrors > 0;
}
process.exit(failed ? 1 : 0);
