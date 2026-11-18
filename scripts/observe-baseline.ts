// Reproducible local baseline: full legacy packet vs the first inventory page.
// Synthetic evidence avoids private source and never dispatches a model.
import { collectSnapshot, hashBytes } from "../src/cli/snapshot.ts";
import { observeSnapshot, inventoryArtifact, evidenceArtifact } from "../src/cli/observe.ts";
import { formatReviewPrompt } from "../src/cli/prompt.ts";

const raw = Buffer.from(Array.from({ length: 120 }, (_, file) =>
  `diff --git a/file-${file}.ts b/file-${file}.ts\n--- a/file-${file}.ts\n+++ b/file-${file}.ts\n@@ -1,20 +1,20 @@\n` +
  Array.from({ length: 20 }, (_, line) => `-const value${line} = ${line};\n+const value${line} = ${line + 1};\n`).join(""),
).join(""));
const snapshot = await collectSnapshot([], false, false, { stdinIsPiped: () => true, readAllStdin: async () => raw });
const observation = observeSnapshot(snapshot);
const inventory = inventoryArtifact(observation);
let pages = 0;
let entries = 0;
let cursor = "";
do {
  const page = inventoryArtifact(observation, 20, cursor);
  pages++;
  entries += page.entries.length;
  cursor = page.page.next ?? "";
} while (cursor !== "");
const file = observation.entries.find(entry => entry.kind === "file")!;
const evidence = evidenceArtifact(observation, file.id);
const reconstructed = Buffer.from(evidence.data, "base64");
if (entries !== observation.entries.length || hashBytes(reconstructed) !== hashBytes(raw.subarray(file.range.byte_start, file.range.byte_end))) {
  throw new Error("Baseline evidence did not reconcile");
}
process.stdout.write(JSON.stringify({ schema: "meat.observe.baseline", version: 1,
  fixture: "120 files, 20 changed declarations per file", input_digest: snapshot.input_digest,
  input_bytes: raw.length, numbered_bytes: observation.numberedBytes,
  legacy_full_packet_bytes: Buffer.byteLength(formatReviewPrompt(raw, "stdin")),
  first_inventory_page_bytes: Buffer.byteLength(JSON.stringify(inventory) + "\n"),
  inventory_entries: entries, inventory_pages: pages, expanded_file_bytes: reconstructed.length,
  reconstruction: "exact", model_calls: 0, elapsed_time: "not_measured", semantic_review_quality: "not_measured",
}) + "\n");
