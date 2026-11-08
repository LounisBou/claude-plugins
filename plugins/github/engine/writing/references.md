# References

## References to pull requests and issues

Name a pull request or an issue with its repository, always: `infra#195`,
`api#1778`. Never a bare `#195`, never « PR #15 », and every item of a list
carries its prefix, even in a table whose column names the repository. One number
exists in several repositories and a bare one can send a merge or a review to the
wrong PR. Only the formats GitHub resolves inside its own repository keep `(#N)`: a
squashed commit title, a PR body, where a `PRs Dependency` or `Related PRs` item is the
pull request's full URL.
