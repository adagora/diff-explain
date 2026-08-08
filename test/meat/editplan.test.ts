// Port of meat/editplan_test.go (50 Go tests). One Go test remains deferred:
//  - TestAbridge_AcceptsGitFormatPatch needs Abridge/scriptedModel (meat.ts,
//    item 4n) — port alongside that item.
// TestApplyEditPlan_GitHunkLinesThatResembleFileHeaders is ported below, now
// that both its dependencies (ElisionLine, item 4j) exist.
// TestNumberedDiff is already ported in diff.test.ts (numberedDiff is a
// diff.ts export); not re-ported here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeUTF8, decodeUTF8 } from "../../src/meat/bytes.ts";
import { splitSourceLines } from "../../src/meat/diff.ts";
import {
  compileEditPlan,
  applyEditPlan,
  compileSubmission,
  isElisionProjection,
  type EditPlan,
  type Submission,
} from "../../src/meat/editplan.ts";
import { ElisionLine } from "../../src/meat/elision.ts";

const s = (text: string): Uint8Array => encodeUTF8(text);

const editableDiff =
  "diff --git a/a.go b/a.go\n" +
  "--- a/a.go\n" +
  "+++ b/a.go\n" +
  "@@ -1,2 +1,4 @@\n" +
  " package a\n" +
  '-old := fmt.Errorf("old %s", name)\n' +
  '+new := fmt.Errorf("new %s for %s", name, user)\n' +
  "+copy.UserID = row.userID\n" +
  "+copy.BoxID = int64(row.boxID)\n";

function validSubmission(): Submission {
  return { summary: "Updates error handling and copied fields.", remove: [], replace: [], fold: [] };
}

function emptyPlan(overrides: Partial<EditPlan>): EditPlan {
  return { remove: [], replace: [], fold: [], ...overrides };
}

/** Asserts `fn` throws an Error whose `.message` includes `needle` — Go's `strings.Contains(err.Error(), needle)`. */
function assertRejects(fn: () => unknown, needle?: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, `thrown value is not an Error: ${String(err)}`);
    if (needle !== undefined) {
      assert.ok(err.message.includes(needle), `error = ${JSON.stringify(err.message)}, want to include ${JSON.stringify(needle)}`);
    }
    return true;
  });
}

