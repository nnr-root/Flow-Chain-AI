// The sound vocabulary. It imports nothing because the browser reads it too, through the manifest schema.

/** The sounds the edit places by itself (at the hook and at cuts); a script never names them. */
export const EDIT_SOUNDS = ["impact", "whoosh", "pop"] as const;

/** The sounds a script may name for a scene: nine hits and five beds. */
export const SCENE_SOUNDS = [
  "footstep", "door", "knock", "glass", "beep", "clock", "heartbeat", "splash", "thunder",
  "rain", "wind", "crowd", "engine", "fire",
] as const;
export type SceneSound = (typeof SCENE_SOUNDS)[number];

/** What each sound is and when it fits, in English, for the script prompt. */
export const SCENE_SOUND_ABOUT: Record<SceneSound, string> = {
  footstep: "one footstep on a hard floor",
  door: "a door shutting or slamming, once",
  knock: "two knocks on a door",
  glass: "glass breaking or shattering, once",
  beep: "one electronic beep of a device or alarm",
  clock: "one clock tick",
  heartbeat: "two low heartbeats",
  splash: "a splash of water, once",
  thunder: "a rumble of thunder, once",
  rain: "steady rain, under the whole scene",
  wind: "wind blowing, under the whole scene",
  crowd: "the murmur of a crowd, under the whole scene",
  engine: "a steady engine hum, under the whole scene",
  fire: "a crackling fire, under the whole scene",
};
