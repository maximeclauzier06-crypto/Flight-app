// ---------------------------------------------------------------------------
// geo.js — a tiny dot-matrix globe, drawn from rough land outlines (no map
// library, no images). app.js calls Geo.createGlobe(...) to draw the globe
// next to the results. The outlines are coarse on purpose: they only need to
// look right as a field of dots.
// ---------------------------------------------------------------------------

const Geo = (() => {
  // Coarse land polygons as [longitude, latitude] pairs.
  const LAND = [
    // North America (+ Central America)
    [[-168,65],[-165,69],[-156,71.3],[-141,69.7],[-125,70],[-110,68],[-95,71],[-85,69],[-80,63],[-77,62],[-70,60],[-64,60],[-61,56],[-56,52],[-60,47],[-65,45],[-67,44.5],[-70,42],[-74,40.5],[-76,37],[-76,35],[-81,31.5],[-80,27],[-80.5,25.2],[-82.5,27.5],[-83,29.8],[-88,30.3],[-90,29.2],[-94,29.5],[-97,27.5],[-97.5,22],[-96,19],[-94,18.2],[-91,19],[-90.5,21],[-87,21.5],[-87.5,18],[-88,16],[-84,15.5],[-83,11],[-81,8.8],[-79,9.5],[-77.5,8.5],[-79.5,7.2],[-82.5,8],[-85.5,10],[-87.5,13],[-92,14.5],[-96,15.8],[-100,17],[-105.5,20.5],[-106,23],[-109,26],[-112,29.5],[-114.7,31.7],[-117,32.5],[-120.5,34.5],[-122.5,37.5],[-124,40.5],[-124.5,43],[-124,46.5],[-123,48.5],[-127,51],[-130,55],[-134,58],[-140,59.8],[-148,60.5],[-152,58.5],[-158,56.5],[-163,54.8],[-158,58.5],[-162,60],[-166,62]],
    // Baffin, Victoria, Ellesmere
    [[-78,64.5],[-70,62.8],[-62,66.5],[-66,70.5],[-78,73.5],[-88,72.5],[-86,70],[-82,69]],
    [[-118,69],[-102,69],[-101,72.5],[-110,73.5],[-119,71]],
    [[-90,76],[-76,77],[-62,82],[-75,83],[-92,81]],
    // Greenland
    [[-52,64],[-44,60],[-40,65],[-22,70],[-18,76],[-18,81.5],[-30,83.5],[-55,82.5],[-68,80],[-72,77],[-58,75.5],[-55,70],[-50,67]],
    // Cuba, Hispaniola
    [[-85,22],[-80,23.2],[-74.5,20.2],[-77.5,19.8],[-81,22]],
    [[-74.5,19.8],[-69,19.5],[-68.5,18.3],[-72,18]],
    // South America
    [[-77,8.5],[-74,11],[-71,12],[-62,10.5],[-60,8.5],[-52,5],[-50,1],[-48,-1],[-44,-2.5],[-38,-3.7],[-35,-5.5],[-35,-9],[-39,-14],[-39,-18],[-41,-22],[-44,-23],[-48,-26],[-48.5,-28.5],[-52,-32],[-54,-34.5],[-57,-36.5],[-57,-38.5],[-62,-39],[-65,-41],[-64.5,-42.5],[-65.5,-45],[-67.5,-46.5],[-66,-48],[-68.5,-50.5],[-69,-52.5],[-71.5,-53.5],[-74,-52],[-75.5,-47],[-73.5,-42],[-73.5,-37],[-71.5,-31],[-70.5,-25],[-70.2,-18.5],[-76,-14],[-79,-8],[-81,-5],[-80,-2.5],[-80.5,0.5],[-78.5,2],[-77.5,5]],
    // Eurasia
    [[-9,37],[-9,43],[-2,43.6],[-1.5,46],[-4.5,48.3],[1.5,50.5],[4,52],[8,53.8],[8.5,57.2],[11,58],[11,59.2],[8,58.2],[5.5,59],[5,62],[10,64],[14,67.5],[19,70],[28,71],[40,67],[44,68.5],[60,69],[70,73],[80,73.5],[95,76],[110,77],[130,72],[142,72.5],[160,70],[170,69.5],[180,68],[180,65],[177,62],[163,60],[160,54],[156,51],[155,57.5],[143,59],[135,55],[141,52],[140,48],[135,43],[131,42.5],[129,40],[129.5,35],[126,34.5],[125,39.5],[121.5,40.5],[119,38],[122,37],[119,35],[121,32],[122,30],[120,26],[116,23],[110,21],[108,21.5],[106,18],[109,14],[109,11.5],[105,8.7],[103,10.5],[100,13.5],[100,9],[103,5],[104,1.5],[101,3],[98,8],[98,16],[94,16],[92,21],[88,22],[87,21],[80,15],[80,10],[77.5,8],[76,10],[73,17],[72.5,21],[68.5,23.5],[66,25.3],[61,25.2],[57,26],[56.5,27],[52,27.5],[50,30],[48,30],[48.5,28],[51,24.5],[52,24],[56,26.5],[56.5,24.5],[59.5,22.5],[57,19],[55,17],[52,16],[48,14],[43,12.7],[42.5,16],[39,21],[35,28],[34.5,28],[32.5,30],[34,31.2],[35,34],[36,36.5],[30,36.3],[27,37],[26.5,40],[29,41],[33,42],[41.5,41.5],[37,45],[33,46],[31,46.6],[29,45],[28.5,43.5],[27.8,42],[26,40.8],[24,40.5],[23,38.5],[21,38.5],[19.5,41.5],[18,43],[13.5,45.5],[12.5,44],[16,41.5],[18.5,40],[16,38],[15.7,40],[12,42],[10,44],[7.5,43.8],[3.5,43.2],[3,42],[0,39.5],[-0.5,38],[-2,36.7],[-5.5,36]],
    // Africa
    [[-17,21],[-16,14],[-17,12.5],[-13,8],[-8,4.5],[-2,5],[5,6],[8,4.5],[9,1],[9.5,-2],[12,-5],[13,-10],[12,-17],[14.5,-23],[15,-27],[18,-32],[19,-34.8],[23,-34],[27,-33.5],[32,-28.5],[33,-25],[35,-22],[35,-18],[40.5,-15],[39.5,-8],[39,-5],[41,-1.5],[44,1.5],[48,5],[51,11.5],[44,10.5],[43.2,12],[39,16],[37,21],[35,25],[34,28],[32.5,30],[30,31.3],[25,31.8],[20,31],[19,30],[15,32.3],[11,33.2],[10,37],[3,36.8],[-2,35.2],[-5.8,35.8],[-9.5,32],[-10,29],[-13,27.5]],
    // Madagascar
    [[44,-25],[47,-25],[50,-15],[49.5,-12],[47,-15],[44,-20]],
    // Australia
    [[114,-22],[114,-34],[118,-35],[124,-33.5],[131,-31.5],[135,-35],[138,-35],[140,-38],[146,-39],[150,-37],[153,-31],[153,-25],[146,-19],[145.5,-15],[142.5,-10.7],[141,-13],[136,-12],[132,-11.5],[129,-15],[125,-14],[122,-18]],
    // New Zealand
    [[173,-35],[178,-37.5],[175,-41.5],[173,-39]],
    [[172,-41],[174,-41.5],[171,-44.5],[168,-46.5],[166.5,-45.5]],
    // Japan
    [[131,34],[135,34],[140,35],[141.5,38.5],[142,41],[140,41],[139.5,38],[136.5,37],[133,35.5]],
    [[140,42],[143,42.5],[145,44],[142,45.5],[141,43.5]],
    [[130,31],[131.5,31.5],[131.8,33.8],[130,33.5]],
    // UK, Ireland, Iceland
    [[-5.5,50],[1.5,51],[1.7,53],[-0.5,54.5],[-2,57],[-2,58.6],[-5,58.6],[-6,56.5],[-5,55],[-3,54.8],[-3,53.4],[-4.5,52]],
    [[-10,52],[-6,52],[-6,54.5],[-8,55],[-10,54]],
    [[-24,64],[-22,63.5],[-14,64.5],[-14,66],[-20,66.5],[-24,65.5]],
    // SE Asia islands
    [[95,5.5],[98,4],[104,-2],[106,-6],[102,-4],[96,2]],
    [[109,1.5],[111,-3],[115,-4],[117,1],[119,5],[116,7],[113,3]],
    [[105,-6],[114,-8],[114,-7.5],[106,-6.3]],
    [[131,-1],[141,-2.5],[148,-6],[150,-10],[141,-9],[138,-8],[132,-4]],
    [[120,18],[122,18],[124,13],[126,7],[122,7],[120,14]],
    [[80,6],[82,7.5],[80.5,9.5],[79.8,8]],
    [[120.2,22.5],[121.8,24.8],[121.5,25.2],[120.2,23.5]],
  ];
  
  // Water inside the land polygons above.
  const HOLES = [
    // Hudson Bay
    [[-95,59.5],[-93,57],[-88,55.5],[-82.5,55],[-79.5,52.5],[-78.5,56],[-78.2,60],[-74,62.5],[-80,63.5],[-86,64.2],[-90,63.5],[-94,61]],
    // Baltic + Gulf of Bothnia
    [[10.5,54.5],[14,54.2],[19,54.5],[21,55.5],[21.5,57.5],[23.5,59],[28,59.8],[29.5,60.2],[23,60.2],[21.5,61],[21.2,63],[23.5,64.5],[25.2,65.3],[22.5,65.9],[21,64],[19,62],[17.5,60.5],[18.8,59.4],[16.5,57.5],[16.3,56],[14,55.2],[12.5,55.5],[11,55.7]],
    // Caspian Sea
    [[47,45],[53,46],[54,41],[53.5,37],[50,37],[49,40],[47.5,43]],
  ];

  const RAD = Math.PI / 180;

  // Pre-compute each polygon's bounding box so the point-in-polygon test can
  // skip most polygons instantly.
  const prep = (pts) => {
    let minX = 999, maxX = -999, minY = 999, maxY = -999;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { pts, minX, maxX, minY, maxY };
  };
  const LAND_P = LAND.map(prep);
  const HOLES_P = HOLES.map(prep);

  function inPoly(lon, lat, p) {
    if (lon < p.minX || lon > p.maxX || lat < p.minY || lat > p.maxY) return false;
    const pts = p.pts;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function isLand(lon, lat) {
    if (!LAND_P.some((p) => inPoly(lon, lat, p))) return false;
    return !HOLES_P.some((p) => inPoly(lon, lat, p));
  }

  const toVec = (lat, lon) => [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Builds a globe window of radius windowR (pixels), centred on the middle
  // of `points` ([{lat, lon}, ...]) and zoomed in when the points are close
  // together. Pass `fixed` ({lat, lon}) to centre it somewhere specific
  // without zooming.
  function createGlobe(points, windowR, fixed) {
    let phi0, lam0, sphereR = windowR;
    if (fixed) {
      phi0 = fixed.lat;
      lam0 = fixed.lon;
    } else {
      const sum = points.map((p) => toVec(p.lat, p.lon)).reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
      const len = Math.hypot(...sum) || 1;
      const c = sum.map((x) => x / len);
      phi0 = Math.asin(c[2]) / RAD;
      lam0 = Math.atan2(c[1], c[0]) / RAD;
      const theta = Math.max(...points.map((p) => Math.acos(Math.min(1, dot3(c, toVec(p.lat, p.lon))))));
      // Zoom in (up to 2x) so the farthest point sits ~60% of the way to the edge.
      sphereR = Math.min(2 * windowR, Math.max(windowR, (0.6 * windowR) / Math.max(Math.sin(theta), 0.05)));
    }
    const cx = windowR + 50;
    const cy = windowR + 50;
    const p0 = phi0 * RAD;

    // lat/lon -> pixel position on the (possibly zoomed) sphere
    const project = (lat, lon, r = sphereR) => {
      const p = lat * RAD;
      const l = (lon - lam0) * RAD;
      const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l);
      return {
        x: cx + r * Math.cos(p) * Math.sin(l),
        y: cy - r * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l)),
        visible: cosc > 0.02,
      };
    };

    // Land dots: a grid roughly 10px apart, only inside the window.
    const stepDeg = Math.min(3, Math.max(0.9, 573 / sphereR));
    const windowDeg = Math.asin(Math.min(1, windowR / sphereR)) / RAD;
    let dots = '';
    for (let lat = Math.max(-80, phi0 - windowDeg - stepDeg); lat <= Math.min(84, phi0 + windowDeg + stepDeg); lat += stepDeg) {
      const lonStep = stepDeg / Math.max(Math.cos(lat * RAD), 0.25);
      const lonRange = Math.min(180, (windowDeg + stepDeg) / Math.max(Math.cos(lat * RAD), 0.2));
      for (let lon = lam0 - lonRange; lon <= lam0 + lonRange; lon += lonStep) {
        const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
        if (!isLand(wrapped, lat)) continue;
        const q = project(lat, wrapped);
        if (q.visible && Math.hypot(q.x - cx, q.y - cy) <= windowR - 2) dots += 'M' + q.x.toFixed(1) + ' ' + q.y.toFixed(1) + 'h.01';
      }
    }

    // A curved flight path between two places, lifted above the surface.
    const arc = (a, b, lift = 0.14, steps = 48) => {
      const va = toVec(a.lat, a.lon);
      const vb = toVec(b.lat, b.lon);
      const th = Math.acos(Math.min(1, Math.max(-1, dot3(va, vb)))) || 0.0001;
      let d = '';
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const k1 = Math.sin((1 - t) * th) / Math.sin(th);
        const k2 = Math.sin(t * th) / Math.sin(th);
        const v = [k1 * va[0] + k2 * vb[0], k1 * va[1] + k2 * vb[1], k1 * va[2] + k2 * vb[2]];
        const q = project(Math.asin(v[2]) / RAD, Math.atan2(v[1], v[0]) / RAD, sphereR * (1 + lift * Math.sin(Math.PI * t)));
        d += (i === 0 ? 'M' : 'L') + q.x.toFixed(1) + ' ' + q.y.toFixed(1);
      }
      return d;
    };

    return { cx, cy, windowR, dots, project, arc };
  }

  return { createGlobe };
})();
