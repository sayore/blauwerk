import { describe, expect, test } from "bun:test";
import { failureScenarios, scenarioCoverage } from "../src/scenarios";

describe("failure scenario registry", () => {
  test("covers every catalogued scenario with a provisional playbook", () => {
    const coverage = scenarioCoverage();
    expect(coverage).toMatchObject({
      total: 108,
      guidance: 108,
      handled: 30,
      partial: 25,
      planned: 50,
      manual: 3,
    });
    expect(new Set(failureScenarios.map(scenario => scenario.id)).size).toBe(108);
    expect(failureScenarios.every(scenario => scenario.observe && scenario.guidance && scenario.verify)).toBeTrue();
  });
});
