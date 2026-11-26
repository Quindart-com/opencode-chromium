import assert from "node:assert/strict";
import { test } from "bun:test";
import { readPackage, verifyPackage } from "../../src/site-registry/package-read.ts";

test("public package verification and execution bind the package, field, and pinned references", async () => {
  const reply = (name, version, license) => async () => Response.json({ name, version, license, privateField: "fixture-only" });
  assert.deepEqual(await readPackage("lodash", "license", "latest", reply("lodash", "4.0.0", "MIT")), { name: "lodash", license: "MIT" });
  await assert.rejects(() => readPackage("react", "license", "latest", reply("other", "1.0.0", "MIT")), /RESOURCE_MISMATCH/);
  await assert.rejects(() => verifyPackage("license", reply("react", "18.2.0", "Unrelated")), /REFERENCE_MISMATCH/);
  await assert.rejects(() => verifyPackage("version", reply("react", "18.3.0", "MIT")), /RESOURCE_MISMATCH/);
  await assert.rejects(() => readPackage("react", "version", "latest", reply("react", "not a version", "MIT")), /SCHEMA_MISMATCH/);
  await assert.rejects(() => readPackage("@tenant/private", "license", "latest", async () => { throw Error("unexpected upstream call"); }), /UNSUPPORTED/);
});