describe("compileEditPlan — Python fold/removal mechanics (meat/editplan_test.go)", () => {
  test("python fold collapses interior lines to one ellipsis row", () => {
    const raw = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+def rebuild():\n+    setup()\n+    work()\n+    more()\n+    assert done\n");
    const compiled = compileEditPlan(raw, emptyPlan({ fold: [{ startLine: 4, endLine: 6 }] }));
    const want = "diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+def rebuild():\n+    ...\n+    assert done\n";
    assert.equal(decodeUTF8(compiled.smartDiff), want);
    assert.equal(compiled.stats.rawChanged, 5);
    assert.equal(compiled.stats.visibleChanged, 3);
    assert.equal(compiled.stats.foldedChanged, 3);
    assert.equal(compiled.stats.foldCount, 1);
  });

  test("fold preserves marker, indent, and EOL — including CRLF and no trailing newline", () => {
    const raw = s("diff --git a/a.py b/a.py\r\n@@ -1,3 +0,0 @@\r\n-\tdef old():\r\n-\t\tfirst()\r\n-\t\tsecond()");
    const compiled = compileEditPlan(raw, emptyPlan({ fold: [{ startLine: 3, endLine: 5 }] }));
    const want = "diff --git a/a.py b/a.py\r\n@@ -1,3 +0,0 @@\r\n-\t...";
    assert.equal(decodeUTF8(compiled.smartDiff), want);
  });

  test("rejects a fold hiding a definition whose consumer stays visible; interior-only fold is fine", () => {
    const raw = s(
      "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+tests = [\n+    (1, True),\n+    (2, False),\n+]\n+for value, expected in tests:\n+    assert check(value) is expected\n",
    );
    assertRejects(() => compileEditPlan(raw, emptyPlan({ fold: [{ startLine: 3, endLine: 6 }] })), 'hides definition "tests"');
    assertRejects(() => compileEditPlan(raw, emptyPlan({ remove: [{ startLine: 3, endLine: 6 }] })), 'remove: hides definition "tests"');

    const compiled = compileEditPlan(raw, emptyPlan({ fold: [{ startLine: 4, endLine: 5 }] }));
    assert.ok(decodeUTF8(compiled.smartDiff).includes("+tests = [\n+    ...\n+]\n+for value, expected in tests:"));
  });

  test("retained Python suite owner requires an indented body", () => {
    const raw = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+def test_one():\n+    setup()\n+    assert result\n+def test_two():\n+    assert other\n");
    assertRejects(() => compileEditPlan(raw, emptyPlan({ remove: [{ startLine: 4, endLine: 5 }] })), "suite owner on line 3 has no indented body");

    const compiled = compileEditPlan(raw, emptyPlan({ fold: [{ startLine: 4, endLine: 5 }] }));
    assert.ok(decodeUTF8(compiled.smartDiff).includes("+def test_one():\n+    ...\n"));
  });

  test("overlapping Python replacements on one line are rejected", () => {
    const raw = s("diff --git a/a.py b/a.py\n@@ -0,0 +1 @@\n+result = format(name, user)\n");
    assertRejects(
      () =>
        compileEditPlan(
          raw,
          emptyPlan({
            replace: [
              { line: 3, old: "name, user", new: "..." },
              { line: 3, old: "user", new: "..." },
            ],
          }),
        ),
      "overlaps",
    );
  });

  test("rejects replacements on Python decorators and suite headers", () => {
    const raw = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+@decorator\n+def f():\n+    work()\n");
    for (const replacement of [
      { line: 3, old: "@decorator", new: "..." },
      { line: 4, old: "def f():", new: "..." },
    ]) {
      assertRejects(() => compileEditPlan(raw, emptyPlan({ replace: [replacement] })), "structural anchors intact");
    }
  });

  test("preserves Python suite anchors and triple-quote balance", () => {
    const decorated = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+@pytest.mark.slow\n+def test_it():\n+    assert result\n");
    assertRejects(() => compileEditPlan(decorated, emptyPlan({ fold: [{ startLine: 3, endLine: 4 }] })), "decorator or suite owner");
    assertRejects(() => compileEditPlan(decorated, emptyPlan({ remove: [{ startLine: 4, endLine: 5 }] })), "decorator on line 3 has no attached definition");

    const quoted = s('diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+def test_it():\n+    """scenario\n+    stimulus\n+    """\n+    assert result\n');
    assertRejects(() => compileEditPlan(quoted, emptyPlan({ remove: [{ startLine: 6, endLine: 6 }] })), "balanced Python");
    compileEditPlan(quoted, emptyPlan({ remove: [{ startLine: 4, endLine: 6 }] })); // complete docstring removal: must not throw

    assertRejects(() => compileEditPlan(quoted, emptyPlan({ replace: [{ line: 4, old: '"""scenario', new: "..." }] })), "boundary tokens");
  });

  test("Python-specific checks are file-scoped (Objective-C is not mistaken for Python)", () => {
    const objc = s("diff --git a/Foo.m b/Foo.m\n@@ -0,0 +1,2 @@\n+@interface Foo\n+@end\n");
    compileEditPlan(objc, emptyPlan({})); // must not throw
  });

  test("rejects a hidden Python suite owner whose body stays visible", () => {
    const raw = s("diff --git a/a.py b/a.py\n@@ -1,2 +1,2 @@\n def f():\n-    old()\n+    new()\n");
    assertRejects(() => compileEditPlan(raw, emptyPlan({ remove: [{ startLine: 3, endLine: 3 }] })), "hides Python suite owner on line 3");
  });

  test("folds multiline definition arguments but never the owner line itself", () => {
    const raw = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+def build(\n+    first,\n+    second,\n+):\n+    return first\n");
    const compiled = compileEditPlan(raw, emptyPlan({ fold: [{ startLine: 4, endLine: 5 }] }));
    assert.ok(decodeUTF8(compiled.smartDiff).includes("+def build(\n+    ...\n+):\n+    return first"));
    assertRejects(() => compileEditPlan(raw, emptyPlan({ fold: [{ startLine: 3, endLine: 6 }] })), "decorator or suite owner");
  });

  test("docstring delimiter-looking text does not affect Python delimiter balance", () => {
    const raw = s('diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+def explain():\n+    """Example:\n+    foo(\n+    [value]\n+    """\n+    return value\n');
    const compiled = compileEditPlan(raw, emptyPlan({ fold: [{ startLine: 4, endLine: 7 }] }));
    assert.ok(decodeUTF8(compiled.smartDiff).includes("+    ...\n+    return value"));
  });

  test("protects Python backslash continuations from being split", () => {
    const raw = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+value = first + \\\n+    second\n+done = True\n");
    assertRejects(() => compileEditPlan(raw, emptyPlan({ remove: [{ startLine: 4, endLine: 4 }] })), "backslash continuation");
  });

  test("protects context decorators and cross-hunk definitions", () => {
    const contextDecorator = s("diff --git a/a.py b/a.py\n@@ -1,4 +1,4 @@\n @decorator\n def test_it():\n-    old()\n+    new()\n-OLD = 1\n+OLD = 2\n");
    assertRejects(
      () => compileEditPlan(contextDecorator, emptyPlan({ remove: [{ startLine: 4, endLine: 6 }] })),
      "decorator on line 3 has no attached definition",
    );

    const crossHunk = s(
      "diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+tests = [\n+    1,\n+]\n@@ -10,0 +14,2 @@\n+for case in tests:\n+    assert case\n",
    );
    assertRejects(() => compileEditPlan(crossHunk, emptyPlan({ remove: [{ startLine: 2, endLine: 5 }] })), 'hides definition "tests"');
  });

  test("a leading context closer does not disable the reference guard", () => {
    const raw = s(
      "diff --git a/a.py b/a.py\n@@ -1,2 +1,5 @@\n" +
        "     )\n" + // closes a call opened above the hunk
        " \n" +
        "+    request_a = factory.get(path)\n" +
        "+    learn(request_a)\n" +
        "+    assert request_a\n",
    );
    assertRejects(() => compileEditPlan(raw, emptyPlan({ remove: [{ startLine: 5, endLine: 5 }] })), 'hides definition "request_a"');
  });

  test("triple-quote tokens inside ordinary strings are not boundaries", () => {
    const raw = s('diff --git a/a.py b/a.py\n@@ -0,0 +1,2 @@\n+value = \'"""\'\n+keep = 1\n');
    compileEditPlan(raw, emptyPlan({ remove: [{ startLine: 3, endLine: 3 }] })); // must not throw
  });

  test("allows a multiline decorator and a zero-context signature-only hunk", () => {
    const decorator = s(
      'diff --git a/test_a.py b/test_a.py\n@@ -0,0 +1,6 @@\n+@pytest.mark.parametrize(\n+    "x",\n+    [1, 2],\n+)\n+def test_x(x):\n+    assert x\n',
    );
    compileEditPlan(decorator, emptyPlan({})); // identity plan: must not throw
    assertRejects(
      () => compileEditPlan(decorator, emptyPlan({ remove: [{ startLine: 7, endLine: 8 }] })),
      "decorator on line 3 has no attached definition",
    );

    const zeroContext = s("diff --git a/a.py b/a.py\n@@ -10 +10 @@\n-def parse(old):\n+def parse(new):\n");
    compileEditPlan(zeroContext, emptyPlan({})); // must not throw
  });

  test("preserves Python delimiter balance and dotted definitions", () => {
    const multiline = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,4 @@\n+def build(\n+    value,\n+):\n+    return value\n");
    assertRejects(() => compileEditPlan(multiline, emptyPlan({ fold: [{ startLine: 4, endLine: 5 }] })), "delimiter balance");
    assertRejects(() => compileEditPlan(multiline, emptyPlan({ remove: [{ startLine: 6, endLine: 6 }] })), "suite owner on line 3 has no indented body");

    const dotted = s(
      "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+self.tests = [\n+    1,\n+]\n+for case in self.tests:\n+    assert case\n+done = True\n",
    );
    assertRejects(() => compileEditPlan(dotted, emptyPlan({ fold: [{ startLine: 3, endLine: 5 }] })), 'hides definition "self.tests"');
  });

  test("protects Python suite owners with trailing comments", () => {
    const raw = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,3 @@\n+def helper():  # setup helper\n+    return 1\n+result = 1\n");
    assertRejects(() => compileEditPlan(raw, emptyPlan({ fold: [{ startLine: 3, endLine: 4 }] })), "suite owner");
    assertRejects(() => compileEditPlan(raw, emptyPlan({ remove: [{ startLine: 4, endLine: 4 }] })), "suite owner on line 3 has no indented body");
  });

  test("allows folding the interior of a keyword-argument call", () => {
    const raw = s(
      "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+def fetch(timeout):\n+    return request(\n+        timeout=timeout,\n+        retries=3,\n+    )\n+done = True\n",
    );
    const compiled = compileEditPlan(raw, emptyPlan({ fold: [{ startLine: 5, endLine: 6 }] }));
    assert.ok(decodeUTF8(compiled.smartDiff).includes("+        ..."));
  });

  test("hidden regions cannot cross adjacent call or string boundaries", () => {
    const calls = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+x = first(\n+    1,\n+)\n+y = second(\n+    2,\n+)\n");
    assertRejects(() => compileEditPlan(calls, emptyPlan({ fold: [{ startLine: 5, endLine: 6 }] })), "crosses new-side expression");

    const stringsDiff = s('diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+x = """\n+first\n+"""\n+y = """\n+second\n+"""\n');
    assertRejects(() => compileEditPlan(stringsDiff, emptyPlan({ fold: [{ startLine: 5, endLine: 6 }] })), "crosses new-side expression or string boundaries");
  });

  test("protects multiline if-owners and except* owners", () => {
    const multilineIf = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,4 @@\n+if (\n+    condition\n+):\n+    work()\n");
    assertRejects(() => compileEditPlan(multilineIf, emptyPlan({ fold: [{ startLine: 3, endLine: 5 }] })), "suite owner");

    const exceptStar = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,2 @@\n+except* ValueError:\n+    recover()\n");
    assertRejects(() => compileEditPlan(exceptStar, emptyPlan({ remove: [{ startLine: 3, endLine: 3 }] })), "hides Python suite owner");
  });

  test("fold-aware owner scanning", () => {
    const contextDef = s("diff --git a/a.py b/a.py\n@@ -1,3 +1,2 @@\n def f():\n-    old_one()\n-    old_two()\n+    new()\n");
    compileEditPlan(contextDef, emptyPlan({ fold: [{ startLine: 4, endLine: 5 }] })); // deleted-side fold under context owner: must not throw
    assertRejects(
      () => compileEditPlan(contextDef, emptyPlan({ remove: [{ startLine: 3, endLine: 3 }], fold: [{ startLine: 4, endLine: 5 }] })),
      "hides Python suite owner",
    );

    const decorator = s(
      "diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+@mark(\n+    first,\n+    second,\n+)\n+def f():\n+    work()\n",
    );
    compileEditPlan(decorator, emptyPlan({ fold: [{ startLine: 4, endLine: 5 }] })); // multiline decorator argument fold: must not throw
  });

  test("Python classification ignores content that only looks like code inside a string", () => {
    const docstring = s('diff --git a/a.py b/a.py\n@@ -0,0 +1,6 @@\n+def f():\n+    """Notes:\n+    if flag:\n+    @decorator\n+    """\n+    return 1\n');
    compileEditPlan(docstring, emptyPlan({ fold: [{ startLine: 5, endLine: 6 }] })); // must not throw

    const stringConsumer = s('diff --git a/a.py b/a.py\n@@ -0,0 +1,5 @@\n+tests = [\n+    1,\n+]\n+print("tests completed")\n+done = True\n');
    compileEditPlan(stringConsumer, emptyPlan({ fold: [{ startLine: 3, endLine: 5 }] })); // must not throw
  });

  test("a comment-only suite body is not semantic — the suite still needs real body", () => {
    const raw = s("diff --git a/a.py b/a.py\n@@ -0,0 +1,4 @@\n+def f():\n+    # explanation\n+    work()\n+done = True\n");
    assertRejects(() => compileEditPlan(raw, emptyPlan({ remove: [{ startLine: 5, endLine: 5 }] })), "no indented body");
  });
});

