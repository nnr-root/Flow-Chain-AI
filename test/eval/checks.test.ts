import { describe, expect, it } from "vitest";
import { rawHashtags, startsFromRest, textAsked } from "../../src/eval/checks.js";

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
