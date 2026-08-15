import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubagentChildren,
  cleanTaskLabel,
  createChildClaimer,
} from "./subagent-children.ts";

const names = (args) => buildSubagentChildren(args).map((c) => c.agent);
const ids = (args) => buildSubagentChildren(args).map((c) => c.id);

test("every child of a delegation gets a distinct id", () => {
  // The regression: agent names repeat, so the panel keyed cards on a value
  // that was not unique. Ids must be unique no matter what the names do.
  const cases = [
    { agent: "scout", tasks: [{ task: "a" }, { task: "b" }, { task: "c" }] },
    { tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }] },
    { agents: ["scout", "scout", "worker"] },
    { tasks: [{ task: "a" }, { task: "b" }] },
    { agent: "solo", task: "one" },
  ];
  for (const args of cases) {
    const got = ids(args);
    assert.equal(new Set(got).size, got.length, `duplicate ids for ${JSON.stringify(args)}`);
  }
});

test("a single-agent fanout still repeats the name — ids are what separate them", () => {
  const args = { agent: "scout", tasks: [{ task: "a" }, { task: "b" }, { task: "c" }] };
  assert.deepEqual(names(args), ["scout", "scout", "scout"]);
  assert.deepEqual(ids(args), ["0", "1", "2"]);
});

test("ids follow position across all three delegation shapes", () => {
  assert.deepEqual(ids({ tasks: [{ task: "a" }, { task: "b" }] }), ["0", "1"]);
  assert.deepEqual(ids({ agents: ["a", "b", "c"] }), ["0", "1", "2"]);
  assert.deepEqual(ids({ agent: "solo", task: "t" }), ["0"]);
});

test("management calls and empty args produce no children", () => {
  assert.deepEqual(buildSubagentChildren(undefined), []);
  assert.deepEqual(buildSubagentChildren({}), []);
});

test("workflow runs are named for the workflow when no agent is given", () => {
  const children = buildSubagentChildren({ workflowScript: "return runs.run({ task: 'x' })" });
  assert.equal(children.length, 1);
  assert.equal(children[0].agent, "workflow");
  assert.equal(children[0].id, "0");
});

test("claimer gives each repeated-name row a different child", () => {
  const children = buildSubagentChildren({
    agent: "scout",
    tasks: [{ task: "a" }, { task: "b" }, { task: "c" }],
  });
  const claim = createChildClaimer(children);
  const picked = [claim("scout", 0), claim("scout", 1), claim("scout", 2)];
  assert.deepEqual(picked.map((c) => c.id), ["0", "1", "2"], "each row claims its own child");
  assert.equal(claim("scout", 3), undefined, "nothing left to claim");
});

test("claimer keeps name matching when names are unique and order differs", () => {
  const children = buildSubagentChildren({ agents: ["scout", "worker", "oracle"] });
  const claim = createChildClaimer(children);
  // Server rows arriving out of order still land on the right child by name.
  assert.equal(claim("oracle", 0).agent, "oracle");
  assert.equal(claim("scout", 1).agent, "scout");
  assert.equal(claim("worker", 2).agent, "worker");
});

test("claimer falls back to position for an unknown agent name", () => {
  const children = buildSubagentChildren({ agents: ["scout", "worker"] });
  const claim = createChildClaimer(children);
  assert.equal(claim("stranger", 0).agent, "scout", "unmatched name takes the row's position");
  assert.equal(claim(undefined, 1).agent, "worker");
});

test("cleanTaskLabel unwraps a workflow script into its quoted task", () => {
  assert.equal(cleanTaskLabel("return runs.run({ task: 'audit the api' })"), "audit the api");
  assert.equal(cleanTaskLabel("do the thing\nreturn runs.run({})"), "do the thing");
  assert.equal(cleanTaskLabel(undefined), undefined);
  assert.equal(cleanTaskLabel(""), undefined);
});
