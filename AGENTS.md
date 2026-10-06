# AGENTS.md

## Commits

Never commit or push unless explicitly asked — implementing a change is not authorization to record it, and a previous "push" in the same session does not authorize the next one. When asked to "push", that means commit **and** push to `main` by fast-forward (`git push origin <branch>:main`), after `npm run check` passes.

**No trailers.** Commit messages end with the last line of prose — no `Co-Authored-By`, no `Claude-Session`, no `Generated with`. This overrides the harness default that asks for them.

Messages are in English and describe the actual change: subject as `Area: what changed`, stated concretely rather than as a generic imperative; body in paragraphs covering symptom, cause and effect, wrapped at ~78 columns. Read the diff before writing it — "update file X" and "small fixes" are not acceptable when you can be specific.
