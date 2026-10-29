// ---- Modèles de pièces : boîte, poutre H, profilé U (mm) ----
// Repère : X = longueur, Y = largeur (avant = -Y), Z = hauteur.
// Chaque modèle = section (rectangles dans le plan YZ) extrudée sur X, plus des trous ronds.
const TYPES = {
  boite: { nom: "Boîte", dims: [["L", "Largeur", 180], ["P", "Épaisseur", 45], ["H", "Hauteur", 245]], trous: "" },
  h: { nom: "Poutre H (W)", dims: [["L", "Longueur", 600], ["d", "Hauteur d", 203], ["bf", "Largeur aile", 203], ["tw", "Épaisseur âme", 7.2], ["tf", "Épaisseur aile", 11]],
       trous: "ame 100 70 22\name 100 133 22\name 500 70 22\name 500 133 22\naile-haut 150 -55 18\naile-haut 150 55 18\naile-haut 450 -55 18\naile-haut 450 55 18\naile-bas 300 -55 18\naile-bas 300 55 18" },
  u: { nom: "Profilé U (C)", dims: [["L", "Longueur", 500], ["d", "Hauteur d", 203], ["bf", "Largeur aile", 57], ["tw", "Épaisseur âme", 5.6], ["tf", "Épaisseur aile", 9.9]],
       trous: "ame 80 60 18\name 80 143 18\name 420 60 18\name 420 143 18\naile-haut 250 32 14" },
};
const NOMS_REPERES = ["bas avant gauche", "bas avant droit", "bas arrière droit", "bas arrière gauche",
  "haut avant gauche", "haut avant droit", "haut arrière droit", "haut arrière gauche"];

function lireTrous(texte, type, D) {
  const trous = [], erreurs = [];
  (texte || "").split(/\n/).forEach((ligne, i) => {
    const l = ligne.trim().toLowerCase().replace(/,/g, "."); if (!l) return;
    const m = l.match(/^(âme|ame|aile-haut|aile-bas)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)$/);
    if (!m || type === "boite") { erreurs.push(i + 1); return; }
    const [, plaque, a, b, dia] = m, x = +a, v = +b, diam = +dia;
    if (plaque === "âme" || plaque === "ame") {
      const y = type === "h" ? 0 : D.tw / 2, ep = D.tw;
      trous.push({ nom: `âme x${x} z${v} Ø${diam}`, c: [x, y, v], axe: [0, 1, 0], dia: diam, ep });
    } else {
      const z = plaque === "aile-haut" ? D.d - D.tf / 2 : D.tf / 2;
      trous.push({ nom: `${plaque === "aile-haut" ? "aile du haut" : "aile du bas"} x${x} y${v} Ø${diam}`, c: [x, v, z], axe: [0, 0, 1], dia: diam, ep: D.tf });
    }
  });
  return { trous, erreurs };
}

function construireModele(type, D, texteTrous) {
  let rects, poly;   // rectangles [y0,y1,z0,z1] et contour de la section
  const L = D.L;
  if (type === "boite") {
    rects = [[0, D.P, 0, D.H]]; poly = [[0, 0], [D.P, 0], [D.P, D.H], [0, D.H]];
  } else if (type === "h") {
    const b = D.bf / 2, w = D.tw / 2, d = D.d, t = D.tf;
    rects = [[-b, b, 0, t], [-w, w, t, d - t], [-b, b, d - t, d]];
    poly = [[-b, 0], [b, 0], [b, t], [w, t], [w, d - t], [b, d - t], [b, d], [-b, d], [-b, d - t], [-w, d - t], [-w, t], [-b, t]];
  } else {
    const d = D.d, t = D.tf;
    rects = [[0, D.tw, 0, d], [D.tw, D.bf, 0, t], [D.tw, D.bf, d - t, d]];
    poly = [[0, 0], [D.bf, 0], [D.bf, t], [D.tw, t], [D.tw, d - t], [D.bf, d - t], [D.bf, d], [0, d]];
  }
  // pour une boîte, « avant » = Y=0 ; pour les profilés, on centre comme la section le définit
  const V = [], E = [], T = [];
  const sommet = P => { V.push(P); return V.length - 1; };
  // arêtes : longitudinales (chaque coin de la section) + contours des deux bouts
  const bout0 = poly.map(([y, z]) => sommet([0, y, z])), bout1 = poly.map(([y, z]) => sommet([L, y, z]));
  for (let k = 0; k < poly.length; k++) {
    const k2 = (k + 1) % poly.length;
    E.push([bout0[k], bout1[k]], [bout0[k], bout0[k2]], [bout1[k], bout1[k2]]);
  }
  // triangles pour le tampon de profondeur : chaque rectangle extrudé = une boîte
  for (const [y0, y1, z0, z1] of rects) {
    const c = [[0, y0, z0], [L, y0, z0], [L, y1, z0], [0, y1, z0], [0, y0, z1], [L, y0, z1], [L, y1, z1], [0, y1, z1]].map(sommet);
    const q = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
    for (const [a, b2, cc, dd] of q) T.push([c[a], c[b2], c[cc]], [c[a], c[cc], c[dd]]);
  }
  // trous : deux rebords circulaires (32 segments)
  const { trous, erreurs } = lireTrous(texteTrous, type, D);
  for (const tr of trous) {
    const a = tr.axe, u = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const v1 = norm3(cross3(a, u)), v2 = cross3(a, v1);
    tr.rebords = [];
    for (const s of [1, -1]) {
      const cc = [0, 1, 2].map(i => tr.c[i] + s * a[i] * tr.ep / 2), idx = [], aretes = [];
      for (let k = 0; k < 32; k++) {
        const th = 2 * Math.PI * k / 32, r = tr.dia / 2;
        idx.push(sommet([0, 1, 2].map(i => cc[i] + r * (Math.cos(th) * v1[i] + Math.sin(th) * v2[i]))));
      }
      for (let k = 0; k < 32; k++) { E.push([idx[k], idx[(k + 1) % 32]]); aretes.push(E.length - 1); }
      tr.rebords.push({ centre: cc, signe: s, aretes });
    }
  }
  // repères : les 8 coins de l'encombrement (existent sur les trois formes)
  const ys = poly.map(p => p[0]), zs = poly.map(p => p[1]);
  const y0 = Math.min(...ys), y1 = Math.max(...ys), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const reperes = [[0, y0, z0], [L, y0, z0], [L, y1, z0], [0, y1, z0], [0, y0, z1], [L, y0, z1], [L, y1, z1], [0, y1, z1]];
  return { type, V, E, T, trous, erreurs, reperes, nbAretesContour: poly.length * 3 };
}
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm3(a) { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; }
if (typeof module !== "undefined") module.exports = { TYPES, NOMS_REPERES, construireModele, lireTrous, norm3, cross3 };
