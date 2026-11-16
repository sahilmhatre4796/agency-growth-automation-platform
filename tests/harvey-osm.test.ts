import { describe, expect, test, vi } from "vitest";
import { buildHarveyOsmQuery, HarveyOsmCollector } from "../packages/server/harvey-osm.ts";

describe("optional Harvey-derived OSM listing collector", () => {
  test("bounded approved tags and coordinates cannot become arbitrary Overpass queries", () => {
    expect(buildHarveyOsmQuery({ category: "dentist", latitude: 18.52, longitude: 73.85, radiusKm: 5, limit: 3 }))
      .toContain("node[amenity=dentist](around:5000,18.52,73.85)");
    expect(() => buildHarveyOsmQuery({ category: "dentist", latitude: 91, longitude: 73.85, radiusKm: 5, limit: 3 })).toThrow("INVALID_OSM_TARGET");
    expect(() => buildHarveyOsmQuery({ category: "dentist", latitude: 18.52, longitude: 73.85, radiusKm: 25, limit: 3 })).toThrow("INVALID_OSM_TARGET");
  });
  test("mock OSM listings preserve provenance and unconfirmed website tags", async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("[timeout:15]");
      return Response.json({ elements: [
        { type: "node", id: 12, tags: { name: "Cedar Dental", website: "https://cedar.example.org/" } },
        { type: "way", id: 19, tags: { name: "Pine Dental", website: "http://unsafe.example.org" } },
        { type: "node", id: 20, tags: { name: "Unnamed Dental" } },
      ] });
    });
    const found = await new HarveyOsmCollector(transport).collect({ category: "dentist", latitude: 18.52, longitude: 73.85, radiusKm: 5, limit: 3 });
    expect(found).toHaveLength(3);
    expect(found[0]).toMatchObject({ provider_record_id: "osm:node/12", source_url: "https://www.openstreetmap.org/node/12", proposed_website_url: "https://cedar.example.org/" });
    expect(found[1].proposed_website_url).toBeNull();
    expect(found[2].proposed_website_url).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test("throttled OSM requests fail visibly, not as an empty market", async () => {
    const throttled = vi.fn<typeof fetch>(async () => new Response("", { status: 429 }));
    await expect(new HarveyOsmCollector(throttled).collect({
      category: "plumber", latitude: 18.52, longitude: 73.85, radiusKm: 3, limit: 2,
    })).rejects.toThrow("OSM_RATE_LIMITED");
    expect(throttled).toHaveBeenCalledTimes(1);
  });
  test("a server outage makes no repeat request to another host", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response("", { status: 502 }));
    await expect(new HarveyOsmCollector(transport).collect({
      category: "plumber", latitude: 18.52, longitude: 73.85, radiusKm: 3, limit: 2,
    })).rejects.toThrow("OSM_UNAVAILABLE");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe("https://overpass.private.coffee/api/interpreter");
  });
});
