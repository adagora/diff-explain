package meat

// conformance_dump_test.go is migration scaffolding, not a test of behavior.
//
// It renders every deterministic (model-free, network-free) stage of the
// abridging pipeline over the diff corpus already in this repo and writes the
// results as language-neutral vectors, so the TypeScript port can be graded
// against exact Go output rather than against specs derived from itself. See
// migration/CONFORMANCE.md.
//
// It is purely additive, gated on an environment variable, and changes no
// behavior. It follows the existing UPDATE_GOLDEN=1 convention.
//
//	DUMP_VECTORS=conformance/vectors go test ./meat -run TestDumpConformanceVectors
//
// The path is interpreted relative to the repo root. Delete this file once the
// port is complete.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// diffLineKindNames and sourceLanguageNames make the layout vectors
// self-describing: the port asserts against stable names, not against Go's
// iota ordering, which is an implementation detail it must not inherit.
var diffLineKindNames = map[diffLineKind]string{
	diffLineOther:         "other",
	diffLineHeader:        "header",
	diffLineIndex:         "index",
	diffLineRenameFrom:    "rename_from",
	diffLineRenameTo:      "rename_to",
	diffLineCopyFrom:      "copy_from",
	diffLineCopyTo:        "copy_to",
	diffLineMailSignature: "mail_signature",
	diffLineOldFile:       "old_file",
	diffLineNewFile:       "new_file",
	diffLineHunkHeader:    "hunk_header",
	diffLineHunkContext:   "hunk_context",
	diffLineHunkChange:    "hunk_change",
	diffLineNoNewline:     "no_newline",
}

var sourceLanguageNames = map[sourceLanguage]string{
	sourceLanguageUnknown:    "unknown",
	sourceLanguageGo:         "go",
	sourceLanguagePython:     "python",
	sourceLanguageJavaScript: "javascript",
	sourceLanguageRust:       "rust",
	sourceLanguageC:          "c",
	sourceLanguageJava:       "java",
}

// splitBudgets force real chunking on small fixtures, the same trick
// singleRunDiffBytes uses in the chunking tests.
var splitBudgets = []int{2048, 4096, 8192, 16384}

type corpusEntry struct {
	name string
	path string
	raw  string
}

