import test from "node:test";
import assert from "node:assert";
import { recordSubmit, stats } from "../src/background/governor.js";
import { get, set } from "../src/lib/storage.js";

test("governor - recordSubmit", async (t) => {
  // Setup mock storage
  const storage = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === "string") return { [keys]: storage[keys] };
          if (Array.isArray(keys)) {
            const res = {};
            for (const k of keys) res[k] = storage[k];
            return res;
          }
          return {};
        },
        set: async (items) => {
          Object.assign(storage, items);
        }
      }
    }
  };

  await t.test("records job identity completely", async () => {
    storage["submitLog"] = [];
    const jobData = {
      site: "linkedin",
      id: "job123",
      title: "Software Engineer",
      company: "Acme Corp",
      url: "https://linkedin.com/jobs/123"
    };

    await recordSubmit(jobData);
    const log = storage["submitLog"];
    assert.strictEqual(log.length, 1);
    
    const record = log[0];
    assert.strictEqual(record.site, "linkedin");
    assert.strictEqual(record.jobId, "job123");
    assert.strictEqual(record.title, "Software Engineer");
    assert.strictEqual(record.company, "Acme Corp");
    assert.strictEqual(record.url, "https://linkedin.com/jobs/123");
    assert.ok(record.at > 0);
  });

  await t.test("increments stats correctly", async () => {
    storage["submitLog"] = [];
    await recordSubmit({ site: "naukri", id: "job1" });
    await recordSubmit({ site: "naukri", id: "job2" });
    
    const s = await stats();
    assert.strictEqual(s.today, 2);
    assert.strictEqual(s.lastHour, 2);
  });

  await t.test("works with missing optional metadata", async () => {
    storage["submitLog"] = [];
    // takeover.js single job fallback gives undefined id but we shouldn't crash
    const jobData = {
      site: "www.naukri.com",
      title: "Fallback Title"
    };
    await recordSubmit(jobData);
    
    const log = storage["submitLog"];
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].title, "Fallback Title");
    assert.strictEqual(log[0].jobId, undefined);
    assert.strictEqual(log[0].site, "www.naukri.com");
  });
});
