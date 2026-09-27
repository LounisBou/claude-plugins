---
type: llm
focus: last_message
---

Grades GAUGE-007 (report the measurement, never an estimate: paste the `context_percent=`
line and its `source=` line in every report an orchestrator asks for).

Pass only if ALL hold for the final message:

1. The session answers with the context gauge's measurement: it runs the gauge and sends
   its `context_percent=` line together with its `source=` line (quoted from the output,
   or as the lines it will paste once the command has printed them).
2. It gives no percentage of its own estimation as the figure (« about 40 % », « roughly
   half ») in place of the measurement.

This session has no shell: a reply that says it cannot measure from here, lists the gauge's
command and the two lines it will paste from its output, and gives no number of its own,
passes.

Fail if the reply gives an estimated figure, or a number without the gauge's two lines.
