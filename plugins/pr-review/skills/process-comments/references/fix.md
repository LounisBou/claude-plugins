#### 3.7 On "fix & resolve" (option 1) or "fix only" (option 3)

1. **Implement the fix** — apply the code change the user approved
2. **Run tests and coverage** related to the PR:
   ```bash
   # Run the project's test suite (adapt to project)
   # Check test output AND coverage
   ```
   If no test suite is configured, inform the user and ask whether to proceed with the commit.
3. **If tests fail:** Fix the test failures, re-run. Do NOT commit until tests pass.
4. **Commit** with a clean, short message:

   ```bash
   git add <specific-files>
   git commit -m "$(cat <<'EOF'
   <short description of what changed>
   EOF
   )"
   ```

   **Commit message rules:**

   - Use conventional commit prefix: `fix:`, `refactor:`, `style:`, `perf:`, `chore:`, `docs:`, `test:`
   - Example: `fix: validate email field input` or `refactor: extract timeout constant`
   - **NEVER** mention: TODO list, Claude, PR comment, review, conversation, reviewer name
   - Keep it under 72 characters (including prefix)

5. **If option 1 (fix & resolve):** Resolve the thread (`references/resolve.md`), then mark TODO completed
6. **If option 3 (fix only):** Mark TODO completed without resolving. Move to next comment.

| Excuse / error | Reality |
| --- | --- |
| "Tests are probably fine" | Run them. Verify output. Every time. |
| "This change doesn't need tests" | Run them anyway. If none exist, tell the user. |
| Tests fail after fix | Fix test failures before committing; never commit broken code |
