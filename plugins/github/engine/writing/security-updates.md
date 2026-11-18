# Security update pull requests

A pull request that updates dependencies to fix published advisories opens its
description with the first line and the tables below. They take the place of the
summary text, and the four sections of the template in `pull-requests.md` follow:

```
<package>, <package> and <package> to <version> ([<CVE id>](<advisory URL>), [<CVE id>](<advisory URL>))

| | |
|---|---|
| Package | `<vendor/name>` (locked at <old version>, now <new version>) |
| Advisory | <advisory id> / [<CVE id>](<advisory URL>) — <advisory title>, **<severity>** |
| Affected | `<range>`, `<range>` and `<range>` |
| Reference | <advisory URL> |
```

The first line names the packages, the version they move to and every CVE id the
pull request fixes. Then one table per advisory, in the order of the first line, a
blank line between two tables, the header row empty (`| | |`) and the four rows always
Package, Advisory, Affected, Reference. Package: the package in a code span, then its
locked version and the new one, with `dev dependency, ` first when it is one.
Advisory: the advisory's own id as the audit prints it (`PKSA-…`, `GHSA-…`), the CVE
id, the advisory's title, then its severity in bold when the advisory gives one.
Affected: each affected range in its own code span. Reference: the advisory URL, bare.
An advisory with no CVE id puts its GHSA id where the CVE id goes, as a link too.

Every CVE id links to the advisory URL the audit prints for it. `pr-create` and `pr-update`
refuse a bare CVE id, and a first line naming CVE ids without their tables.
