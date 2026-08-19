package meat

import "testing"

// TestResolveModel pins the precedence the cache key depends on: an explicit
// model wins, then $MEAT_MODEL, then the built-in default — OpenAI, or Grok
// when only xAI credentials are set.
func TestResolveModel(t *testing.T) {
	t.Run("explicit wins over env", func(t *testing.T) {
		t.Setenv("MEAT_MODEL", "env-model")
		if got := ResolveModel("explicit"); got != "explicit" {
			t.Errorf("ResolveModel(explicit) = %q, want explicit", got)
		}
	})
	t.Run("env used when no explicit", func(t *testing.T) {
		t.Setenv("MEAT_MODEL", "env-model")
		if got := ResolveModel(""); got != "env-model" {
			t.Errorf("ResolveModel(\"\") = %q, want env-model", got)
		}
	})
	t.Run("default when nothing set", func(t *testing.T) {
		t.Setenv("MEAT_MODEL", "")
		t.Setenv("OPENAI_API_KEY", "")
		t.Setenv("OPENAI_BASE_URL", "")
		t.Setenv("XAI_API_KEY", "")
		t.Setenv("XAI_BASE_URL", "")
		if got := ResolveModel(""); got != DefaultModel {
			t.Errorf("ResolveModel(\"\") = %q, want %q", got, DefaultModel)
		}
	})
	t.Run("xai key alone defaults to grok-4.6", func(t *testing.T) {
		t.Setenv("MEAT_MODEL", "")
		t.Setenv("OPENAI_API_KEY", "")
		t.Setenv("OPENAI_BASE_URL", "")
		t.Setenv("XAI_API_KEY", "xai-only")
		t.Setenv("XAI_BASE_URL", "")
		if got := ResolveModel(""); got != DefaultGrokModel {
			t.Errorf("ResolveModel(\"\") = %q, want %q", got, DefaultGrokModel)
		}
		if got := ResolveModel(""); got != "grok-4.6" {
			t.Errorf("ResolveModel(\"\") = %q, want grok-4.6", got)
		}
	})
	t.Run("openai key wins the default over xai", func(t *testing.T) {
		t.Setenv("MEAT_MODEL", "")
		t.Setenv("OPENAI_API_KEY", "sk-openai")
		t.Setenv("XAI_API_KEY", "xai-also")
		if got := ResolveModel(""); got != DefaultModel {
			t.Errorf("ResolveModel(\"\") = %q, want %q", got, DefaultModel)
		}
	})
}

func TestIsGrokModel(t *testing.T) {
	if !isGrokModel("grok-4.6") {
		t.Error("grok-4.6 should be Grok")
	}
	if !isGrokModel("xai/grok-4.6") {
		t.Error("xai/grok-4.6 should be Grok")
	}
	if isGrokModel("gpt-5.6-sol") {
		t.Error("gpt-5.6-sol should not be Grok")
	}
	if isGrokModel("xai/xai/grok-4.6") {
		t.Error("only one xai/ prefix is stripped")
	}
	if isGrokModel("grok") {
		t.Error("grok without hyphen should not be Grok")
	}
}
