import { describe, expect, test } from "bun:test";
import { AudioManager } from "../src/audio";

// Subclass to mock pactl JSON responses
class MockAudioManager extends AudioManager {
  constructor(
    private mockCards: any[],
    private mockSinks: any[]
  ) {
    super();
  }
  
  protected override async pactlJson(kind: "cards" | "sinks") {
    return {
      data: kind === "cards" ? this.mockCards : this.mockSinks,
    };
  }
}

describe("audio identity", () => {
  test("normalizes a Bluetooth MAC to the bluez object suffix", () => {
    expect("AC:B1:EE:71:A1:51".replaceAll(":", "_").toLowerCase()).toBe("ac_b1_ee_71_a1_51");
  });
});

describe("AudioManager", () => {
  test("correctly parses card and sink state from pactl details", async () => {
    const mockCards = [
      {
        name: "bluez_card.ac_b1_ee_71_a1_51",
        active_profile: "a2dp-sink",
        profiles: [
          { name: "off", available: "yes" },
          { name: "a2dp-sink", available: "yes" }
        ]
      }
    ];
    const mockSinks = [
      {
        name: "bluez_output.ac_b1_ee_71_a1_51.a2dp-sink",
        active_profile: "a2dp-sink"
      }
    ];

    const manager = new MockAudioManager(mockCards, mockSinks);
    const state = await manager.state("AC:B1:EE:71:A1:51");
    expect(state.cardFound).toBeTrue();
    expect(state.sinkFound).toBeTrue();
    expect(state.cardName).toBe("bluez_card.ac_b1_ee_71_a1_51");
    expect(state.sinkName).toBe("bluez_output.ac_b1_ee_71_a1_51.a2dp-sink");
    expect(state.activeProfile).toBe("a2dp-sink");
    expect(state.availableProfiles).toEqual(["off", "a2dp-sink"]);
  });
});
