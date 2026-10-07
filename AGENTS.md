# Contributor and agent contract

- Inspect this file and any applicable nested instructions before changing files. Respect existing patterns and the approved scope; never discard another contributor's work.
- Start new work from an up-to-date `master` on a meaningful feature/fix branch, never `master` or `main`. An already-authorized task on its feature branch may continue there.
- Never commit or push directly to `master`. Submit a PR targeting `master` with a clear summary, checks actually run, and risks/limitations. Obtain human review and approval; only a human may authorize and perform the merge. Agents must not approve or merge their own PRs.
- Do not bypass required checks/review, force-push, or change repository settings, permissions or branch protections. Branch protections enforce these rules; this document alone does not.
- Source package major/minor changes require a human-reviewed PR, keeping package/lock metadata consistent. CI alone derives the numeric patch from the workflow run number in its temporary checkout; do not commit CI version bumps.
- Successful `master` push builds automatically tag and publish their exact checked artifacts. PR/manual runs cannot publish. Agents must not create tags or releases by hand, move tags, replace release assets or self-promote candidates. Inspect failed/partial releases through human review rather than bypassing guards.
- For authorized GitHub operations, use the default approved GitHub App helper/identity, not a personal token or identity. Report verification honestly; automated checks do not establish manual live Teams or clean-VM QA.
