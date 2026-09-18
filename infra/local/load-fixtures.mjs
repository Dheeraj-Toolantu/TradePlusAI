import { readFile } from "node:fs/promises";

const file = process.argv[process.argv.indexOf("--file") + 1] ?? "tests/fixtures/trading-session.json";
const fixture = JSON.parse(await readFile(file, "utf8"));
console.log(`Loaded ${fixture.indices.length} index fixtures in ${fixture.mode} mode`);