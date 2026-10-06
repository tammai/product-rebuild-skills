# product-rebuild-skills

## Code comments

Match the surrounding code first. Where there is no precedent, follow what the scripts in
`skills/rebuild-pipeline/scripts/` and `hooks/scripts/` already do:

- **Open every script with a header comment**: what it does and why it exists, including why it
  is a script or hook rather than a line in a doc.
- **Explain why, not what.** Name the failure or constraint behind the code ("a rebuild once did
  X, so this now does Y"). Do not restate what the next line does.
- **Put a rationale where the decision lives**, beside the value it justifies (`ROLE_TIERS`
  carries a `why:` per role).
- **Say when two things must change together** ("copied, not imported — if you change one,
  change both").
- **Be exact about edge cases**: name the condition ("fails open when the marker is missing").
- **Inline comments only where the logic is not obvious.** No narration, no commented-out code.
