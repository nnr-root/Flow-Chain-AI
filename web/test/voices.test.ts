import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeVoices, readyVoices } from "@/server/voices";
import { useStudio } from "./helpers";

describe("the voices the form offers", () => {
  const studio = useStudio();

  it("are the worker's own until a hosted voice is chosen for any of them", async () => {
    expect(readyVoices()).toEqual(["narrator-m", "narrator-f"]);
    expect(nativeVoices().tr).toEqual(["narrator-m", "narrator-f"]);
    expect(nativeVoices().pt).toEqual([]);
  });

  it("are the hosted ones chosen once there are any, each native where it has a voice of that language (phase 5 spec §11)", async () => {
    await mkdir(join(studio.root, "assets/voices"), { recursive: true });
    await writeFile(join(studio.root, "assets/voices/elevenlabs.json"), JSON.stringify({
      voices: {
        "narrator-m": { en: { id: "NarrEn00001", name: "A" }, tr: { id: "NarrTr00001", name: "B" } },
        storyteller: { en: { id: "StoryEn0001", name: "C" } },
        // a voice with no English one is not offered: a language with no voice of its own falls back to English
        calm: { tr: { id: "CalmTr00001", name: "D" } },
        // and a name that is not one of the studio's voices is never offered
        stranger: { en: { id: "Strange0001", name: "E" } },
      },
    }));
    expect(readyVoices()).toEqual(["narrator-m", "storyteller"]);
    expect(nativeVoices().en).toEqual(["narrator-m", "storyteller"]);
    expect(nativeVoices().tr).toEqual(["narrator-m"]);
    expect(nativeVoices().pt).toEqual([]);
  });
});