describe("compileEditPlan — invalid folds (meat/editplan_test.go:357-388)", () => {
  const raw = s("diff --git a/a.py b/a.py\n@@ -1,2 +1,4 @@\n-old()\n+new()\n+other()\n+third()\n context\n");
  const cases: Array<{ name: string; plan: Partial<EditPlan>; needle: string }> = [
    { name: "one line", plan: { fold: [{ startLine: 3, endLine: 3 }] }, needle: "at least two" },
    { name: "mixed polarity", plan: { fold: [{ startLine: 3, endLine: 4 }] }, needle: "mixed diff markers" },
    { name: "metadata", plan: { fold: [{ startLine: 2, endLine: 3 }] }, needle: "not source" },
    { name: "remove overlap", plan: { remove: [{ startLine: 4, endLine: 4 }], fold: [{ startLine: 4, endLine: 5 }] }, needle: "overlaps remove" },
    { name: "fold overlap", plan: { fold: [{ startLine: 4, endLine: 5 }, { startLine: 5, endLine: 6 }] }, needle: "overlaps fold" },
    {
      name: "replace overlap",
      plan: { replace: [{ line: 4, old: "new", new: "..." }], fold: [{ startLine: 4, endLine: 5 }] },
      needle: "also folded",
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      assertRejects(() => compileEditPlan(raw, emptyPlan(tc.plan)), tc.needle);
    });
  }
});

