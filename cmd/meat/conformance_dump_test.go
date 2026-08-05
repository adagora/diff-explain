package main

// conformance_dump_test.go is migration scaffolding, not a test of behavior.
// The CLI-side counterpart to meat/conformance_dump_test.go: it pins the two
// surfaces the TypeScript CLI must reproduce exactly — the cache key, which
// determines whether Go and TypeScript builds share cache entries, and the
// -json wire form, which CI bots consume. See migration/CONFORMANCE.md.
//
//	DUMP_VECTORS=conformance/vectors go test ./cmd/meat -run TestDumpCLIConformanceVectors
//
// The path is interpreted relative to the repo root. Delete this file once the
// port is complete.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"meat.dev/meat"
)

func TestDumpCLIConformanceVectors(t *testing.T) {
	dir := os.Getenv("DUMP_VECTORS")
	if dir == "" {
		t.Skip("set DUMP_VECTORS=<dir> to write conformance vectors")
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join("..", "..", dir) // relative to the repo root
	}

	// cacheKey is a NUL-separated SHA-256 over raw bytes, not JSON, so it ports
	// without any serialization-ordering hazard. The empty and multibyte cases
	// are the ones a UTF-16 port gets wrong (H1).
	type keyCase struct {
		Name   string `json:"name"`
		Diff   string `json:"diff"`
		Model  string `json:"model"`
		Rubric string `json:"rubric"`
		Key    string `json:"key"`
	}
	cases := []keyCase{
		{Name: "empty", Diff: "", Model: "", Rubric: ""},
		{Name: "simple", Diff: "diff --git a/x b/x\n", Model: "gpt-5", Rubric: "abcd1234"},
		{Name: "multibyte", Diff: "+// naïve — 日本語\n", Model: "claude-opus-4-8", Rubric: "abcd1234"},
		{Name: "separator-sensitivity-a", Diff: "b", Model: "a", Rubric: ""},
		{Name: "separator-sensitivity-b", Diff: "", Model: "a", Rubric: "b"},
		{Name: "live-rubric", Diff: "diff --git a/x b/x\n", Model: meat.DefaultModel, Rubric: meat.RubricHash()},
	}
	for i := range cases {
		cases[i].Key = cacheKey(cases[i].Diff, cases[i].Model, cases[i].Rubric)
	}
	writeVector(t, dir, "cache-key/cases.json", cases)

	// The -json wire form: snake_case keys, HTML escaping off, elision omitted
	// when empty (omitempty). Each of those is a compatibility contract (H9).
	type renderCase struct {
		Name    string `json:"name"`
		Elision string `json:"elision_input"`
		Output  string `json:"output"`
	}
	results := []struct {
		name    string
		res     meat.Result
		elision string
	}{
		{"full", meat.Result{SmartDiff: "@@ -1 +1 @@\n-a\n+b\n", Summary: "swap a for b", InputTokens: 120, OutputTokens: 34}, "kept 2/9 changed lines in 1/3 files"},
		{"no-elision", meat.Result{SmartDiff: "", Summary: "No changes."}, ""},
		{"html-and-multibyte", meat.Result{SmartDiff: "+if a < b && c > d {\n", Summary: "guard <html> & 日本語", InputTokens: 1, OutputTokens: 2}, "elided all 4 changed lines in 1 files"},
	}
	var out []renderCase
	for _, r := range results {
		var b strings.Builder
		renderJSON(&b, &r.res, r.elision)
		out = append(out, renderCase{Name: r.name, Elision: r.elision, Output: b.String()})
	}
	writeVector(t, dir, "json-wire/cases.json", out)

	t.Logf("wrote CLI vectors to %s", dir)
}

func writeVector(t *testing.T, root, rel string, v any) {
	t.Helper()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir for %s: %v", rel, err)
	}
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		t.Fatalf("encode %s: %v", rel, err)
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}
