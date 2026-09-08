# Development triage vocabulary

Use these labels in the [local development tracker](issue-tracker.md). They describe readiness and disposition, independently of implementation progress and the worker product's runtime states.

| Label | Meaning |
| --- | --- |
| `needs-triage` | The request has not yet been assessed against repository facts and scope. |
| `needs-info` | A specific missing fact prevents a sound scope or acceptance decision. Record what is missing. |
| `ready-for-agent` | Scope and acceptance are actionable, required dependencies are satisfied, and execution is within existing authorization. |
| `ready-for-human` | The next required step needs a human decision, credential entry, access or action. Record the exact dependency. |
| `wontfix` | The request is explicitly declined or superseded. Record the decision and replacement when applicable. |

Use one current triage label for new records and retain meaningful decision history. Do not interpret a readiness label as completed implementation or external publication authority. A failed test normally requires investigation and repair; it does not by itself make a task `ready-for-human`.

These are Markdown conventions. They do not create labels in GitHub, GitLab or another external tracker. Preserve established labels in existing records and map their meaning when resuming them.
