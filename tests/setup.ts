// Setup file: stub Deno globals before any test module is imported.
// Edge function modules call Deno.serve(handler) at module load time.
import { vi } from "vitest";

const envGetMock = vi.fn();
const serveMock = vi.fn();
vi.stubGlobal("Deno", { env: { get: envGetMock }, serve: serveMock });

export { envGetMock, serveMock };
