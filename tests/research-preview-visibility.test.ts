import { expect, test } from "vitest";
import { previewFactMatchesSource } from "../apps/web/components/business-research";

test("a saved directory excerpt remains tied to the full 251-character source", () => {
  const claim = "Livermore Municipal Water approved backflow tester directory lists Gannon Backflow at 123 Main Street, phone +1555010009, email info@example.com.".padEnd(251, " ").trimEnd().padEnd(251, ".");
  const excerpt = "Livermore Municipal Water approved backflow tester directory lists Gannon Backflow.";
  expect(claim.length).toBe(251);
  expect(previewFactMatchesSource(claim, excerpt)).toBe(true);
  expect(previewFactMatchesSource(claim.replace("Gannon Backflow", "Another Business"), excerpt)).toBe(false);
  expect(previewFactMatchesSource(claim.replace(" at 123", " near 123"), excerpt)).toBe(false);
  expect(previewFactMatchesSource(claim, "Gannon Backflow has no website.")).toBe(false);
});
