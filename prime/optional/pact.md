# PACT and columbo

columbo uses PACT's ideas about review evidence in its own local instructions.
The shared policy covers three review areas, snapshot identity, source-backed
findings and verification. Fixing findings follows the normal Work path.

| PACT activity | columbo's local equivalent |
|---|---|
| Coding pass | Work |
| Review pass | Review |
| Internal fix/review loop | Work (Converge compatibility entry) |
| Repository-wide investigation | Audit, a columbo activity |
| Landing and merging | Follow the target project's separate policy |

columbo does not emit PACT markers or enforce PACT's cross-vendor merge gate.
Its default review is in the current session and can run sequentially. Findings
use the local priorities in `review-policy.md`; PACT marker priorities retain
whatever meaning their pinned contract assigns. Local results are not PACT votes.

## Upstream source

Inspected on 2026-11-17: fastxyz/pact commit
`72c68ef77a941d2ac6ab4ae4b22319992ddd02e1`, whose contract reports v1.3.0.
See [provenance](../provenance.json) for inspected paths and hashes. That commit
has no license file and its README's license section says TBD. columbo's local
policy is newly written; the package does not include PACT documents or scripts.

Source: [pinned PACT README](https://github.com/fastxyz/pact/blob/72c68ef77a941d2ac6ab4ae4b22319992ddd02e1/README.md).

## If a target project adopts full PACT

Read that project's explicit version pin, canonical contract, command and runner
adapter. Use the same pinned version throughout. Resolve contradictory adapter
instructions against that contract before running commands.

At the inspected version, PACT's landing evidence includes clean reviews from two
vendors on the same HEAD, current CI and a separate landing check. Local test
results do not override failed CI. A landing result must distinguish a tested
synthetic merge commit from an unavailable or untested one.

columbo does not infer authorization to post markers, push, launch another vendor
or merge. Follow the user's request and project policy. Do not import the
archived Prime checklist as an up-to-date substitute for the pinned contract.
