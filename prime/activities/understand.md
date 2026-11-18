# Understand

Answer the user's actual question about the current program using source evidence.

1. Locate the relevant entry point and trace its inputs, transformations, state,
   outputs, and side effects. Read nearby types, contracts and representative
   tests. Expand outward when a missing caller or dependency changes the answer.
2. Cite the paths and definitions that establish the behavior. Distinguish what
   the code does, what comments claim, and what you infer about intent. Surface
   conflicting documentation or missing context explicitly.
3. Explain the behavior in the user's terms. Use a short call tree, before/after
   example, or diagram only if it clarifies a real relationship. Name the important
   boundary or tradeoff, rather than listing every file you opened.
4. For change-oriented questions, inspect the original diff and the relevant
   before/after code. Ordinary architecture questions do not need a diff packet,
   API call, graph database, or compiler invocation.

Done when the user has an evidence-backed explanation and knows what could not
be established. This activity does not authorize implementation, dependency
installation, external messages, or changes to project policy.
