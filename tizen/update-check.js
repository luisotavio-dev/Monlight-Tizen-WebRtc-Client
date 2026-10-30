(function (global) {
  "use strict";

  // Kept equal to the version in config.xml; tests/TizenUpdateCheckTest.js checks that they match.
  const APP_VERSION = "2.2.0";
  const RELEASES_URL = "https://api.github.com/repos/mlopezsegura/moonlight-webrtc-tizen/releases?per_page=20";
  const RELEASES_PAGE = "github.com/mlopezsegura/moonlight-webrtc-tizen/releases";
  const STORAGE_KEY = "moonlight-webrtc.update-check";
  const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

  // "v2.1.0", "2.1" and "2.1.0-beta.2" are versions; anything else is ignored.
  function parseVersion(text) {
    const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/i.exec(String(text || "").trim());
    if (!match) {
      return null;
    }
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3] || 0)],
      prerelease: match[4] ? match[4].split(".") : [],
    };
  }

  function comparePrerelease(left, right) {
    // A release outranks any of its pre-releases.
    if (!left.length || !right.length) {
      return right.length - left.length;
    }
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      if (index >= left.length || index >= right.length) {
        return left.length - right.length;
      }
      const leftNumeric = /^\d+$/.test(left[index]);
      const rightNumeric = /^\d+$/.test(right[index]);
      if (leftNumeric && rightNumeric && Number(left[index]) !== Number(right[index])) {
        return Number(left[index]) - Number(right[index]);
      }
      if (leftNumeric !== rightNumeric) {
        return leftNumeric ? -1 : 1;
      }
      if (left[index] !== right[index]) {
        return left[index] < right[index] ? -1 : 1;
      }
    }
    return 0;
  }

  // Negative, zero or positive as in Array.prototype.sort; unparsable versions sort first.
  function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) {
      return (a ? 1 : 0) - (b ? 1 : 0);
    }
    for (let index = 0; index < 3; index += 1) {
      if (a.numbers[index] !== b.numbers[index]) {
        return a.numbers[index] - b.numbers[index];
      }
    }
    return comparePrerelease(a.prerelease, b.prerelease);
  }

  // The newest published release, pre-releases included, from GitHub's release list.
  function latestRelease(releases) {
    let latest = null;
    (Array.isArray(releases) ? releases : []).forEach(function (release) {
      if (!release || release.draft || !parseVersion(release.tag_name)) {
        return;
      }
      if (!latest || compareVersions(release.tag_name, latest.version) > 0) {
        latest = { version: String(release.tag_name).replace(/^v/i, ""), url: release.html_url || "" };
      }
    });
    return latest;
  }

  function create(options) {
    const storage = options.storage;
    const now = options.now || Date.now;
    const log = options.log || function () {};

    function lastCheck() {
      try {
        const value = JSON.parse(storage.getItem(STORAGE_KEY) || "{}");
        return typeof value.checkedAt === "number" ? value.checkedAt : 0;
      } catch (error) {
        return 0;
      }
    }

    // Resolves to the newer release, or null when there is none, the check ran in the last day,
    // or GitHub cannot be reached; a TV without internet access never sees an error for it.
    function check() {
      // A clock set back since the last check does not postpone the next one.
      const last = lastCheck();
      if (last && now() >= last && now() - last < CHECK_INTERVAL_MS) {
        return Promise.resolve(null);
      }
      return options.fetchJson(RELEASES_URL).then(function (releases) {
        storage.setItem(STORAGE_KEY, JSON.stringify({ checkedAt: now() }));
        const latest = latestRelease(releases);
        return latest && compareVersions(latest.version, APP_VERSION) > 0 ? latest : null;
      }, function (error) {
        log("Update check unavailable: " + (error && error.message ? error.message : String(error)));
        return null;
      });
    }

    return { check: check };
  }

  global.UpdateCheck = {
    APP_VERSION: APP_VERSION,
    RELEASES_PAGE: RELEASES_PAGE,
    parseVersion: parseVersion,
    compareVersions: compareVersions,
    latestRelease: latestRelease,
    create: create,
  };
}(window));
