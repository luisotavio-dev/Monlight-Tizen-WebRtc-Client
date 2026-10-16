"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

global.window = global;
require("../tizen/update-check.js");
const UpdateCheck = global.UpdateCheck;

const config = fs.readFileSync(path.join(__dirname, "..", "tizen", "config.xml"), "utf8");
assert.ok(config.includes('version="' + UpdateCheck.APP_VERSION + '"'),
  "the version the update check compares must be the one in config.xml");

assert.ok(UpdateCheck.compareVersions("v2.1.0", "2.0.0") > 0, "a leading v is ignored");
assert.ok(UpdateCheck.compareVersions("2.0", "2.0.0") === 0, "a missing patch number is zero");
assert.ok(UpdateCheck.compareVersions("2.0.10", "2.0.9") > 0, "numbers compare numerically");
assert.ok(UpdateCheck.compareVersions("2.0.0", "2.0.0-beta.2") > 0, "a release outranks its pre-releases");
assert.ok(UpdateCheck.compareVersions("2.0.0-beta.10", "2.0.0-beta.2") > 0, "pre-release numbers compare numerically");
assert.ok(UpdateCheck.compareVersions("2.0.0-rc.1", "2.0.0-beta.9") > 0, "pre-release labels compare as text");
assert.strictEqual(UpdateCheck.parseVersion("nightly"), null, "a tag that is not a version is ignored");

assert.deepStrictEqual(UpdateCheck.latestRelease([
  { tag_name: "v2.0.0", draft: false, html_url: "a" },
  { tag_name: "v2.2.0", draft: true, html_url: "draft" },
  { tag_name: "v2.1.0-beta.1", draft: false, prerelease: true, html_url: "b" },
  { tag_name: "nightly", draft: false, html_url: "c" },
]), { version: "2.1.0-beta.1", url: "b" }, "the newest published release wins; drafts and non-versions do not count");
assert.strictEqual(UpdateCheck.latestRelease(null), null, "no releases means no update");

function storage() {
  const values = new Map();
  return {
    getItem: function (key) { return values.has(key) ? values.get(key) : null; },
    setItem: function (key, value) { values.set(key, value); },
  };
}

(async function () {
  let time = 1000;
  let requests = 0;
  let releases = [{ tag_name: "v9.0.0", draft: false, html_url: "new" }];
  const checker = UpdateCheck.create({
    storage: storage(),
    now: function () { return time; },
    fetchJson: function () { requests += 1; return Promise.resolve(releases); },
  });
  assert.deepStrictEqual(await checker.check(), { version: "9.0.0", url: "new" }, "a newer release is announced");
  assert.strictEqual(await checker.check(), null, "GitHub is asked at most once a day");
  assert.strictEqual(requests, 1);
  time += 24 * 60 * 60 * 1000;
  releases = [{ tag_name: "v" + UpdateCheck.APP_VERSION, draft: false, html_url: "same" }];
  assert.strictEqual(await checker.check(), null, "the installed version is not an update");
  assert.strictEqual(requests, 2);

  const offline = UpdateCheck.create({
    storage: storage(),
    fetchJson: function () { return Promise.reject(new Error("network error")); },
  });
  assert.strictEqual(await offline.check(), null, "a TV without internet access sees no error");

  console.log("Tizen update check tests passed");
}()).catch(function (error) {
  console.error(error);
  process.exit(1);
});
