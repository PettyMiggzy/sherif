// ─────────────────────────────────────────────────────────────────────────────
// Keeper heartbeat — a liveness file the keeper container writes and the API container reads.
//
// WHY: the keepers run in their OWN container (`keeper` in docker-compose), separate from the one that
// serves /health. So the API could report a perfectly healthy indexer while every keeper beside it was
// dead, and the only symptom would be coins quietly never graduating — which is exactly the failure this
// stack cannot afford to discover late. `restart: unless-stopped` covers a CRASH; it does nothing for a
// keeper that is running but wedged, or one that never started because a key was missing from .env.
//
// The two containers share the `indexer-data` volume (both mount it at /app/data), so a file there is the
// simplest channel between them that needs no ports, no network and no new dependency.
//
// Written atomically (temp + rename) so a reader can never catch a half-written file.
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import { CFG } from "./config.js";

const FILE = path.join(path.dirname(CFG.dbPath), "keeper-heartbeat.json");

/// Record that the keeper loop is alive and what it is configured to do. Cheap enough to call every poll.
/// Never throws: a keeper must not die because its liveness file could not be written.
export function beat(fields = {}) {
  try {
    const body = JSON.stringify({ at: Date.now(), ...fields });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, FILE);           // atomic on the same filesystem
  } catch { /* liveness reporting is never worth killing the keeper over */ }
}

/// Read the last heartbeat. Returns null if the keeper has never run (no file) or the file is unreadable.
/// `ageSecs` is what actually matters — a stale timestamp is a dead keeper even though the file exists.
export function read() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!j || typeof j.at !== "number") return null;
    return { ...j, ageSecs: Math.round((Date.now() - j.at) / 1000) };
  } catch { return null; }
}
