import { describe, expect, it } from "vitest";
import { OPENAPI_SIGNING_SECRET } from "../src/config/openapi.js";

describe("OpenAPI plugin configuration", () => {
  it("ships a valid signing secret without requiring user input", () => {
    expect(OPENAPI_SIGNING_SECRET).toMatch(/^[a-f0-9]{32}$/);
  });
});
