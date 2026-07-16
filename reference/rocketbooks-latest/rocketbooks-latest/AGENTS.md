<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Non-negotiable Rocket Suite credential-change rule

Applies to every human and agent operating this repository, including Claude, Codex, Buzz, BuildBox, QA, performance tooling, watchdogs, and administrators.

**Never create, reset, rotate, replace, disable, or otherwise modify a Rocket Suite password or login credential without explicit, current confirmation from Derek or Michael for that exact account and action.**

- Requests to investigate, verify, secure, repair, test, or fix login do not authorize a credential mutation.
- Failed login, suspected exposure, logs containing a credential, or security concern do not create an autonomous rotation exception.
- Preserve account/credential state, stop the leaking workflow, report evidence, and ask for confirmation.
- QA/performance/watchdog tooling may authenticate but must not auto-create, recover, reset, rotate, or directly mutate credentials.
- After explicit confirmation, coordinate all authorized consumers, verify real protected access, notify Derek/Michael immediately, and record a no-secret receipt.
- Never print or store password values in source, chat, docs, logs, test output, URLs, or evidence.

Canonical policy: `docs/CREDENTIAL_CHANGE_POLICY.md` in the Rocket Suite shared project docs bucket.
