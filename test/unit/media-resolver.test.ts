import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { staticFile } from "remotion";
import { describe, expect, it } from "vitest";
import { MediaProvider, useMedia } from "../../src/media/remotion/media.js";

const Probe = ({ path }: { path: string }) => createElement("i", null, useMedia()(path));

describe("the composition's media resolver", () => {
  it("is Remotion's staticFile unless a host provides one, so renders load staged files as before", () => {
    expect(renderToStaticMarkup(createElement(Probe, { path: "fitted/scene_01.mp4" }))).toBe(
      `<i>${staticFile("fitted/scene_01.mp4")}</i>`,
    );
  });

  it("lets a host map published paths to its own URLs", () => {
    const html = renderToStaticMarkup(
      createElement(MediaProvider, { resolve: (p) => `/api/runs/r1/files/${p}`, children: createElement(Probe, { path: "narration.wav" }) }),
    );
    expect(html).toBe("<i>/api/runs/r1/files/narration.wav</i>");
  });
});
