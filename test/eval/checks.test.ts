import { describe, expect, it } from "vitest";
import { rawHashtags, speechFaults, startsFromRest, textAsked, videoPromptFaults } from "../../src/eval/checks.js";

describe("a picture prompt that asks for writing", () => {
  it("is found, naming the scene", () => {
    const found = textAsked([{ imagePrompt: "a fox in snow" }, { imagePrompt: "a banner with text above the door" }, { imagePrompt: "a ship with a logo on the sail" }]);
    expect(found.map((f) => f.where)).toEqual(["scene 2", "scene 3"]);
  });
  it("lets through a prompt that only has a word that looks like one", () => {
    expect(textAsked([{ imagePrompt: "rough bark with deep texture" }])).toEqual([]);
  });
});

describe("the hashtags as the model sent them", () => {
  const five = ["#one", "#two", "#three", "#four", "#five"];
  it("accepts five that are not generic", () => expect(rawHashtags(five)).toEqual([]));
  it("finds a wrong count", () => expect(rawHashtags(five.slice(0, 4)).map((f) => f.check)).toEqual(["hashtag-count"]));
  it("finds generic ones", () => {
    expect(rawHashtags(["#fyp", "#two", "#three", "#four", "#Viral"]).map((f) => f.detail)).toEqual(["#fyp", "#Viral"]);
  });
  it("finds none sent", () => expect(rawHashtags(undefined).map((f) => f.check)).toEqual(["hashtag-count"]));
});

describe("a continue scene that starts from rest", () => {
  const moving = { motionPrompt: "a slow push-in on the lighthouse", shot: "cut" };
  it("is found when the scene before was moving and this one holds a static camera", () => {
    const found = startsFromRest([moving, { motionPrompt: "a static camera on the keeper", shot: "continue" }]);
    expect(found.map((f) => f.where)).toEqual(["scene 2"]);
  });
  it("is not found when it carries on, or when it is a cut, or when the scene before held still too", () => {
    expect(startsFromRest([moving, { motionPrompt: "the push-in continues toward the door", shot: "continue" }])).toEqual([]);
    expect(startsFromRest([moving, { motionPrompt: "a static camera on the keeper", shot: "cut" }])).toEqual([]);
    expect(startsFromRest([{ motionPrompt: "a static camera", shot: "cut" }, { motionPrompt: "a static camera", shot: "continue" }])).toEqual([]);
  });
});

describe("a prompt for the clip model that asks for what it draws wrong", () => {
  const good = "A keeper stands still at the rail of the lighthouse gallery while the camera pushes in slowly; his hands stay on the rail and his body does not turn. Late blue dusk light. Audio: wind over the gallery, surf on rock below.";
  it("is found when it asks for a cut, a widescreen look or film, naming the scene and the word", () => {
    const found = videoPromptFaults([
      { videoPrompt: good },
      { videoPrompt: "A cinematic shot of the keeper. Audio: wind." },
      { videoPrompt: "The keeper turns, then a hard cut to the lamp room. Audio: wind." },
      { videoPrompt: "A widescreen view with black bars of the coast. Audio: surf." },
    ]);
    expect(found.map((f) => f.where)).toEqual(["scene 2", "scene 3", "scene 4", "scene 4"]);
    expect(found.map((f) => f.detail.toLowerCase())).toEqual(["cinematic", "cut to", "widescreen", "black bars"]);
  });
  it("is found when its last sentence does not begin with Audio:", () => {
    expect(videoPromptFaults([{ videoPrompt: "A keeper stands still at the rail. Wind blows." }]).map((f) => f.check)).toEqual(["video-audio"]);
  });
  it("lets through a good one, a scene with no videoPrompt, and a cut that is not a cut of the picture", () => {
    expect(videoPromptFaults([{ videoPrompt: good }, {}, { videoPrompt: "A baker cuts the bread on a board. Audio: a knife on crust." }])).toEqual([]);
  });
});

describe("the sentences people say", () => {
  const says = (speech: string, videoPrompt = `A woman looks into the camera and says "${speech}", lips moving precisely with every word. Audio: a quiet kitchen.`) => ({ speech, videoPrompt });
  it("are found when the run did not allow speech", () => {
    expect(speechFaults([says("Hello there."), { speech: "" }], false).map((f) => f.check)).toEqual(["speech-not-allowed"]);
  });
  it("are found when more than two scenes speak, or one says more than 14 words, counted by the words module", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
    expect(speechFaults([says("Hi."), says("Hi."), says("Hi.")], true).map((f) => f.check)).toEqual(["speech-scenes"]);
    expect(speechFaults([says(long)], true).map((f) => f.check)).toEqual(["speech-words"]);
    expect(speechFaults([says("あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみ")], true, "ja").map((f) => f.check)).toEqual(["speech-words"]);
  });
  it("are found when the scene's videoPrompt does not quote the sentence with its lips moving with every word", () => {
    expect(speechFaults([{ speech: "Hello there.", videoPrompt: "A woman smiles. Audio: wind." }], true).map((f) => f.check)).toEqual(["speech-unquoted"]);
  });
  it("let through up to two short quoted sentences, and scenes that say nothing", () => {
    expect(speechFaults([says("I kept the light burning for forty years."), { speech: "" }, says("And it never once went out.")], true)).toEqual([]);
    expect(speechFaults([{ speech: "" }, {}], false)).toEqual([]);
  });
});
