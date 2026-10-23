import { $ } from "./dom.js";
import { placeTable } from "./lib/table-placement.js";

const TABLE_GUTTER_PX = 24;

/**
 * Sizes and places every table in the doc that is wider than the text column,
 * per placeTable. A table's scroll box may pass under the docked comment
 * rail, whose cards float above it.
 */
export function layoutTables() {
  const wraps = $("#doc").querySelectorAll(".table-wrap");
  if (!wraps.length) return;
  const area = $(".content").getBoundingClientRect();
  const minLeft = area.left + TABLE_GUTTER_PX;
  const maxRight = area.right - TABLE_GUTTER_PX;
  for (const wrap of wraps) {
    const table = wrap.querySelector("table");
    wrap.style.width = wrap.style.marginLeft = wrap.style.paddingLeft = "";
    table.style.width = "";
    const home = wrap.getBoundingClientRect();
    const measure = (width) => {
      table.style.width = width;
      const measured = table.offsetWidth;
      table.style.width = "";
      return measured;
    };
    const natural = measure("max-content");
    if (natural <= home.width) continue;
    const reach = Math.max(0, Math.min(home.left - minLeft, maxRight - home.right));
    const { box, inset, width } = placeTable({ natural, narrowest: measure("min-content"), textWidth: home.width, reach });
    wrap.style.width = `${box}px`;
    wrap.style.marginLeft = `${-reach}px`;
    wrap.style.paddingLeft = `${inset}px`;
    table.style.width = `${width}px`;
  }
}

let queued = false;
export function scheduleTableLayout() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    layoutTables();
  });
}
