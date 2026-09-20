# Decision records

Append-only and chronological. A record's number is its citation — plans, code
comments and other records point at it — so numbers are never reused or
reassigned, and a record is superseded by a later one rather than edited or
removed.

Each carries an **area** so a log covering more than one concern stays
navigable. Mirrors the convention `traceroost/cloud/docs/decisions/` already
uses.

| #                                                           | Area  | Decision                                                                                                                                        | In force                                                              |
| ------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [0001](0001-session-list-pagination.md) | scale | The primary Sessions list stays client-side-paginated over a fully-loaded array rather than gaining DB-level `LIMIT`/`OFFSET`, per a stress test at realistic multi-year history size. | Yes. Revisit if a real DB export or listSessions() profile regresses. |
| [0002](0002-model-cost-per-outcome-comparator-scope.md) | product | The model/agent cost-per-outcome comparator is cloud-only from day one, not a local/free feature — real local session history shows near-zero within-agent model diversity per repo, so a single developer's history structurally lacks the "same task, different model" pairs the comparison needs. | Yes. Revisit only if a `cloud` design for the cross-developer version is scoped. |

## Writing a new one

Take the next number. Keep it short: context, decision, consequences — and
where a decision closes an open question in `.staged-issues/`, say which one,
so the plan and the record cannot drift.

State the current position only. A record that has been superseded says so at
the top and names the record that replaced it; it does not get edited to
agree with it.
