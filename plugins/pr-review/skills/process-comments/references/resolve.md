## Step 4: Resolve a Comment

Resolution depends on comment type:

**For review threads** (type = `review-thread`), with the thread's `PRRT_` id:

```json
{"command": "thread-resolve", "args": {"thread_id": "<PRRT_ id>", "format": "resolve-status"}}
```

**For issue comments** (type = `issue-comment`), minimized by the comment's `node_id` (`IC_...`):

```json
{"command": "comment-resolve", "args": {"node_id": "<node_id>", "format": "error-check"}}
```

**For review body comments** (type = `review-body`), minimized by the review's node id (`PRR_...`):

```json
{"command": "comment-resolve", "args": {"node_id": "<node_id>", "format": "error-check"}}
```

**If resolution fails** (permissions, invalid ID): Inform the user and suggest they resolve it manually in the GitHub UI.

| Error | Solution |
| --- | --- |
| `Could not resolve to a node` | Use `PRRT_` thread ID, not `PRRC_` comment ID |
| `Resource not accessible` | User lacks write access; suggest manual resolution |
