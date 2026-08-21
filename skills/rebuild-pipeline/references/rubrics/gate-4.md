# Gate 4 rubric — contract lock (`contracts/`, including `contracts/data-model/`)

What locks: the data model and the three contract layers. Code is generated from these, code
repos pin the tag, and a breaking change afterwards costs a reopen plus a new gate tag. The
phase already runs a three-pass coherence check and a callee check by hand; this rubric scores
the *artifacts*, not the checks, and it is where a `client-only` transcription gets read for
what it actually claims.

Read: everything under `contracts/`, the lane-D call-site and response-handling findings, and
`findings/ground-truth/reference-erd*.mermaid`.

## D1. Field-level coherence with the lane-D call-site findings

**Asks:** resource-level agreement is easy and hides everything. Does each operation's request
and response *shape* match what the old client was observed to send and read?

- **5** — every field the call-site findings record appears in the contract with a compatible
  type, and every contract field maps to something the client reads, writes, or an
  explicitly-noted addition.
- **3** — the resources line up and a handful of fields do not, with no note saying which
  direction the gap runs.
- **1** — fields were drafted rather than transcribed, so the generated client will send
  shapes the server has never seen.

**Cite below 4:** the operation, the field, and the finding id that disagrees with it.

## D2. Error-contract completeness

**Asks:** what does the client do when it goes wrong? This is the half of a contract that gets
written last and dropped first.

- **5** — every operation declares its failure responses; the error body has one shape across
  the whole contract; the codes the client branches on are enumerated rather than described in
  prose; and auth-expiry and rate-limit behavior are stated.
- **3** — success paths are complete and errors are declared generically (a bare `4XX`), so
  nothing generated from this can distinguish recoverable from fatal.
- **1** — operations declare only their success response.

**Cite below 4:** the operations with missing or generic error declarations.

## D3. Example fidelity

**Asks:** the playbooks forbid mocking with string fixtures pasted from a browser, on the
grounds that fixtures come from the contract's examples so they break when the contract does.
That only works if the examples are real.

- **5** — examples exist for the operations the first slices need, and each was taken from
  an actual response or an actual call site rather than invented to look plausible.
- **3** — examples exist but are illustrative — round numbers, `string`, `2024-01-01` — so a
  test built on them proves shape and nothing else.
- **1** — no examples, or examples that contradict their own schema.

**Cite below 4:** the operations, and for a contradiction, the field.

## D4. Provenance and the inferred-only set (`client-only` only)

**Asks:** does the file say what it is, and are the entries that rest on inference visible?

- **5** — the transcription carries its `description:` provenance line (reference + commit,
  "changes here describe the server, they do not request anything of it"); anything the
  rebuild needs added is in `requested.yaml` and not merged in; and every entry backed only by
  `basis: inferred` evidence is listed in the gate review with what would raise it.
- **3** — provenance is present but the inferred-only entries have not been separated, so the
  lock treats a guess and a transcription identically.
- **1** — requested endpoints are mixed into the transcription, which is how a client gets
  built against something nobody agreed to.

**Cite below 4:** the paths and operations concerned, and the finding ids behind them.

## D5. Data model as the device's model, not the server's (`client-only` only)

**Asks:** does `contracts/data-model/` describe what lives on the device — cached, unsent,
derived — or is it a copy of the server's shape?

- **5** — entities are annotated with why they are local, and the model descends from the old
  client's local schema rather than from the API ERD.
- **3** — the model is defensible but its provenance is not stated, so a later reader cannot
  tell which ERD it came from.
- **1** — it is the server ERD with the names changed, which is how a mobile app ends up doing
  joins on a phone.

**Cite below 4:** the entities and the ERD file they were copied from.
