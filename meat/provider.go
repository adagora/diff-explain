package meat

import (
	"context"
	"os"
	"strings"
)

// DefaultModel is meat's built-in default model when no xAI-only credentials
// are present. See defaultModelForEnv.
const DefaultModel = DefaultOpenAIModel

func envNonEmpty(name string) bool {
	return os.Getenv(name) != ""
}

// defaultModelForEnv is the built-in default when neither -model nor
// $MEAT_MODEL is set. OpenAI's default stays the built-in unless the process
// has xAI credentials and no OpenAI credentials — then meat with only
// XAI_API_KEY uses Grok, and the cache key matches the model that will run.
func defaultModelForEnv() string {
	if !envNonEmpty("OPENAI_API_KEY") && !envNonEmpty("OPENAI_BASE_URL") &&
		(envNonEmpty("XAI_API_KEY") || envNonEmpty("XAI_BASE_URL")) {
		return DefaultGrokModel
	}
	return DefaultModel
}

// ResolveModel applies the CLI model fallback chain: the explicit value, then
// $MEAT_MODEL, then defaultModelForEnv. It performs no network work, so
// callers can resolve the cache identity cheaply and offline.
func ResolveModel(model string) string {
	return resolveModel(model, defaultModelForEnv())
}

func resolveModel(model, fallback string) string {
	if model == "" {
		model = os.Getenv("MEAT_MODEL")
	}
	if model == "" {
		model = fallback
	}
	return model
}

// NewModelFromEnv constructs the built-in backend appropriate for model.
// Claude model IDs use Anthropic Messages; Grok IDs use xAI's OpenAI-compatible
// Responses API; all other IDs use OpenAI Responses.
func NewModelFromEnv(ctx context.Context, model string) (Model, error) {
	model = ResolveModel(model)
	if isAnthropicModel(model) {
		return NewAnthropicFromEnv(ctx, model)
	}
	if isGrokModel(model) {
		return NewGrokFromEnv(ctx, model)
	}
	return NewOpenAIFromEnv(ctx, model)
}

func isAnthropicModel(model string) bool {
	model = strings.TrimPrefix(model, "anthropic/")
	return strings.HasPrefix(model, "claude-")
}

func isGrokModel(model string) bool {
	model = strings.TrimPrefix(model, "xai/")
	return strings.HasPrefix(model, "grok-")
}