describe("isElisionProjection (meat/editplan_test.go:390-409)", () => {
  const cases: Array<{ old: string; new: string; want: boolean }> = [
    { old: ".sshKeyID", new: "...", want: true },
    { old: "new", new: "n...", want: true },
    { old: "prefix middle suffix", new: "prefix ... suffix", want: true },
    { old: "if !allowed", new: "if allowed", want: false },
    { old: "safe()", new: "dangerousCall()", want: false },
    { old: "user", new: "user...", want: false }, // ellipsis must hide something
    { old: "x", new: "....", want: false }, // only exactly ... or … is a placeholder
    { old: "xy", new: "...…", want: false }, // adjacent placeholders are meaningless
    { old: "same", new: "same", want: false },
  ];
  for (const tc of cases) {
    test(`isElisionProjection(${JSON.stringify(tc.old)}, ${JSON.stringify(tc.new)}) === ${tc.want}`, () => {
      assert.equal(isElisionProjection(s(tc.old), s(tc.new)), tc.want);
    });
  }
});

describe("applyEditPlan (meat/editplan_test.go:411-923)", () => {
  test("rubric field projection", () => {
    const raw = s("diff --git a/a.go b/a.go\n@@ -0,0 +1 @@\n+resp.SSHKeyID = rd.sshKeyID\n");
    const got = applyEditPlan(raw, {
      summary: "Copies route metadata.",
      remove: [],
      fold: [],
      replace: [{ line: 3, old: ".sshKeyID", new: "..." }],
    });
    assert.ok(decodeUTF8(got).includes("+resp.SSHKeyID = rd...\n"));
  });

  test("removal and local replacement", () => {
    const inn: Submission = {
      ...validSubmission(),
      remove: [{ startLine: 9, endLine: 9 }],
      replace: [{ line: 7, old: '"new %s for %s", name, user', new: "..." }],
    };
    const got = applyEditPlan(s(editableDiff), inn);
    const want =
      "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,4 @@\n package a\n-old := fmt.Errorf(\"old %s\", name)\n+new := fmt.Errorf(...)\n+copy.UserID = row.userID\n";
    assert.equal(decodeUTF8(got), want);
  });

  test("identity plan is a no-op; removing everything yields an empty diff", () => {
    const inn = validSubmission();
    const got = applyEditPlan(s(editableDiff), inn);
    assert.equal(decodeUTF8(got), editableDiff);

    const got2 = applyEditPlan(s(editableDiff), { ...inn, remove: [{ startLine: 1, endLine: 9 }] });
    assert.equal(decodeUTF8(got2), "");
  });

  test("remove/replace coordinates refer to the original diff", () => {
    const inn: Submission = {
      ...validSubmission(),
      remove: [{ startLine: 6, endLine: 6 }, { startLine: 8, endLine: 9 }],
      replace: [{ line: 7, old: "name, user", new: "..." }],
    };
    const got = applyEditPlan(s(editableDiff), inn);
    const want = 'diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,4 @@\n package a\n+new := fmt.Errorf("new %s for %s", ...)\n';
    assert.equal(decodeUTF8(got), want);
  });

  test("preserves line endings, including a missing final newline", () => {
    const raw = s("diff --git a/a b/a\r\n@@ -1 +1 @@\r\n-old\r\n+new"); // no final newline
    const inn: Submission = {
      summary: "Changes the value.",
      remove: [{ startLine: 3, endLine: 3 }],
      replace: [{ line: 4, old: "new", new: "n..." }],
      fold: [],
    };
    const got = applyEditPlan(raw, inn);
    assert.equal(decodeUTF8(got), "diff --git a/a b/a\r\n@@ -1 +1 @@\r\n+n...");
  });

  describe("rejects invalid removals", () => {
    const cases: Array<{ name: string; remove: Array<{ startLine: number; endLine: number }> }> = [
      { name: "zero", remove: [{ startLine: 0, endLine: 1 }] },
      { name: "reversed", remove: [{ startLine: 3, endLine: 2 }] },
      { name: "past end", remove: [{ startLine: 9, endLine: 10 }] },
      { name: "overlap", remove: [{ startLine: 2, endLine: 4 }, { startLine: 4, endLine: 5 }] },
    ];
    for (const tc of cases) {
      test(tc.name, () => {
        const inn = { ...validSubmission(), remove: tc.remove };
        assertRejects(() => applyEditPlan(s(editableDiff), inn));
      });
    }
  });

  test("reports a remove-range overlap exactly once per offending range", () => {
    const raw = s("line\n".repeat(1000));
    const inn: Submission = {
      summary: "Elides repeated text.",
      remove: [{ startLine: 1, endLine: 900 }, { startLine: 100, endLine: 800 }],
      replace: [],
      fold: [],
    };
    assertRejects(() => applyEditPlan(raw, inn));
    try {
      applyEditPlan(raw, inn);
      assert.fail("want overlapping range error");
    } catch (err) {
      assert.ok(err instanceof Error);
      const count = err.message.split("overlaps an earlier range").length - 1;
      assert.equal(count, 1, `overlap diagnostics = ${count}, want one per range: ${err.message}`);
    }
  });

  test("aggregates structural errors across independent files", () => {
    const raw = s(
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-old2\n+new2\n",
    );
    const inn: Submission = {
      summary: "Changes two values.",
      remove: [{ startLine: 1, endLine: 1 }, { startLine: 7, endLine: 7 }],
      replace: [],
      fold: [],
    };
    try {
      applyEditPlan(raw, inn);
      assert.fail("want structural errors");
    } catch (err) {
      assert.ok(err instanceof Error);
      const count = err.message.split("diff header").length - 1;
      assert.equal(count, 2, `aggregated diff-header errors = ${count}, want 2:\n${err.message}`);
    }
  });

  describe("rejects one-sided rename/copy metadata", () => {
    const cases = [
      { name: "rename", raw: "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n" },
      { name: "copy", raw: "diff --git a/old b/new\nsimilarity index 100%\ncopy from old\ncopy to new\n" },
    ];
    for (const tc of cases) {
      test(tc.name, () => {
        const inn: Submission = { summary: "Moves the file.", remove: [{ startLine: 3, endLine: 3 }], replace: [], fold: [] };
        assertRejects(() => applyEditPlan(s(tc.raw), inn), "must be removed or retained together");
      });
    }
  });

  test("rejects an index-only file shell", () => {
    const raw = s("diff --git a/a b/a\nindex 123..456 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n");
    const inn: Submission = { summary: "Elides the file change.", remove: [{ startLine: 3, endLine: 7 }], replace: [], fold: [] };
    assertRejects(() => applyEditPlan(raw, inn), "retains only metadata");
  });

  describe("rejects orphaned structure", () => {
    const cases: Array<{ name: string; remove: Array<{ startLine: number; endLine: number }> }> = [
      { name: "diff header", remove: [{ startLine: 1, endLine: 1 }] },
      { name: "old file header", remove: [{ startLine: 2, endLine: 2 }] },
      { name: "new file header", remove: [{ startLine: 3, endLine: 3 }] },
      { name: "hunk header", remove: [{ startLine: 4, endLine: 4 }] },
      { name: "orphaned context", remove: [{ startLine: 4, endLine: 4 }, { startLine: 6, endLine: 9 }] },
      { name: "empty hunk header", remove: [{ startLine: 5, endLine: 9 }] },
      { name: "context-only hunk", remove: [{ startLine: 6, endLine: 9 }] },
      { name: "empty file headers", remove: [{ startLine: 4, endLine: 9 }] },
      { name: "empty diff header", remove: [{ startLine: 2, endLine: 9 }] },
    ];
    for (const tc of cases) {
      test(tc.name, () => {
        const inn = { ...validSubmission(), remove: tc.remove };
        assertRejects(() => applyEditPlan(s(editableDiff), inn));
      });
    }
  });

  test("allows a complete hunk or a complete file to be removed", () => {
    const raw = s("diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-old\n+new\n@@ -5 +5 @@\n-old2\n+new2\n");
    const inn: Submission = { summary: "Changes the second value.", remove: [{ startLine: 4, endLine: 6 }], replace: [], fold: [] };
    const got = applyEditPlan(raw, inn);
    assert.equal(decodeUTF8(got), "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -5 +5 @@\n-old2\n+new2\n");

    const got2 = applyEditPlan(raw, { ...inn, remove: [{ startLine: 1, endLine: 9 }] });
    assert.equal(decodeUTF8(got2), "");
  });

  test("rejects an orphaned no-newline marker; allows removing owner and marker together", () => {
    const raw = s("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n");
    const inn: Submission = { summary: "Changes the value.", remove: [{ startLine: 5, endLine: 5 }], replace: [], fold: [] };
    assertRejects(() => applyEditPlan(raw, inn));

    const got = applyEditPlan(raw, { ...inn, remove: [{ startLine: 5, endLine: 6 }] });
    const decoded = decodeUTF8(got);
    assert.ok(!decoded.includes("No newline"));
    assert.ok(decoded.includes("+new"));
  });

  test("protects headers in a concatenated unified diff with no diff --git separators", () => {
    const raw = "--- a/one.go\n+++ b/one.go\n@@ -1 +1 @@\n-old\n+new\n--- a/two.go\n+++ b/two.go\n@@ -1 +1 @@\n-old2\n+new2\n";
    for (const candidate of [raw, raw.replace("@@ -1 +1 @@", "@@"), raw.replace("@@ -1 +1 @@", "@@ -1,3 +1,3 @@")]) {
      const inn: Submission = {
        summary: "Changes two values.",
        remove: [],
        replace: [{ line: 6, old: "a/two.go", new: "a/..." }],
        fold: [],
      };
      assertRejects(() => applyEditPlan(s(candidate), inn));
    }

    const inn: Submission = { summary: "Changes one value.", remove: [{ startLine: 6, endLine: 10 }], replace: [], fold: [] };
    const got = applyEditPlan(s(raw), inn);
    const decoded = decodeUTF8(got);
    assert.ok(!decoded.includes("two.go"));
    assert.ok(decoded.includes("+new"));
  });

  describe("rejects invalid replacements", () => {
    const cases: Array<{ name: string; replace: { line: number; old: string; new: string }; remove?: Array<{ startLine: number; endLine: number }> }> = [
      { name: "outside diff", replace: { line: 10, old: "x", new: "..." } },
      { name: "empty old", replace: { line: 7, old: "", new: "..." } },
      { name: "metadata", replace: { line: 1, old: "a/a.go", new: "..." } },
      { name: "hunk header", replace: { line: 4, old: "-1,4", new: "..." } },
      { name: "removed line", replace: { line: 7, old: "name", new: "..." }, remove: [{ startLine: 7, endLine: 7 }] },
      { name: "missing old", replace: { line: 7, old: "not present", new: "..." } },
      { name: "ambiguous old", replace: { line: 7, old: "%s", new: "..." } },
      { name: "newline old", replace: { line: 7, old: "name\n", new: "..." } },
      { name: "newline new", replace: { line: 7, old: "name, user", new: "x\ny" } },
      { name: "invented new", replace: { line: 7, old: "name, user", new: "dangerousCall()" } },
      { name: "no-op new", replace: { line: 7, old: "name", new: "name" } },
    ];
    for (const tc of cases) {
      test(tc.name, () => {
        const inn = { ...validSubmission(), remove: tc.remove ?? [], replace: [tc.replace] };
        assertRejects(() => applyEditPlan(s(editableDiff), inn));
      });
    }
  });

  test("rejects overlapping occurrences of old on the same line", () => {
    const raw = s("diff --git a/a b/a\n@@ -1 +1 @@\n+aaa\n");
    const inn: Submission = { summary: "Adds repeated text.", remove: [], fold: [], replace: [{ line: 3, old: "aa", new: "..." }] };
    assertRejects(() => applyEditPlan(raw, inn));
  });

  test("allows multiple disjoint replacements on one line", () => {
    const inn = {
      ...validSubmission(),
      replace: [
        { line: 7, old: "name", new: "..." },
        { line: 7, old: "user", new: "u..." },
      ],
    };
    const got = applyEditPlan(s(editableDiff), inn);
    assert.ok(decodeUTF8(got).includes('+new := fmt.Errorf("new %s for %s", ..., u...)'));
  });

  test("rejects overlapping replacements on one line", () => {
    const inn = {
      ...validSubmission(),
      replace: [
        { line: 7, old: "name, user", new: "..." },
        { line: 7, old: "user", new: "..." },
      ],
    };
    assertRejects(() => applyEditPlan(s(editableDiff), inn));
  });

  test("allows a replacement on a context line inside a hunk", () => {
    const inn = { ...validSubmission(), replace: [{ line: 5, old: "package a", new: "package ..." }] };
    const got = applyEditPlan(s(editableDiff), inn);
    assert.ok(decodeUTF8(got).includes(" package ...\n"));
  });

  test("compileSubmission aggregates summary and plan errors", () => {
    try {
      compileSubmission(s(editableDiff), { summary: "", remove: [], fold: [], replace: [{ line: 999, old: "x", new: "..." }] });
      assert.fail("want summary and plan errors");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("summary must not be empty"));
      assert.ok(err.message.includes("outside the diff"));
    }
  });

  test("validateSummary rejects empty, whitespace-only, multiline, and control-character summaries", () => {
    for (const bad of ["", "   ", "two\nlines", "two\rlines", "escape\x1b[31m", "line break"]) {
      const inn = { ...validSubmission(), summary: bad };
      assertRejects(() => applyEditPlan(s(editableDiff), inn));
    }
  });

  test("a real Git diff whose hunk body reads like --- /+++ file headers is not misparsed; identity plan is a no-op and a real edit still targets the right line (meat/editplan_test.go:709-764)", async (t) => {
    const gitCheck = spawnSync("git", ["--version"]);
    if (gitCheck.error) {
      t.skip("git not found");
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "meat-editplan-"));
    await writeFile(join(dir, "old.go"), "-- a/foo\n");
    await writeFile(join(dir, "new.go"), "++ b/foo\n");
    const diff = spawnSync("git", ["diff", "--no-index", "--", "old.go", "new.go"], { cwd: dir, encoding: "utf8" });
    // `git diff --no-index` exits 1 when the files differ — that is success here, not a failure.
    assert.equal(diff.status, 1, `git diff --no-index: ${diff.stderr}`);
    const rawText = diff.stdout;
    assert.ok(rawText.includes("\n--- a/foo\n+++ b/foo\n"), `git did not produce the ambiguous-looking hunk fixture:\n${rawText}`);
    const raw = s(rawText);

    const identity: Submission = { summary: "Changes decrement to increment.", remove: [], replace: [], fold: [] };
    const identityGot = applyEditPlan(raw, identity);
    assert.equal(decodeUTF8(identityGot), rawText, "identity plan changed Git-generated diff");

    assert.equal(ElisionLine(raw, raw), "kept 2/2 changed lines in 1/1 files");

    let oldLine = 0;
    let newLine = 0;
    splitSourceLines(raw).forEach((line, i) => {
      const text = decodeUTF8(line.text);
      if (text === "--- a/foo") oldLine = i + 1;
      if (text === "+++ b/foo") newLine = i + 1;
    });
    assert.ok(oldLine !== 0 && newLine !== 0, "ambiguous-looking hunk lines not found");

    const real: Submission = {
      summary: "Changes decrement to increment.",
      remove: [{ startLine: oldLine, endLine: oldLine }],
      replace: [{ line: newLine, old: "b/foo", new: "..." }],
      fold: [],
    };
    const realGot = decodeUTF8(applyEditPlan(raw, real));
    assert.ok(!realGot.includes("--- a/foo") && realGot.includes("+++ ..."), `real edit plan not applied to Git-generated hunk:\n${realGot}`);
  });
});
