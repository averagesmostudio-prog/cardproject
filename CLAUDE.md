# CLAUDE.md

Instructions for AI agents (Claude Code or otherwise) working in this repository.

## Repository

- Remote: `https://github.com/averagesmostudio-prog/cardproject.git`
- Default branch: `main`, tracks `origin/main`
- Auth: an HTTPS Personal Access Token is stored in the macOS Keychain via `credential.helper osxkeychain` (set locally on this repo, not globally). Never embed a token in `.git/config`, a commit, or any tracked file — if push auth ever breaks, ask the user for a new token rather than hardcoding one anywhere.

## What NOT to commit

- `node_modules/`, `dist/`, `release/` — dependencies and build output, already in `.gitignore`.
- `print_sheet*.png` — generated sample print sheets; these run 10s of MB and are test output, not source. Already gitignored.
- Any `.env` file, API key, or token.
- Run `git status` before staging and review the file list. Don't `git add -A` or `git add .` blindly — add files by name.

## Commit workflow

1. Only commit when the user explicitly asks. Don't commit proactively after every edit.
2. Stage specific files by name rather than everything in the working tree.
3. Commit messages: 1-2 sentences, explain *why* the change was made, imperative mood.
4. Every commit message ends with:
   ```
   Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
   ```
5. Always make a new commit — never `git commit --amend` unless the user explicitly asks for it.
6. Never skip hooks or signing (`--no-verify`, `--no-gpg-sign`).

## Push workflow

- Push only when the user explicitly asks ("push this", "sync to GitHub", etc.).
- `main` already tracks `origin/main`, so a plain `git push` is enough once committed.
- Never force-push without explicit, per-instance confirmation from the user.

## Pull requests

If asked to open a PR, use `gh pr create` and end the description with:
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
