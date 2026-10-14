// ---------------------------------------------------------------------------
// geo.js — the flat world map behind the page: real countries and borders.
//
// It uses two small free libraries loaded in index.html (d3-geo draws the
// round Earth flat — the "Natural Earth" projection — and topojson-client
// unpacks the country shapes), plus the free Natural Earth outlines
// ("world-atlas"), fetched once. If any of that can't load (no internet...),
// the map still works: you just get the routes and pins, without countries.
//
// A map "view" is { k, tx, ty }: k is the zoom (the projection's scale) and
// tx, ty are where longitude 0 / latitude 0 sits on the screen. Dragging the
// map changes tx, ty; zooming changes k.
//
// app.js uses:
//   Geo.load()                          fetch the countries once (a promise)
//   Geo.fitView(points, box, maxK)      the view that frames `points` inside `box`
//   Geo.createMap(view, width, height)  everything needed to draw one frame
// ---------------------------------------------------------------------------

const Geo = (() => {
  const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
  const hasLibraries = typeof d3 !== "undefined" && typeof topojson !== "undefined";
  const graticule = hasLibraries ? d3.geoGraticule10() : null; // faint lines every 10°

  let land = null;    // all land, as one shape
  let borders = null; // the lines between countries
  let loading = null;

  function load() {
    if (!loading) {
      loading = (hasLibraries ? fetch(WORLD_URL) : Promise.reject(new Error("map libraries didn't load")))
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then((world) => {
          land = topojson.feature(world, world.objects.land);
          borders = topojson.mesh(world, world.objects.countries, (a, b) => a !== b);
        })
        .catch((error) => console.warn("World map unavailable, showing the map without countries:", error.message));
    }
    return loading;
  }

  const projectionFor = ({ k, tx, ty }) => d3.geoNaturalEarth1().scale(k).translate([tx, ty]);

  // The view that frames `points` ([{lat, lon}, ...]) inside `box`
  // ([[left, top], [right, bottom]] in pixels), zooming in no further than maxK
  // (so two nearby cities don't fill the whole screen).
  function fitView(points, box, maxK) {
    if (!hasLibraries) return { k: 200, tx: (box[0][0] + box[1][0]) / 2, ty: (box[0][1] + box[1][1]) / 2 };
    const fitted = d3.geoNaturalEarth1().fitExtent(box, { type: "MultiPoint", coordinates: points.map((p) => [p.lon, p.lat]) });
    let k = fitted.scale();
    let [tx, ty] = fitted.translate();
    if (!Number.isFinite(k) || k > maxK) {
      // Zoom out around the middle of the box, so the points stay centred.
      const cx = (box[0][0] + box[1][0]) / 2;
      const cy = (box[0][1] + box[1][1]) / 2;
      const f = Number.isFinite(k) ? maxK / k : 0;
      tx = Number.isFinite(k) ? cx - (cx - tx) * f : cx;
      ty = Number.isFinite(k) ? cy - (cy - ty) * f : cy;
      k = maxK;
    }
    return { k, tx, ty };
  }

  // One frame of the map, `width` x `height` pixels.
  function createMap(view, width, height) {
    if (!hasLibraries) {
      // Without the libraries: a plain equirectangular guess, enough for the pins.
      const project = (lat, lon) => [view.tx + (lon * Math.PI / 180) * view.k, view.ty - (lat * Math.PI / 180) * view.k];
      return { project, landPath: "", bordersPath: "", gridPath: "" };
    }
    const projection = projectionFor(view).clipExtent([[-20, -20], [width + 20, height + 20]]);
    const path = d3.geoPath(projection);
    return {
      project: (lat, lon) => projection([lon, lat]) ?? [-999, -999],
      landPath: land ? path(land) ?? "" : "",
      bordersPath: borders ? path(borders) ?? "" : "",
      gridPath: path(graticule) ?? "",
    };
  }

  return { load, fitView, createMap };
})();
