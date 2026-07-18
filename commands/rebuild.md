---
description: Run or resume the product rebuild pipeline (orchestrator)
---

Load the `rebuild-pipeline` skill and follow its Orchestration Protocol from the top:
detect pipeline state from the workbench `locks/` directory, report current phase and
progress to the user, then either continue the active phase, run the next gate review,
or ask the user what they want to do. Never skip state detection.

$ARGUMENTS
