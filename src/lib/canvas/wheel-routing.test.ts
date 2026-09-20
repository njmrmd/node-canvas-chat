import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeWheelEvent } from "./wheel-routing";

const OVERFLOWING_MID = { scrollTop: 50, scrollHeight: 400, clientHeight: 200 };
const AT_BOTTOM = { scrollTop: 200, scrollHeight: 400, clientHeight: 200 };
const AT_TOP = { scrollTop: 0, scrollHeight: 400, clientHeight: 200 };
const NOT_OVERFLOWING = { scrollTop: 0, scrollHeight: 180, clientHeight: 200 };

describe("routeWheelEvent", () => {
  it("scrolls the card when the body can move further in the wheel's direction", () => {
    const routing = routeWheelEvent({
      ctrlKey: false,
      metaKey: false,
      deltaY: 10, // scrolling down
      cardBody: OVERFLOWING_MID,
    });
    assert.equal(routing, "card-scroll");
  });

  it("scrolls the card when scrolling up from the middle", () => {
    const routing = routeWheelEvent({
      ctrlKey: false,
      metaKey: false,
      deltaY: -10,
      cardBody: OVERFLOWING_MID,
    });
    assert.equal(routing, "card-scroll");
  });

  it("falls through to the canvas once the card is at its scroll-down limit", () => {
    const routing = routeWheelEvent({
      ctrlKey: false,
      metaKey: false,
      deltaY: 10,
      cardBody: AT_BOTTOM,
    });
    assert.equal(routing, "canvas");
  });

  it("falls through to the canvas once the card is at its scroll-up limit", () => {
    const routing = routeWheelEvent({
      ctrlKey: false,
      metaKey: false,
      deltaY: -10,
      cardBody: AT_TOP,
    });
    assert.equal(routing, "canvas");
  });

  it("falls through to the canvas over a card body that doesn't overflow at all", () => {
    const routing = routeWheelEvent({
      ctrlKey: false,
      metaKey: false,
      deltaY: 10,
      cardBody: NOT_OVERFLOWING,
    });
    assert.equal(routing, "canvas");
  });

  it("falls through to the canvas when the pointer isn't over any card body", () => {
    const routing = routeWheelEvent({ ctrlKey: false, metaKey: false, deltaY: 10, cardBody: null });
    assert.equal(routing, "canvas");
  });

  it("always zooms the canvas on ctrl+wheel, even over a scrollable card", () => {
    const routing = routeWheelEvent({
      ctrlKey: true,
      metaKey: false,
      deltaY: 10,
      cardBody: OVERFLOWING_MID,
    });
    assert.equal(routing, "canvas");
  });

  it("always zooms the canvas on cmd+wheel (pinch-zoom), even over a scrollable card", () => {
    const routing = routeWheelEvent({
      ctrlKey: false,
      metaKey: true,
      deltaY: -10,
      cardBody: OVERFLOWING_MID,
    });
    assert.equal(routing, "canvas");
  });
});
