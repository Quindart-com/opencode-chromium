import { expect, test } from "bun:test";
import { fieldsForTask } from "../../src/site-registry/intent.ts";
import { validateSiteRead, storyId } from "../../src/site-registry/client.ts";

test("tasks resolve to the whole requested projection and abstain on unsupported effects", () => {
  expect(fieldsForTask("headline and author")).toEqual(["title", "by"]);
  expect(fieldsForTask("who wrote this story and what is their karma")).toEqual(["by", "karma"]);
  for (const request of ["list comments", "change the title", "the title and my password", "delete post", "article"]) {
    expect(fieldsForTask(request)).toEqual([]);
  }
});

test("relative story selection abstains before resolving a projection", () => {
  for (const task of ["title of the latest story", "latest story score", "author of the newest submission"])
    expect(fieldsForTask(task, 1)).toEqual([]);
  expect(fieldsForTask("title of this story", 1)).toEqual(["title"]);
  expect(fieldsForTask("latest score of this story", 1)).toEqual(["score"]);
});

test("only the exact HTTPS story origin and one unambiguous numeric resource are accepted", () => {
  expect(storyId("https://news.ycombinator.com/item?id=8863")).toBe(8863);
  for (const url of ["https://example.org/item?id=1","http://news.ycombinator.com/item?id=1","https://news.ycombinator.com/item?id=1&id=2","https://news.ycombinator.com/user?id=pg"]) {
    expect(()=>storyId(url)).toThrow("UNSUPPORTED_RESOURCE");
  }
});

test("explicit story references are bound before lookup and responses must be exact projections", () => {
  expect(fieldsForTask("title of story #8863", 8863)).toEqual(["title"]);
  expect(() => fieldsForTask("title of story 8863", 1)).toThrow("SITE_RESOURCE_MISMATCH");
  for (const task of ["title of story 1 and article 1", "title 8863", "title of story 01", "title of story 1/2"])
    expect(fieldsForTask(task, 1)).toEqual([]);
  expect(validateSiteRead({ data: { id: 1, score: 30 } }, 1, ["score"]).data.score).toBe(30);
  for (const data of [{ id: 2, score: 30 }, { id: 1 }, { id: 1, score: "30" }, { id: 1, score: 30, text: "extra" }])
    expect(() => validateSiteRead({ data }, 1, ["score"])).toThrow();
});