// loadCorpus gathers every unified diff already checked into the repo. The
// analysis/ diffs are recorded evaluation data, not ported code, but they are a
// free multi-language corpus: Go and Rust exercise import-detection paths the
// Python testdata never reaches.
func loadCorpus(t *testing.T) []corpusEntry {
	t.Helper()
	globs := []string{
		"testdata/python/*.diff",
		"../analysis/*/*.original.diff",
		"../analysis/*/*.live.diff",
	}
	var out []corpusEntry
	for _, g := range globs {
		paths, err := filepath.Glob(g)
		if err != nil {
			t.Fatalf("glob %s: %v", g, err)
		}
		for _, p := range paths {
			if strings.HasSuffix(p, ".golden.diff") {
				continue // an output, not an input
			}
			b, err := os.ReadFile(p)
			if err != nil {
				t.Fatalf("read %s: %v", p, err)
			}
			name := strings.TrimSuffix(filepath.Base(p), ".diff")
			out = append(out, corpusEntry{name: name, path: p, raw: string(b)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	if len(out) == 0 {
		t.Fatal("empty corpus: no diffs found")
	}
	return out
}

func TestDumpConformanceVectors(t *testing.T) {
	dir := os.Getenv("DUMP_VECTORS")
	if dir == "" {
		t.Skip("set DUMP_VECTORS=<dir> to write conformance vectors")
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join("..", dir) // interpret relative to the repo root
	}

	corpus := loadCorpus(t)
	w := &vectorWriter{t: t, root: dir}

	// 1. The frozen prompt surface. The hash is the cheapest high-value check
	//    in the project; the full text is what you diff when it mismatches.
	w.text("prompt-surface.txt", promptSurface())
	w.text("rubric-hash.txt", RubricHash())
	w.text("protocol-version.txt", abridgeProtocolVersion)

	// 2. Per-diff deterministic stages.
	for _, c := range corpus {
		lines := splitSourceLines(c.raw)
		layout := analyzeDiff(lines)

		// 2a. Layout: the foundation every later stage reads.
		kinds := make([]string, len(lines))
		langs := make([]string, len(lines))
		for i := range lines {
			kinds[i] = diffLineKindNames[layout.kinds[i]]
			langs[i] = sourceLanguageNames[layout.language[i]]
		}
		problems := make([]string, 0, len(layout.problems))
		for _, p := range layout.problems {
			problems = append(problems, p.Error())
		}
		w.json("diff-layout/"+c.name+".json", map[string]any{
			"source":       c.path,
			"line_count":   len(lines),
			"kinds":        kinds,
			"languages":    langs,
			"python":       layout.python,
			"file_id":      layout.fileID,
			"hunk_id":      layout.hunkID,
			"marker_owner": layout.markerOwner,
			"problems":     problems,
		})

		// 2b. Line terminators are carried per line, not normalized. CRLF
		//     survival is pinned by TestSplitDiff_PreservesCRLF.
		eols := make([]string, len(lines))
		for i, l := range lines {
			eols[i] = l.eol
		}
		w.json("source-lines/"+c.name+".json", map[string]any{
			"eols": eols,
		})

		// 2c. Validation: accept/reject plus exact message text.
		w.text("validate/"+c.name+".txt", errText(validateSupportedDiff(c.raw)))

		// 2d. The numbered form sent to the model.
		w.text("numbered/"+c.name+".txt", numberedDiff(c.raw))

		// 2e. Move detection: a whole-diff property. H7 tie-breaking lives here.
		w.json("moves/"+c.name+".json", detectedMovesInDiff(c.raw))

		// 2f. The compiler-owned mandatory import mask.
		w.json("imports/"+c.name+".json", mandatoryImportRemovalPlan(lines, layout))

		// 2g. Splitting, at budgets small enough to force real cuts.
		fits := map[string]bool{}
		for _, b := range splitBudgets {
			key := fmt.Sprintf("b%d", b)
			fits[key] = fitsSingleRun(c.raw, b)

			chunks, err := splitDiffForAbridging(c.raw, b)
			if err != nil {
				w.text(fmt.Sprintf("split/%s.%s.error.txt", c.name, key), err.Error())
				continue
			}
			out := make([]map[string]any, len(chunks))
			for i, ch := range chunks {
				out[i] = map[string]any{
					"text":        ch.text,
					"meta_prefix": ch.metaPrefix,
					"section_id":  ch.sectionID,
				}
			}
			w.json(fmt.Sprintf("split/%s.%s.json", c.name, key), out)
		}
		w.json("fits-single-run/"+c.name+".json", fits)
	}

	// 3. Plan compilation over the checked-in golden plans. This is the whole
	//    rendering pipeline end to end, and it is hermetic — no model.
	planPaths, err := filepath.Glob("testdata/python/*.plan.json")
	if err != nil {
		t.Fatalf("glob plans: %v", err)
	}
	sort.Strings(planPaths)
	for _, pp := range planPaths {
		base := strings.TrimSuffix(filepath.Base(pp), ".plan.json")
		rawBytes, err := os.ReadFile(filepath.Join("testdata/python", base+".diff"))
		if err != nil {
			t.Fatalf("read diff for %s: %v", base, err)
		}
		planBytes, err := os.ReadFile(pp)
		if err != nil {
			t.Fatalf("read %s: %v", pp, err)
		}
		var sub submission
		if err := json.Unmarshal(planBytes, &sub); err != nil {
			t.Fatalf("decode %s: %v", pp, err)
		}
		raw := string(rawBytes)
		compiled, cerr := compileEditPlan(raw, sub.plan())
		w.json("plan-compile/"+base+".json", map[string]any{
			"error":      errText(cerr),
			"smart_diff": compiled.smartDiff,
			"moves":      compiled.moves,
		})
		// The elision manifest is computed locally from both diffs, never
		// reported by the model.
		w.text("elision/"+base+".txt", ElisionLine(raw, compiled.smartDiff))
	}

	// 4. Provider wire serialization. Guards H4: ProviderData must be replayed
	//    byte-for-byte, which a JSON.parse round-trip would silently break.
	w.dumpOpenAIRequest()

	t.Logf("wrote %d vectors to %s", w.count, dir)
}

// dumpOpenAIRequest serializes a fixed conversation containing an opaque
// provider_state block. The fixture's odd spacing and number formatting are
// deliberate: a port that round-trips through JSON.parse/stringify will
// normalize them and fail this vector, which is exactly the point.
func (w *vectorWriter) dumpOpenAIRequest() {
	raw := json.RawMessage(`{"type":"reasoning","id":"rs_1","encrypted_content":"AAAA","summary":[ ],"n":1.0}`)
	messages := []Message{
		{Role: RoleUser, Content: []Block{textBlock("abridge this")}},
		{Role: RoleAssistant, Content: []Block{
			{Type: "provider_state", Provider: "openai", ProviderData: raw},
			{Type: "tool_use", ID: "call_1", ToolName: "read_file", ToolInput: json.RawMessage(`{"path":"a/b.go"}`)},
		}},
		{Role: RoleUser, Content: []Block{
			{Type: "tool_result", ToolUseID: "call_1", ToolResult: "package a\n", ToolError: false},
		}},
	}
	items, err := toOpenAIInput(messages)
	if err != nil {
		w.t.Fatalf("toOpenAIInput: %v", err)
	}
	strs := make([]string, len(items))
	for i, it := range items {
		strs[i] = string(it) // exact bytes, not re-marshaled
	}
	w.json("openai-request/replay.json", map[string]any{
		"input_bytes": strs,
	})
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

type vectorWriter struct {
	t     *testing.T
	root  string
	count int
}

func (w *vectorWriter) write(rel string, data []byte) {
	w.t.Helper()
	path := filepath.Join(w.root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		w.t.Fatalf("mkdir for %s: %v", rel, err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		w.t.Fatalf("write %s: %v", rel, err)
	}
	w.count++
}

func (w *vectorWriter) text(rel, s string) { w.write(rel, []byte(s)) }

func (w *vectorWriter) json(rel string, v any) {
	w.t.Helper()
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false) // match the CLI's -json wire form
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		w.t.Fatalf("encode %s: %v", rel, err)
	}
	w.write(rel, []byte(b.String()))
}
