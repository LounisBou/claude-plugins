---
# intent: keeping a product's prompts under a token limit, not this session's fill
max_turns: 5
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---

Our app sends the whole chat history to the model on each call. Write a function that trims the oldest messages so the prompt stays under 100k tokens.
