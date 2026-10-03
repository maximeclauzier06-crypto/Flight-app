// ---------------------------------------------------------------------------
// geo.js — the world map on the globe: real countries and their borders.
//
// It uses two small free libraries loaded in index.html (d3-geo turns the
// round Earth into a picture, topojson-client unpacks the country shapes) and
// the free Natural Earth country outlines ("world-atlas"), fetched once.
// If any of that can't load (no internet...), the globe still works: you just
// get the sea, the pins and the flight paths, without the countries.
//
// app.js uses:
//   Geo.load()                 fetch the countries once (a promise)
//   Geo.fitView(points)        where to look so every point fits {lat, lon, zoom}
//   Geo.createGlobe(view, R)   everything needed to draw one frame
// ---------------------------------------------------------------------------

const Geo = (() => {
  const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
  const RAD = Math.PI / 180;
  const hasLibraries = typeof d3 !== "undefined" && typeof topojson !== "undefined";
  const graticule = hasLibraries ? d3.geoGraticule10() : null; // faint lines every 10°

  let land = null;      // all land, as one shape
  let borders = null;   // the lines between countries
  let countries = null; // one shape per country (to light up the meeting country)
  let loading = null;
  const countryCache = new Map();

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
          countries = topojson.feature(world, world.objects.countries).features;
        })
        .catch((error) => console.warn("World map unavailable, showing the globe without countries:", error.message));
    }
    return loading;
  }

  // The country a place is in (or null: tiny islands aren't in this map).
  function countryAt(lat, lon) {
    if (!countries) return null;
    const key = `${lat},${lon}`;
    if (!countryCache.has(key)) countryCache.set(key, countries.find((c) => d3.geoContains(c, [lon, lat])) ?? null);
    return countryCache.get(key);
  }

  const toVec = (lat, lon) => [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Looks at the middle of `points` ([{lat, lon}, ...]) and zooms in (up to 2x)
  // so the farthest point sits ~60% of the way to the edge.
  function fitView(points) {
    const sum = points.map((p) => toVec(p.lat, p.lon)).reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
    const len = Math.hypot(...sum) || 1;
    const c = sum.map((x) => x / len);
    const theta = Math.max(...points.map((p) => Math.acos(Math.min(1, dot3(c, toVec(p.lat, p.lon))))));
    return {
      lat: Math.asin(c[2]) / RAD,
      lon: Math.atan2(c[1], c[0]) / RAD,
      zoom: Math.min(2, Math.max(1, 0.6 / Math.max(Math.sin(theta), 0.05))),
    };
  }

  // One frame of the globe: a round window of radius windowR (pixels) onto
  // a sphere of radius windowR × zoom, looking at view.lat / view.lon.
  function createGlobe(view, windowR) {
    const sphereR = windowR * view.zoom;
    const cx = windowR + 50;
    const cy = windowR + 50;
    const p0 = view.lat * RAD;

    // lat/lon -> pixel position. `r` lets flight paths float above the ground.
    const project = (lat, lon, r = sphereR) => {
      const p = lat * RAD;
      const l = (lon - view.lon) * RAD;
      const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l);
      return {
        x: cx + r * Math.cos(p) * Math.sin(l),
        y: cy - r * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l)),
        visible: cosc > 0.02, // on the side facing us
        cosc,
      };
    };

    // On the visible side AND inside the round window.
    const inside = (q) => q.visible && Math.hypot(q.x - cx, q.y - cy) <= windowR - 4;

    // The map itself (empty strings until Geo.load() has finished).
    let landPath = "", bordersPath = "", gridPath = "";
    let countryPath = () => "";
    if (land) {
      const projection = d3.geoOrthographic()
        .rotate([-view.lon, -view.lat])
        .scale(sphereR)
        .translate([cx, cy])
        .clipExtent([[cx - windowR - 4, cy - windowR - 4], [cx + windowR + 4, cy + windowR + 4]]);
      const path = d3.geoPath(projection);
      landPath = path(land) ?? "";
      bordersPath = path(borders) ?? "";
      gridPath = path(graticule) ?? "";
      countryPath = (lat, lon) => {
        const country = countryAt(lat, lon);
        return country ? path(country) ?? "" : "";
      };
    }

    // A curved flight path between two places, lifted above the surface.
    // The parts hidden behind the Earth are left out.
    const arc = (a, b, lift = 0.14, steps = 48) => {
      const va = toVec(a.lat, a.lon);
      const vb = toVec(b.lat, b.lon);
      const th = Math.acos(Math.min(1, Math.max(-1, dot3(va, vb)))) || 0.0001;
      let d = "";
      let drawing = false;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const k1 = Math.sin((1 - t) * th) / Math.sin(th);
        const k2 = Math.sin(t * th) / Math.sin(th);
        const v = [k1 * va[0] + k2 * vb[0], k1 * va[1] + k2 * vb[1], k1 * va[2] + k2 * vb[2]];
        const q = project(Math.asin(v[2]) / RAD, Math.atan2(v[1], v[0]) / RAD, sphereR * (1 + lift * Math.sin(Math.PI * t)));
        const seen = q.cosc > 0 || Math.hypot(q.x - cx, q.y - cy) > sphereR;
        if (seen) d += (drawing ? "L" : "M") + q.x.toFixed(1) + " " + q.y.toFixed(1);
        drawing = seen;
      }
      return d;
    };

    return { cx, cy, windowR, sphereR, project, inside, arc, landPath, bordersPath, gridPath, countryPath };
  }

  return { load, fitView, createGlobe };
})();
