#!/usr/bin/env bash
# Verify the public surface is type-consumable from the *packaged* tarball,
# exactly as an external developer would consume it — no workspace privileges,
# no publish round-trip.
#
#   1. npm pack        — triggers prepack -> build:types -> dist/public.d.ts
#   2. self-containment guard — the emitted .d.ts carries no #src/* aliases
#   3. install the tarball into a throwaway consumer and run tsc against it
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. Pack the real tarball (prepack regenerates the declaration) --------
(cd "$PKG_DIR" && npm pack --pack-destination "$WORK" >/dev/null)
TARBALL="$(ls "$WORK"/*.tgz | head -n1)"
echo "Packed: $(basename "$TARBALL")"

# --- 2. Self-containment guard on the emitted declarations -----------------
DTS="$PKG_DIR/dist/public.d.ts"
if grep -q '#src' "$DTS"; then
  echo "FAIL: dist/public.d.ts still references #src/* (not self-contained)" >&2
  grep -n '#src' "$DTS" >&2
  exit 1
fi
for sym in getSubagentsService WorkspaceProvider SubagentsService SubagentRecord SubagentModelIdentity LifetimeUsage Workspace WorkspacePrepareContext WorkspaceDisposeOutcome WorkspaceDisposeResult; do
  grep -q "$sym" "$DTS" || { echo "FAIL: '$sym' missing from dist/public.d.ts" >&2; exit 1; }
done
echo "OK: dist/public.d.ts is self-contained and exports the public surface"

SETTINGS_DTS="$PKG_DIR/dist/settings.d.ts"
if grep -q '#src' "$SETTINGS_DTS"; then
  echo "FAIL: dist/settings.d.ts still references #src/* (not self-contained)" >&2
  grep -n '#src' "$SETTINGS_DTS" >&2
  exit 1
fi
for sym in loadLayeredSettings LayeredSettingsSource; do
  grep -q "$sym" "$SETTINGS_DTS" || { echo "FAIL: '$sym' missing from dist/settings.d.ts" >&2; exit 1; }
done
echo "OK: dist/settings.d.ts is self-contained and exports the settings surface"

# --- 3. Build a throwaway consumer and type-check it against the tarball ----
CONSUMER="$WORK/consumer"
mkdir -p "$CONSUMER"

cat > "$CONSUMER/package.json" <<'JSON'
{ "name": "consumer", "version": "0.0.0", "private": true, "type": "module" }
JSON

cat > "$CONSUMER/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["probe.ts"]
}
JSON

cat > "$CONSUMER/probe.ts" <<'TS'
import {
  getSubagentsService,
  type Workspace,
  type WorkspaceDisposeOutcome,
  type WorkspaceDisposeResult,
  type WorkspacePrepareContext,
  type WorkspaceProvider,
  type SubagentModelIdentity,
  type SubagentRecord,
} from "pi-bstn-subagents";

// Exercise the value export and all workspace collaborator type exports.
const provider: WorkspaceProvider = {
  async prepare(ctx: WorkspacePrepareContext): Promise<Workspace | undefined> {
    const workspace: Workspace = {
      cwd: ctx.baseCwd,
      dispose(_outcome: WorkspaceDisposeOutcome): WorkspaceDisposeResult | undefined {
        return undefined;
      },
    };
    return workspace;
  },
};

void provider;
void getSubagentsService;

const model: SubagentModelIdentity = {
  backend: "cursor",
  displayName: "Auto",
  value: "auto",
};
const record: Pick<SubagentRecord, "model"> = { model };
void record;
TS

cat > "$CONSUMER/probe-settings.ts" <<'TS'
import { loadLayeredSettings, type LayeredSettingsSource } from "pi-bstn-subagents/settings";

interface MyConfig { enabled?: boolean; limit?: number }

function sanitize(raw: unknown): Partial<MyConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<MyConfig> = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (typeof r.limit === "number") out.limit = r.limit;
  return out;
}

const source: LayeredSettingsSource<MyConfig> = {
  agentDir: "/tmp/agent",
  cwd: "/tmp/project",
  filename: "my-extension.json",
  sanitize,
  warnLabel: "my-extension",
};

const config: Partial<MyConfig> = loadLayeredSettings(source);
void config;
TS

# Install the packaged tarball plus the peer deps a real consumer would have.
npm --prefix "$CONSUMER" install --ignore-scripts \
  "$TARBALL" \
  "@earendil-works/pi-ai@0.80.7" \
  "@earendil-works/pi-coding-agent@0.80.7" \
  "@earendil-works/pi-tui@0.80.7" \
  typescript@5.9.3 >/dev/null

# Update the tsconfig to include both probe files.
cat > "$CONSUMER/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["probe.ts", "probe-settings.ts"]
}
JSON

# Use the workspace TypeScript against the consumer project; module resolution
# starts from the probe files, so the tarball and peers resolve from the consumer's
# own node_modules via the package's exports "types" condition.
"$CONSUMER/node_modules/.bin/tsc" -p "$CONSUMER/tsconfig.json"
echo "OK: external consumer type-checks against packaged pi-bstn-subagents"
