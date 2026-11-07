# Screenshot checklist

The one checklist every capture of a frontend surface is audited against, by the implementer before delivery, by the review round, and by the screenshots agent before the verdict. Each image is opened and audited on its own, against every point:

- edges aligned with their neighbours
- icons and text centred in their controls
- no stray text left in an input
- nothing truncated and nothing overflowing
- no unexpected extra row or space
- each control consistent with the controls beside it
- both viewports

The audit writes one line per image, `<image>: clean` or `<image>: <the defect>`. A capture that shows a defect is never a pass: the defect is fixed, the capture retaken, and audited again.
