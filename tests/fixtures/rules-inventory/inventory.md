# Fixture inventory

| id | rule | sources | kind | criticality | enforced-by | fate | target | signature |
|---|---|---|---|---|---|---|---|---|
| FIX-001 | Every agent ends each report with its measured context. | alpha.md:3 | rule | critical | prose | keep | alpha.md | reports its measured context at the end |
| FIX-002 | A session never waits on an unverified message. | alpha.md:5, beta.md:3 | rule | normal | prose | keep | alpha.md | never waits on a message it has not verified |
| FIX-003 | A rule holding a pipe \| is read as one cell. | alpha.md:7 | fact | normal | prose | merge->FIX-001 | alpha.md | inside a rule without shifting any column |
| FIX-004 | The operator's word comes first. | beta.md:3 | rule | critical | prose | move->beta.md | beta.md | and no other part overrides it |
| FIX-005 | A rule proposed for removal. | beta.md:5 | rule | normal | prose | drop? | beta.md | this sentence is in no target file |
