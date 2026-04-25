# Example: Settings

Place this file at `.lgtm/settings.json` in your project root.

```json
{
  "maxReviewLoops": 100,
  "model": "amazon-bedrock/anthropic.claude-opus-4-6-v1"
}
```

## Settings reference

| Setting          | Type        | Default                                       | Description                                  |
| ---------------- | ----------- | --------------------------------------------- | -------------------------------------------- |
| `maxReviewLoops` | integer > 0 | 100                                           | Max review→fix→review cycles before stopping |
| `model`          | string      | `amazon-bedrock/anthropic.claude-opus-4-6-v1` | Reviewer model in `provider/model-id` format |
