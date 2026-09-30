# Contributor recovery after a coordinated history rewrite

Maintainers must announce the push freeze and the cutover commit/ref list before publishing rewritten branches and tags. History repair is prepared in a private mirror. Sensitive inventories, replacement rules, original bundles, and local-work patches stay outside the public repository. Validate every intended branch/tag and reachable object before cutover; publish only the agreed heads and tags, never auxiliary/private refs.

The current source cleanup does not itself rewrite the public remote. A verified prepared mirror is not evidence that GitHub or npm has been cleaned. Rewriting Git also cannot erase existing forks, clones, downloaded artifacts, or published packages. Inspect release attachments and package distributions separately and use their respective removal procedures when needed.

After maintainers announce completion, contributors should:

1. Preserve local changes and unpublished commits privately. Do not push old branch history.
2. Prefer a fresh clone of the rewritten repository, keeping the old checkout offline as a temporary recovery backup.
3. Apply only the needed source changes to a fresh branch based on the new history. Review patches for unwanted private material before applying them.
4. Reinstall dependencies and rebuild runtime/extension output; generated files are not tracked.
5. Replace stale forks/branches or follow the maintainer's cleanup instructions. Avoid merging an old branch wholesale, which can reintroduce removed objects.

Maintainers retain the private recovery bundle until rewritten refs, releases, and contributor recovery have been checked. Follow [git-filter-repo's official guidance](https://github.com/newren/git-filter-repo/blob/main/Documentation/git-filter-repo.txt) for the coordinated rewrite and fresh-clone workflow.
