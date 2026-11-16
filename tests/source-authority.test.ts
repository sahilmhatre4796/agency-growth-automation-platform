import { expect, test } from "vitest";
import { sourceAuthority } from "../packages/server/source-authority.ts";

test("publisher authority groups subdomains and keeps separate businesses apart", () => {
  expect(sourceAuthority("https://www.livermoreca.gov/testers"))
    .toBe(sourceAuthority("https://police.livermoreca.gov/directory"));
  expect(sourceAuthority("https://water.livermoreca.gov/testers"))
    .toBe(sourceAuthority("https://police.livermoreca.gov/directory"));
  expect(sourceAuthority("https://a.example.co.uk/")).toBe(sourceAuthority("https://b.example.co.uk/"));
  expect(sourceAuthority("https://first.example.co.uk/")).not.toBe(sourceAuthority("https://other.test.co.uk/"));
  expect(sourceAuthority("https://city.example.gov/")).not.toBe(sourceAuthority("https://utility.test.gov/"));
});
