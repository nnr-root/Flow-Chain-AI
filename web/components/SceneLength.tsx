"use client";
import { SCENE_SECONDS, sceneBounds } from "@src/duration";
import { Segmented } from "./ui";

const CHOICES = Array.from({ length: SCENE_SECONDS.max - SCENE_SECONDS.min + 1 }, (_, i) => SCENE_SECONDS.min + i);

/**
 * How long each scene stays (phase 7 spec §13): one length for every scene, or a range the script chooses within.
 * Which of the two is said outright, so that scenes of one length are not asked for as a range from five to five.
 * The lengths are a row to press: one of them for a single length; for a range, the stretch between its two ends
 * is lit, and a press moves the end it is nearer to.
 */
export function SceneLength({ value, onChange, videoSec }: { value: { min: number; max: number }; onChange: (v: { min: number; max: number }) => void; videoSec: number }) {
  const fixed = value.min === value.max;
  const scenes = sceneBounds(videoSec, value);
  const setKind = (kind: "fixed" | "range") => {
    if (kind === "fixed") return onChange({ min: value.max, max: value.max });
    if (!fixed) return;
    // a range opens downwards from the length that was chosen, or upwards from the shortest
    onChange(value.max - 2 >= SCENE_SECONDS.min ? { min: value.max - 2, max: value.max } : { min: value.min, max: Math.min(SCENE_SECONDS.max, value.min + 2) });
  };
  const press = (sec: number) => {
    if (fixed) return onChange({ min: sec, max: sec });
    // the nearer end moves; between the two, a press on an end's own side
    if (sec <= value.min) return onChange({ min: sec, max: value.max === sec ? Math.min(SCENE_SECONDS.max, sec + 1) : value.max });
    if (sec >= value.max) return onChange({ min: value.min, max: sec });
    onChange(sec - value.min < value.max - sec ? { min: sec, max: value.max } : { min: value.min, max: sec });
  };
  return (
    <fieldset className="text-[0.95rem]" data-testid="scene-length">
      <legend className="mb-1.5 font-bold">Each scene stays</legend>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Scenes of one length, or of a range" value={fixed ? "fixed" : "range"} onChange={setKind} options={[{ value: "fixed", label: "The same length" }, { value: "range", label: "A range" }]} />
        <div role="group" aria-label={fixed ? "Length of every scene" : "Shortest and longest scene"} className="inline-flex overflow-hidden rounded-full border-[1.5px] border-ink/30 bg-sheet">
          {CHOICES.map((sec) => {
            const on = sec >= value.min && sec <= value.max;
            return (
              <button
                key={sec}
                type="button"
                aria-pressed={on}
                data-testid={`scene-sec-${sec}`}
                onClick={() => press(sec)}
                className={`min-w-[3.25rem] px-3 py-1.5 text-[0.9rem] font-bold tabular-nums ${on ? "bg-marker text-paper" : "text-graphite hover:text-ink"}`}
              >
                {sec} s
              </button>
            );
          })}
        </div>
      </div>
      <span className="mt-2 block text-[0.85rem] text-graphite" data-testid="scene-count">
        {fixed ? `Every scene about ${value.max} seconds` : `Scenes of ${value.min} to ${value.max} seconds, as the script sees fit`}
        : {scenes.min === scenes.max ? `${scenes.min} ${scenes.min === 1 ? "scene" : "scenes"}` : `${scenes.min} to ${scenes.max} scenes`} in all.
      </span>
    </fieldset>
  );
}
