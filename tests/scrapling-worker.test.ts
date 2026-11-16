import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdtempSync } from "node:fs";

const fixtureDir = join("tests", "fixtures", "scrapling");
const worker = join("scripts", "scrapling_worker.py");

async function whichPython(): Promise<string | undefined> {
  for (const candidate of ["python", "python3"]) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(candidate, ["--version"], (error) => error ? reject(error) : resolve());
      });
      return candidate;
    } catch { continue; }
  }
  return undefined;
}

const python = await whichPython();
let scraplingAvailable = false;
if (python) {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(python, ["-c", "import scrapling"], (error) => error ? reject(error) : resolve());
    });
    scraplingAvailable = true;
  } catch { /* unavailable locally */ }
}

async function runWorker(args: string[], env?: Record<string, string>) {
  if (!python) return { code: null as number | null, stdout: "", stderr: "" };
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(python, [worker, ...args], {
      env: env ? { ...process.env, ...env } : process.env, cwd: process.cwd(), timeout: 60000,
    }, (error, stdout, stderr) => {
      if (error) resolve({ code: typeof error.code === "number" ? error.code : null, stdout: stdout ?? "", stderr: stderr ?? "" });
      else resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function jobFile(dir: string, name: string, job: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(job), "utf-8");
  return path;
}

const baseJob = {
  lead_id: "00000000-0000-4000-8000-000000000041",
  business_name: "Synthetic Plumbing",
  official_url: "https://synthetic-plumbing.example/",
  seed_urls: ["https://synthetic-plumbing.example/"],
};

const runIfPython = (name: string, fn: () => Promise<void>) =>
  python ? test(name, fn) : test.skip(name, async () => { });

const runIfScrapling = (name: string, fn: () => Promise<void>) =>
  (python && scraplingAvailable) ? test(name, fn) : test.skip(name, async () => { });

describe("scrapling worker (local Python, subprocess)", () => {
  runIfPython("disabled flag stops the worker before any network or scrapling import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scrapling-"));
    const result = await runWorker(["--plan", jobFile(dir, "job.json", baseJob)],
      { ENABLE_SCRAPLING: "false" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("SCRAPLING_DISABLED");
  });

  runIfPython("a private IP target is refused before anything is fetched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scrapling-"));
    const job = { ...baseJob, official_url: "https://127.0.0.1/", seed_urls: ["https://127.0.0.1/"] };
    const result = await runWorker(["--plan", jobFile(dir, "job.json", job)], { ENABLE_SCRAPLING: "true" });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("SSRF");
    const jobB = { ...baseJob, official_url: "https://10.0.0.9/", seed_urls: ["https://10.0.0.9/"] };
    const resultB = await runWorker(["--plan", jobFile(dir, "jobB.json", jobB)], { ENABLE_SCRAPLING: "true" });
    expect(resultB.code).toBe(4);
  });

  runIfPython("plan mode reports bounded limits without touching the network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scrapling-"));
    const result = await runWorker(["--plan", jobFile(dir, "job.json", baseJob)], { ENABLE_SCRAPLING: "true" });
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.pages).toEqual(["https://synthetic-plumbing.example/"]);
    expect(plan.delay_seconds).toBe(2);
    expect(plan.max_pages).toBe(6);
    expect(plan.robots_txt_obey).toBe(true);
  });

  runIfScrapling("from-html parses local fixtures with scrapling, no network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scrapling-"));
    const job = { ...baseJob,
      page_urls: ["https://synthetic-plumbing.example/contact", "https://synthetic-plumbing.example/about"] };
    const result = await runWorker(["--from-html", jobFile(dir, "job.json", job),
      join(fixtureDir, "contact.html"), join(fixtureDir, "about.html")], { ENABLE_SCRAPLING: "true" });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.scraper).toBe("scrapling");
    expect(report.pages).toHaveLength(2);
    expect(report.pages[0].url).toBe("https://synthetic-plumbing.example/contact");
    expect(report.pages[0].title).toBe("Contact | Synthetic Plumbing");
    expect(report.pages[0].text).toContain("+1555010001");
    expect(report.pages[1].url).toBe("https://synthetic-plumbing.example/about");
    expect(report.pages[1].title).toBe("About | Synthetic Plumbing");
    expect(report.errors).toEqual([]);
  });
});
