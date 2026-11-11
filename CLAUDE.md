# TraceRoost MCP

Before any task: call get_recent_sessions (recent work + cost) and get_workspace_patterns (hot files, recurring issues).

## Establishing scope before starting

Before making changes on a non-trivial task, check that you know:
- **Goal**: what "done" looks like (behavior, test passing, doc updated, PR opened)
- **Boundaries**: which packages/files are in scope
- **Constraints**: whether to commit/push/release, and any compatibility or API limits
- **Verification**: how the result should be checked (tests, running the extension, manual steps)

If any of these is ambiguous *and* a wrong guess would mean real rework, ask one
short batch of questions up front, all at once, with a recommended default for each.
Don't ask when the answer can be found in the code, git history, or runbooks, or when a
sensible default exists. In those cases, state your assumption in one line and proceed.

If scope changes mid-task (new files, a different approach, an unexpected
blocker), pause and confirm before expanding the work.

## Writing style

No em dashes (—) in anything a person reads: UI copy, CLI and log output, error messages, the
CHANGELOG and Markdown docs. Use a comma, colon, semicolon, parentheses or a new sentence. A lone
`—` as an empty-value placeholder in a table or chart is fine, and so are code comments.

## Recurring maintenance tasks

Check `runbooks/README.md` for periodic maintenance tasks (e.g. refreshing model pricing) that may be relevant or due.
