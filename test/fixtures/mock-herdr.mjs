#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2); const record = process.env.MOCK_HERDR_RECORD;
if (record) appendFileSync(record, `${JSON.stringify(args)}\n`);
if (args[0] === "--version") { console.log("herdr mock 1.0"); process.exit(0); }
if (args[0] === "tab" && args[1] === "create") { console.log(JSON.stringify({ result: { tab: { tab_id: "mock-tab" }, root_pane: { pane_id: "mock-pane", tab_id: "mock-tab" } } })); process.exit(0); }
if ((args[0] === "pane" && ["run", "close", "report-agent", "release-agent"].includes(args[1])) || (args[0] === "tab" && args[1] === "close")) process.exit(0);
console.error(`unsupported mock Herdr argv: ${JSON.stringify(args)}`); process.exit(2);
