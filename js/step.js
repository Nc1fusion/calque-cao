// ---- Modèle à partir d'un fichier STEP (lu par occt-import-js) ----
// Produit le même format que modeles.js : { V, E, T, trous, reperes, nbAretesContour }.
function modeleDepuisMaillages(meshes, nom) {
  // 1. sommets soudés (les faces du STEP ont chacune leurs propres sommets)
  const V = [], cle = new Map(), T = [], faceDe = [];
  const souder = (x, y, z) => {
    const k = Math.round(x * 1000) + "," + Math.round(y * 1000) + "," + Math.round(z * 1000);
    let i = cle.get(k); if (i === undefined) { i = V.length; V.push([x, y, z]); cle.set(k, i); }
    return i;
  };
  let nbFaces = 0;
  for (const m of meshes) {
    const pos = m.attributes.position.array, idx = m.index.array, loc = [];
    for (let i = 0; i < pos.length; i += 3) loc.push(souder(pos[i], pos[i + 1], pos[i + 2]));
    const faceTri = new Int32Array(idx.length / 3).fill(-1);
    (m.brep_faces || []).forEach((f, j) => { for (let t = f.first; t <= f.last; t++) faceTri[t] = nbFaces + j; });
    for (let t = 0; t < idx.length / 3; t++) {
      const a = loc[idx[3 * t]], b = loc[idx[3 * t + 1]], c = loc[idx[3 * t + 2]];
      if (a === b || b === c || a === c) continue;
      T.push([a, b, c]); faceDe.push(faceTri[t] >= 0 ? faceTri[t] : nbFaces + (m.brep_faces || []).length);
    }
    nbFaces += (m.brep_faces || []).length + 1;
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const N = T.map(([a, b, c]) => { const n = cross3(sub(V[b], V[a]), sub(V[c], V[a])); const l = Math.hypot(...n); return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0]; });
  // 2. arêtes et triangles voisins
  const aretes = new Map();
  T.forEach((t, k) => { for (let i = 0; i < 3; i++) { const a = t[i], b = t[(i + 1) % 3], c = a < b ? a + "-" + b : b + "-" + a; (aretes.get(c) || aretes.set(c, []).get(c)).push(k); } });
  const vives = [];
  for (const [c, tri] of aretes) {
    const [a, b] = c.split("-").map(Number);
    if (tri.length === 1) { vives.push([a, b]); continue; }
    if (faceDe[tri[0]] === faceDe[tri[1]]) continue;
    if (dot(N[tri[0]], N[tri[1]]) < Math.cos(25 * Math.PI / 180)) vives.push([a, b]);
  }
  // 3. faces cylindriques creuses = trous
  const parFace = new Map(); T.forEach((t, k) => (parFace.get(faceDe[k]) || parFace.set(faceDe[k], []).get(faceDe[k])).push(k));
  const cylindres = [];
  for (const [f, tris] of parFace) {
    const ns = tris.map(k => N[k]);
    const m0 = ns.reduce((s, n) => [s[0] + n[0], s[1] + n[1], s[2] + n[2]], [0, 0, 0]);
    if (Math.hypot(...m0) / ns.length > 0.995) continue;                    // face plane
    // axe : direction perpendiculaire à toutes les normales (plus petite valeur propre de la covariance)
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const n of ns) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += n[i] * n[j];
    let axe = plusPetitVecteurPropre(C);
    // axe canonique : composantes arrondies, la plus grande positive (pour regrouper les trous d'une même plaque)
    const kmax = [0, 1, 2].reduce((a, b) => Math.abs(axe[b]) > Math.abs(axe[a]) ? b : a, 0);
    if (axe[kmax] < 0) axe = axe.map(v => -v);
    axe = norm3(axe.map(v => Math.abs(v) < 1e-4 ? 0 : v));
    if (ns.some(n => Math.abs(dot(n, axe)) > 0.08)) continue;              // pas un cylindre
    const pts = [...new Set(tris.flatMap(k => T[k]))];
    const u = norm3(cross3(axe, Math.abs(axe[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross3(axe, u);
    const cercle = ajusterCercle(pts.map(i => [dot(V[i], u), dot(V[i], v)]));
    if (!cercle || cercle.ecart > 0.05 * cercle.r + 0.05) continue;
    const centre2 = [0, 1, 2].map(i => cercle.cx * u[i] + cercle.cy * v[i]);
    // creux si les normales pointent vers l'axe
    const k0 = tris[0], p0 = V[T[k0][0]], radial = sub(p0, centre2), rad = sub(radial, axe.map(x => x * dot(radial, axe)));
    if (dot(N[k0], rad) > 0) continue;                                        // bossage, pas un trou
    const hs = pts.map(i => dot(V[i], axe));
    cylindres.push({ axe, r: cercle.r, centre2, hmin: Math.min(...hs), hmax: Math.max(...hs), pts: new Set(pts) });
  }
  // une même paroi de trou peut être découpée en deux faces : on regroupe
  const trousBruts = [];
  for (const c of cylindres) {
    const t = trousBruts.find(o => Math.abs(Math.abs(dot(o.axe, c.axe)) - 1) < 1e-3 && Math.abs(o.r - c.r) < 0.05 && Math.hypot(...sub(o.centre2, c.centre2)) < 0.1);
    if (t) { c.pts.forEach(p => t.pts.add(p)); t.hmin = Math.min(t.hmin, c.hmin); t.hmax = Math.max(t.hmax, c.hmax); } else trousBruts.push(c);
  }
  // 4. arêtes : contour d'abord, puis les deux rebords de chaque trou
  const surTrou = new Map();
  trousBruts.forEach((t, i) => t.pts.forEach(p => surTrou.set(p, i)));
  const E = [], rebordsDe = trousBruts.map(() => ({ haut: [], bas: [] }));
  const contour = [];
  for (const [a, b] of vives) {
    const ta = surTrou.get(a), tb = surTrou.get(b);
    if (ta !== undefined && ta === tb) {
      const t = trousBruts[ta], h = (dot(V[a], t.axe) + dot(V[b], t.axe)) / 2;
      (Math.abs(h - t.hmax) < Math.abs(h - t.hmin) ? rebordsDe[ta].haut : rebordsDe[ta].bas).push([a, b]);
    } else contour.push([a, b]);
  }
  contour.forEach(e => E.push(e));
  const nbAretesContour = E.length;
  const trous = [];
  trousBruts.forEach((t, i) => {
    const ep = t.hmax - t.hmin;
    if (ep < 0.1 || !rebordsDe[i].haut.length || !rebordsDe[i].bas.length) return;
    const c = [0, 1, 2].map(k => t.centre2[k] + t.axe[k] * (t.hmin + t.hmax) / 2);
    const rebords = [["haut", 1], ["bas", -1]].map(([cote, signe]) => {
      const debut = E.length; rebordsDe[i][cote].forEach(e => E.push(e));
      return { centre: [0, 1, 2].map(k => c[k] + signe * t.axe[k] * ep / 2), signe, aretes: Array.from({ length: E.length - debut }, (_, j) => debut + j) };
    });
    const f = x => Math.round(x);
    trous.push({ nom: `Ø${(2 * t.r).toFixed(1).replace(/\.0$/, "")} à (${f(c[0])}, ${f(c[1])}, ${f(c[2])})`, c, axe: t.axe, dia: 2 * t.r, ep, rebords });
  });
  const mn = [0, 1, 2].map(i => Math.min(...V.map(p => p[i]))), mx = [0, 1, 2].map(i => Math.max(...V.map(p => p[i])));
  const reperes = [[mn[0], mn[1], mn[2]], [mx[0], mn[1], mn[2]], [mx[0], mx[1], mn[2]], [mn[0], mx[1], mn[2]],
                   [mn[0], mn[1], mx[2]], [mx[0], mn[1], mx[2]], [mx[0], mx[1], mx[2]], [mn[0], mx[1], mx[2]]];
  return { type: "step", nom, V, E, T, trous, erreurs: [], reperes, nbAretesContour, boite: [mn, mx] };
}
function plusPetitVecteurPropre(C) {
  // itération inverse sur une matrice 3x3 symétrique (légèrement décalée pour rester inversible)
  const A = C.map((r, i) => r.map((v, j) => v + (i === j ? 1e-6 : 0)));
  let x = [0.577, 0.577, 0.577];
  for (let it = 0; it < 30; it++) {
    const y = resoudreLin(A, x); if (!y) break;
    const n = Math.hypot(...y); x = y.map(v => v / n);
  }
  return x;
}
function ajusterCercle(P) {
  // cercle au sens des moindres carrés (méthode de Kåsa)
  if (P.length < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of P) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z; }
  const n = P.length, s = resoudreLin([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], [sxz, syz, sz]);
  if (!s) return null;
  const cx = s[0] / 2, cy = s[1] / 2, r = Math.sqrt(s[2] + cx * cx + cy * cy);
  const ecart = Math.max(...P.map(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - r)));
  return { cx, cy, r, ecart };
}
if (typeof module !== "undefined") module.exports = { modeleDepuisMaillages };
